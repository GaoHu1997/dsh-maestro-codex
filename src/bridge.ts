/**
 * The dsh skills bridge: hands dsh's own skills to dispatched CLI runs through
 * one extra stdio MCP server (`dsh_bridge`, see `bridge-shim.ts`). The shim
 * calls back into this plugin's HTTP routes with a per-run token; the routes
 * below resolve skills through dsh's `ctx.skills` registry — the same source
 * the main session's skill catalog serves from, so a CLI child sees what dsh
 * sees and there is no second skill configuration.
 *
 * The two-step shape mirrors dsh's own skill consumer (`dsh-tool-skill`): the
 * dispatch prepends a name+description catalog into the task text, and the
 * model loads the full body on demand via the shim's `skill_<name>` tools.
 */

import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, win32 } from 'node:path'
import { prepareScopedToolArguments, SCOPED_FS_TOOLS } from './bridge-scoped.js'
export { SCOPED_FS_TOOLS, scopedPathViolation } from './bridge-scoped.js'
import type { ToolExec } from './tool.js'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { EffectiveConfig } from './config.js'
import type { DshMcpServer } from './mcp.js'
import { awaitWithin, DeadlineError } from './deadline.js'

/** The MCP server name the bridge registers under for both CLIs. */
export const BRIDGE_SERVER_NAME = 'dsh_bridge'

/** Env keys the bridge entry carries to the shim. */
export const BRIDGE_URL_ENV = 'MAESTRO_BRIDGE_URL'
export const BRIDGE_TOKEN_ENV = 'MAESTRO_BRIDGE_TOKEN'

/** The plugin's own version is stamped into the shim's serverInfo at build wiring time. */
export const BRIDGE_SERVER_VERSION = '0.1.0'

/** One dsh skill as the bridge exposes it to a CLI child. */
export interface BridgeSkillSummary {
  readonly name: string
  readonly description: string
  readonly whenToUse: string | undefined
  /** The model-facing tool name on `dsh_bridge` (`skill_<name>`). */
  readonly tool: string
}

/** The catalog one token may load: the shim's `tools/list` payload. */
export interface BridgeCatalog {
  readonly serverName: typeof BRIDGE_SERVER_NAME
  readonly skills: readonly BridgeSkillSummary[]
  readonly tools: readonly BridgeToolSchema[]
}

/** One host tool as the shim exposes it (dsh's lossless JSON schema passed through). */
export interface BridgeToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

/**
 * The slice of dsh's `ctx.tools` registry the bridge reads. Structural on
 * purpose: the registry types live in `@deepseek-ai/dsh-tools`, which this
 * plugin does not depend on.
 */
/** One call inside a host batch; `arguments` is the parsed tool input. */
export interface HostToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

/**
 * The registry's ONLY settlement input. `ctx.tools.execute` forwards to
 * `executeToolBatch`, which destructures `input.calls` and answers
 * `{ results: [{ callId, result }] }`; a single call rides as a one-element
 * batch — that is the host's own documented form ("Use executeToolBatch for
 * complete calls, including a single-call batch"). Passing a lone call object
 * instead makes `calls` undefined and the registry throws before any tool body
 * runs, which surfaced as an opaque 500 on every bridged call.
 */
export interface HostToolBatch {
  readonly calls: readonly HostToolCall[]
  readonly signal: AbortSignal
  readonly agent: NonNullable<ToolExec['agent']>
  readonly rootCallId?: string | undefined
  readonly parent?: symbol | undefined
}

/** Settlement shapes the registry has been observed to answer with. */
export type HostToolContract = 'batch' | 'single' | 'unknown'

/** The slice of dsh's `ctx.tools` registry the bridge reads. */
export interface ToolsFace {
  /** The viewing scope is the actual calling agent; omitted means global view. */
  schemas(scope?: ToolExec['agent']): Array<{ name: string; description?: string; parameters?: unknown }>
  /** Full host pipeline. cwd is deliberately absent: tools resolve the real agent's Session. */
  execute(batch: HostToolBatch): Promise<unknown>
}

/**
 * Project one settlement back onto our call id.
 *
 * `batch` is the live registry shape. `single` is accepted because hosts and
 * in-process fakes have answered with one bare `{ content, isError }` result;
 * accepting it keeps a host upgrade from breaking the bridge, while the
 * recorded contract tells diagnostics which shape the live host really used.
 * Anything else is `unknown` — never silently treated as an empty success.
 */
export function hostToolOutcomeOf(raw: unknown, callId: string): { contract: HostToolContract; result: unknown } {
  if (typeof raw !== 'object' || raw === null) return { contract: 'unknown', result: undefined }
  const record = raw as Record<string, unknown>
  const entries = Array.isArray(record['results']) ? record['results'] : undefined
  if (entries !== undefined) {
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const slot = entry as Record<string, unknown>
      if (slot['callId'] === callId) return { contract: 'batch', result: slot['result'] }
    }
    return { contract: 'batch', result: undefined }
  }
  if (Array.isArray(record['content']) || record['isError'] === true) return { contract: 'single', result: raw }
  return { contract: 'unknown', result: undefined }
}

/** Generic built-ins carry no tool semantics; their message is untrusted text. */
const GENERIC_ERROR_NAMES: ReadonlySet<string> = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError'])

/**
 * Split one thrown host exception into what the child may see and what only the
 * log may see.
 *
 * A classified tool error (a named class such as the web provider's `WebError`)
 * is the host tool's own public contract, so its message goes back to the child
 * — that is what lets a subagent recover instead of retrying blind. A generic
 * `Error`/`TypeError` may embed anything (the security boundary test feeds it a
 * credential), so the child gets the type only while the log keeps the full
 * text. Withholding everything, as the bridge used to, turned one deterministic
 * contract bug into dozens of indistinguishable failures.
 */
export function describeHostToolError(error: unknown): { summary: string; detail: string } {
  const name = error instanceof Error && error.name !== '' ? error.name : typeof error
  const raw = error instanceof Error ? error.message : String(error)
  const detail = `${name}: ${clip(raw)}`
  if (GENERIC_ERROR_NAMES.has(name)) return { summary: `${name}（完整异常已写入宿主日志）`, detail }
  return { summary: detail, detail }
}

/** One line, no control characters, bounded so it cannot flood a transcript. */
function clip(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > 400 ? `${flat.slice(0, 400)}…` : flat
}

/**
 * Tools that must not ride the bridge in `auto` mode. Shell/fs/edit tools: the
 * CLI child has its own, and custom delegation would otherwise widen the
 * expected CLI permission surface. Session/UI/orchestration tools need a
 * deliberate custom allowlist; calls always keep the owning host agent and guards.
 */
const BRIDGE_TOOL_DENYLIST: readonly string[] = [
  'bash', 'pwsh', 'read', 'write', 'edit', 'multiedit', 'notebookedit', 'notebook_edit',
  'str_replace_editor', 'str_replace_based_edit_tool', 'ls', 'glob', 'grep',
  'ask_user', 'present', 'todo', 'todowrite', 'skill', 'workflow', 'goal', 'terminal', 'jobs', 'schedule',
  'subagent', 'subagent_fork', 'task', 'agent', 'working_directory',
  'dispatch_cli_task', 'maestro_dispatch_task',
  'ask_user_question', 'todo_write', 'send_message', 'interrupt_agent', 'list_agents',
  'create_goal', 'get_goal', 'update_goal', 'unlag_refresh',
  'acp_status', 'acp_cache', 'compress', 'decompress', 'search_context',
  'git_network', 'git_credentials', 'load_workspace_dependencies',
]

/**
 * Whether a host tool may ride the bridge. `auto` mode: denylist + never MCP
 * tools (stdio ones ride the raw passthrough; http ones can be allowlisted in
 * custom mode, which is the only way they reach a child). `scoped` mode: the
 * fixed file-tool allowlist above, every call confined to the run cwd.
 * `run_code` is the registry's reserved PTC transport and never bridges.
 */
export function toolBridgable(name: string, mode: 'auto' | 'custom' | 'scoped'): boolean {
  if (name === '' || name === 'run_code') return false
  if (mode === 'custom') return true
  if (mode === 'scoped') return SCOPED_FS_TOOLS.includes(name)
  if (name.startsWith('mcp__') || /^(?:ops_|job_|schedule_)/.test(name)) return false
  return !BRIDGE_TOOL_DENYLIST.includes(name)
}

/** The one place catalog and call-time checks agree on what a mode exposes. */
export function toolBridgableIn(name: string, mode: string, allowlist: readonly string[]): boolean {
  if (mode === 'off') return false
  if (mode === 'scoped') return toolBridgable(name, 'scoped')
  if (mode === 'custom') return toolBridgable(name, 'custom') && allowlist.includes(name)
  return toolBridgable(name, 'auto')
}

/** Context budget guard: the child's context must not drown in tool schemas. */
export const MAX_BRIDGE_TOOLS = 40

/** Project one raw tool outcome; undefined = not shaped like a result. */
function toolOutcomeOf(raw: unknown): { text: string; isError: boolean; error: string | undefined } {
  if (typeof raw !== 'object' || raw === null) return { text: '', isError: true, error: '宿主工具返回了不可识别的结果' }
  const record = raw as Record<string, unknown>
  const content = Array.isArray(record['content']) ? record['content'] : []
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const kind = (block as Record<string, unknown>)['type']
    const text = (block as Record<string, unknown>)['text']
    if (kind === 'text' && typeof text === 'string') parts.push(text)
    else if (kind === 'image') parts.push('[图片输出：宿主已渲染，CLI 子代理无法显示]')
  }
  const error = typeof (record['error'] as Record<string, unknown> | undefined)?.['message'] === 'string'
    ? (record['error'] as Record<string, unknown>)['message'] as string
    : undefined
  const isError = record['isError'] === true
  return { text: parts.join('\n'), isError, error }
}

/**
 * The slice of dsh's `ctx.skills` registry the bridge reads. Structural on
 * purpose: the host types live in `@deepseek-ai/dsh-skill`, which this plugin
 * does not depend on — the registry arrives via a cordis inject and is narrowed
 * defensively below.
 */
export interface SkillsFace {
  list(options?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>
  get(name: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>
}

/** Project one raw registry summary; undefined = not shaped like a skill. */
function skillSummaryOf(raw: unknown): BridgeSkillSummary | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const name = record['name']
  const description = record['description']
  if (typeof name !== 'string' || name === '' || typeof description !== 'string') return undefined
  // Mirror dsh's own model-facing filter: `disable-model-invocation` skills
  // never reach the model catalog, so they must not reach the CLI child either.
  const invocation = record['invocation']
  const modelInvocable = (typeof invocation === 'object' && invocation !== null
    ? (invocation as Record<string, unknown>)['modelInvocable']
    : true) !== false
  if (!modelInvocable) return undefined
  const whenToUse = typeof record['whenToUse'] === 'string' ? record['whenToUse'] : undefined
  return { name, description, whenToUse, tool: skillToolName(name) }
}

/** Project one raw registry definition down to what the model should receive. */
function skillContentOf(raw: unknown): { name: string; content: string; resourceHint: string | undefined } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const name = record['name']
  const content = record['content']
  if (typeof name !== 'string' || typeof content !== 'string') return undefined
  const base = record['resourceBase']
  let resourceHint: string | undefined
  if (typeof base === 'object' && base !== null && (base as Record<string, unknown>)['kind'] === 'directory') {
    const path = (base as Record<string, unknown>)['path']
    if (typeof path === 'string') {
      resourceHint = `技能资源根目录：${path}。技能正文里提到的相对路径先按该目录解析，需要时再读取。`
    }
  }
  return { name, content, resourceHint }
}

/**
 * The model-facing tool name of one skill on `dsh_bridge`. MCP tool names cap
 * at 64 chars: overlong dsh names are truncated and disambiguated with a short
 * content hash so two long names cannot collide silently.
 */
export function skillToolName(name: string): string {
  const prefixed = `skill_${name}`
  if (/^[A-Za-z0-9_-]+$/.test(prefixed) && prefixed.length <= 64) return prefixed
  const safe = prefixed.replace(/[^A-Za-z0-9_-]/g, '_')
  return `${safe.slice(0, 47)}_${createHash('sha256').update(name).digest('hex').slice(0, 16)}`
}

/** Trusted dispatch context, never populated from bridge HTTP request data. */
export interface BridgeRunContext {
  readonly agent?: ToolExec['agent']
  /** Host-minted parent execution token. Only the registered tool seam can supply it. */
  readonly parent?: symbol | undefined
  readonly callId?: string | undefined
  readonly rootCallId?: string | undefined
  readonly sessionId?: string | undefined
  readonly cwd?: string | undefined
  readonly signal?: AbortSignal | undefined
}

type BridgeToolPolicy = Pick<EffectiveConfig, 'bridgeTools' | 'bridgeToolAllowlist'>
class BridgeToolAdmissionError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/** Per-run bridge state one token stands for. */
interface BridgeRun {
  readonly includeSkills: boolean
  readonly includeTools: boolean
  /** Issuance is the maximum authority; live configuration may only narrow it. */
  readonly toolPolicy: BridgeToolPolicy | undefined
  /** Once scoped, this token cannot later lose its task-directory boundary. */
  scoped: boolean
  readonly context: BridgeRunContext
  readonly controller: AbortController
  readonly detach: () => void
  /** First catalog fixes each name's meaning for this token's entire lifetime. */
  catalog?: BridgeCatalog | undefined
}

/** Token registry: revocation also cancels every in-flight host operation. */
export class BridgeState {
  private readonly runs = new Map<string, BridgeRun>()
  /**
   * The settlement shape the live host answered with on the last bridged call.
   * 'unseen' = no call yet. `/models` diagnostics show it so a host upgrade that
   * changes the contract is visible instead of arriving as opaque tool failures.
   */
  lastHostToolContract: HostToolContract | 'unseen' = 'unseen'

  /** Record one observed settlement shape (last write wins). */
  observeHostToolContract(contract: HostToolContract): void {
    this.lastHostToolContract = contract
  }

  issue(includeSkills = true, includeTools = false, context: BridgeRunContext = {}, policy?: BridgeToolPolicy): string {
    const token = `mb-${randomUUID()}`
    const controller = new AbortController()
    const abort = (): void => this.revoke(token)
    const detach = (): void => context.signal?.removeEventListener('abort', abort)
    const toolPolicy = policy === undefined ? undefined : { bridgeTools: policy.bridgeTools, bridgeToolAllowlist: [...policy.bridgeToolAllowlist] }
    this.runs.set(token, { includeSkills, includeTools, toolPolicy, scoped: policy?.bridgeTools === 'scoped', context: { ...context }, controller, detach })
    if (context.signal?.aborted === true) this.revoke(token)
    else context.signal?.addEventListener('abort', abort, { once: true })
    return token
  }

  revoke(token: string): void {
    const run = this.runs.get(token)
    this.runs.delete(token)
    run?.detach()
    run?.controller.abort(new Error('bridge token 已撤销'))
  }

  resolve(token: string): BridgeRun | undefined {
    return this.runs.get(token)
  }
}

/** What the dispatch and the bridge routes both need from one handle. */
export interface BridgeHandle {
  /**
   * Model-invocable skill summaries for one cwd ([] when the bridge is off,
   * the host lacks the skills service, or discovery fails — best effort).
   */
  skillsFor(cwd: string | undefined, signal?: AbortSignal, token?: string): Promise<BridgeSkillSummary[]>
  /**
   * Mint the per-run token and the MCP server entry that carries it to the CLI
   * child. undefined = the bridge is off, the host has no HTTP surface, or
   * nothing would be served. `overrides.skills === false` narrows the run to
   * tools only (the claude native-skills path, which stages files instead).
   */
  runServerEntry(overrides?: { skills?: boolean }, context?: BridgeRunContext): { entry: DshMcpServer; token: string } | undefined
  /** Retire a per-run token (the dispatch calls this when the run settles). */
  revoke(token: string): void
  /** GET bridge/catalog: what one token may expose. */
  catalog(token: string, cwd: string | undefined): Promise<BridgeCatalog | { error: string; status: number }>
  /** POST bridge/call: load one skill body for the model. */
  loadSkill(token: string, name: string, cwd: string | undefined, signal?: AbortSignal):
    Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }>
  /** POST bridge/call: execute one allowlisted host tool for the model. */
  callTool(token: string, name: string, args: Record<string, unknown> | undefined):
    Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }>
  /**
   * Stage dsh skills as a native claude skills directory
   * (`<dir>/.claude/skills/<name>/SKILL.md`, frontmatter rewritten for claude).
   * Pure filesystem — no HTTP surface needed. undefined = nothing stageable.
   */
  stageNativeSkills(cwd: string | undefined, signal?: AbortSignal): Promise<NativeSkillsStaging | undefined>
  /** Remove one staging tree (the dispatch calls this when the run settles). */
  discardStagedSkills(dir: string): Promise<void>
  /** /models diagnostics: what the bridge would serve right now. */
  diagnose(cwd?: string): Promise<{
    skillsEnabled: boolean
    toolsMode: 'off' | 'auto' | 'scoped' | 'custom'
    skills: number
    tools: number
    httpReady: boolean
    /** Settlement shape the live host answered with last ('unseen' before any call). */
    hostToolContract: HostToolContract | 'unseen'
  }>
}

/** One successful native staging pass. */
export interface NativeSkillsStaging {
  /** The directory to hand to claude via `--add-dir`. */
  readonly dir: string
  readonly count: number
}

/**
 * Host-service budgets for the bridge. Discovery and skill bodies are reads
 * that must answer quickly; a bridged host tool may legitimately run for
 * minutes and gets its own, larger bound. All of them exist so a registry that
 * ignores its AbortSignal cannot pin the HTTP route — and the dispatch waiting
 * on that route before it spawns a CLI — forever.
 */
export const BRIDGE_DISCOVERY_TIMEOUT_MS = 20_000
export const BRIDGE_SKILL_TIMEOUT_MS = 20_000
export const BRIDGE_TOOL_TIMEOUT_MS = 10 * 60_000
export const BRIDGE_CLEANUP_TIMEOUT_MS = 30_000

/** Overrides for the budgets above (tests use small values). */
export interface BridgeLimits {
  readonly discoveryMs?: number | undefined
  readonly skillMs?: number | undefined
  readonly toolMs?: number | undefined
  readonly cleanupMs?: number | undefined
}

export interface BridgeHandleParts {
  /** Lazy read of the skills service — it arrives with a deferred inject. */
  skills: () => SkillsFace | undefined
  /** Lazy read of the tools registry — same deferred-inject story. */
  tools: () => ToolsFace | undefined
  /** The host webServer's listening port; 0 = no HTTP surface to call back to. */
  portOf: () => number
  readConfig: () => Pick<EffectiveConfig, 'bridgeSkills' | 'bridgeTools' | 'bridgeToolAllowlist'>
  /** Where the compiled shim lives; defaults to the sibling of this module. */
  shimPath?: () => string | undefined
  state?: BridgeState | undefined
  logger?: { warn(message: string): void } | undefined
  /** Bounded host awaits; production uses the exported defaults. */
  limits?: BridgeLimits | undefined
}

/** Build the plugin's bridge handle (one per apply; tests build their own). */
export function createBridgeHandle(parts: BridgeHandleParts): BridgeHandle {
  const state = parts.state ?? new BridgeState()
  const limits = {
    discoveryMs: parts.limits?.discoveryMs ?? BRIDGE_DISCOVERY_TIMEOUT_MS,
    skillMs: parts.limits?.skillMs ?? BRIDGE_SKILL_TIMEOUT_MS,
    toolMs: parts.limits?.toolMs ?? BRIDGE_TOOL_TIMEOUT_MS,
    cleanupMs: parts.limits?.cleanupMs ?? BRIDGE_CLEANUP_TIMEOUT_MS,
  }
  const within = <T>(label: string, timeoutMs: number, work: () => Promise<T>, signal?: AbortSignal): Promise<T> =>
    awaitWithin(work, { ...(signal === undefined ? {} : { signal }), timeoutMs, label })
  const skillsActive = (): boolean => parts.readConfig().bridgeSkills !== false && parts.skills() !== undefined
  const toolsActive = (): boolean => {
    const face = parts.tools()
    return parts.readConfig().bridgeTools !== 'off' && face !== undefined
      && typeof face.schemas === 'function' && typeof face.execute === 'function'
  }
  // The trusted in-process seam supplies the exact Agent object. No HTTP/JSON identity
  // can substitute for it; a supplied owner id must also agree with that object.
  const agentMatches = (context: BridgeRunContext): boolean => context.agent !== undefined
    && (context.sessionId === undefined || context.agent.id === context.sessionId)
  const pickTools = (context: BridgeRunContext = {}): BridgeToolSchema[] => {
    const config = parts.readConfig()
    const face = parts.tools()
    if (!toolsActive() || face === undefined || !agentMatches(context)) return []
    let schemas: Array<{ name: string; description?: string; parameters?: unknown }>
    try { schemas = face.schemas(context.agent) } catch (error) {
      parts.logger?.warn('dsh-maestro-codex: tool schema discovery failed (exception details omitted)')
      return []
    }
    const picked = schemas.filter(tool => typeof tool?.name === 'string'
      && toolBridgableIn(tool.name, config.bridgeTools, config.bridgeToolAllowlist))
      .sort((left, right) => left.name.localeCompare(right.name))
    if (picked.length > MAX_BRIDGE_TOOLS) parts.logger?.warn(`dsh-maestro-codex: 工具目录上限 ${MAX_BRIDGE_TOOLS}，已省略 ${picked.length - MAX_BRIDGE_TOOLS} 项；请缩小桥接名单`)
    return [...new Map(picked.map(tool => [tool.name, tool])).values()].slice(0, MAX_BRIDGE_TOOLS).map(tool => ({
      name: tool.name, description: typeof tool.description === 'string' ? tool.description : '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    }))
  }
  const listSkills = async (cwd: string | undefined, signal?: AbortSignal): Promise<BridgeSkillSummary[]> => {
    try {
      signal?.throwIfAborted()
      const face = parts.skills()
      const raw = await within('技能目录发现', limits.discoveryMs,
        async () => await face?.list({ ...(cwd === undefined ? {} : { cwd }), ...(signal === undefined ? {} : { signal }) }), signal)
      signal?.throwIfAborted()
      if (!Array.isArray(raw)) return []
      return [...new Map(raw.map(skillSummaryOf).filter((skill): skill is BridgeSkillSummary => skill !== undefined).map(skill => [skill.name, skill])).values()]
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    } catch (error) {
      signal?.throwIfAborted()
      parts.logger?.warn(error instanceof DeadlineError
        ? `dsh-maestro-codex: 技能目录发现在 ${String(Math.round(limits.discoveryMs / 1000))} 秒内没有返回，已按空目录继续`
        : 'dsh-maestro-codex: skill discovery failed (exception details omitted)')
      return []
    }
  }
  const toolsFor = async (token: string): Promise<BridgeToolSchema[] | { error: string; status: number }> => {
    const run = state.resolve(token)
    if (run === undefined) return { error: 'bridge token 无效或已过期', status: 401 }
    if (!run.includeTools) return []
    if (!agentMatches(run.context)) return { error: '宿主工具桥接缺少可信执行 agent 或归属不一致，不能绕过宿主 guard', status: 403 }
    if (parts.readConfig().bridgeTools === 'scoped') run.scoped = true
    const tools = pickTools(run.context).filter(tool => run.toolPolicy === undefined
      || toolBridgableIn(tool.name, run.toolPolicy.bridgeTools, run.toolPolicy.bridgeToolAllowlist))
    return state.resolve(token) === run ? tools : { error: 'bridge token 无效或已过期', status: 401 }
  }
  const boundCwd = (run: BridgeRun, supplied: string | undefined): string | undefined => run.context.cwd ?? supplied
  const cwdMatches = (run: BridgeRun, supplied: string | undefined): boolean =>
    supplied === undefined || run.context.cwd === undefined || resolve(supplied) === resolve(run.context.cwd)
  return {
    async skillsFor(cwd, signal, token) {
      signal?.throwIfAborted()
      if (!skillsActive() || parts.portOf() <= 0) return []
      if (token !== undefined) {
        const catalog = await this.catalog(token, cwd)
        signal?.throwIfAborted()
        return 'error' in catalog ? [] : [...catalog.skills]
      }
      return await listSkills(cwd, signal)
    },
    runServerEntry(overrides, context = {}) {
      if (parts.portOf() <= 0 || context.signal?.aborted === true) return undefined
      const includeSkills = overrides?.skills === false ? false : skillsActive()
      let includeTools = false
      if (toolsActive() && agentMatches(context)) {
        try {
          const config = parts.readConfig()
          includeTools = (parts.tools()?.schemas(context.agent) ?? []).some(tool => typeof tool?.name === 'string'
            && toolBridgableIn(tool.name, config.bridgeTools, config.bridgeToolAllowlist))
        } catch (error) { parts.logger?.warn('dsh-maestro-codex: tool schema discovery failed (exception details omitted)') }
      }
      if (!includeSkills && !includeTools) return undefined
      // All fallible setup must finish before issuing a token.
      const port = parts.portOf()
      const shimPath = parts.shimPath?.() ?? bridgeShimPath()
      if (shimPath === undefined) return undefined
      const token = state.issue(includeSkills, includeTools, context, parts.readConfig())
      try { return { token, entry: bridgeServerEntry({ port, token, shimPath }) } } catch (error) {
        state.revoke(token)
        throw error
      }
    },
    revoke(token) { state.revoke(token) },
    async catalog(token, cwd) {
      const run = state.resolve(token)
      if (run === undefined) return { error: 'bridge token 无效或已过期', status: 401 }
      if (!cwdMatches(run, cwd)) return { error: 'bridge cwd 与本次运行绑定目录不一致', status: 403 }
      let skills: BridgeSkillSummary[] = []
      try {
        if (run.includeSkills && skillsActive()) skills = await listSkills(boundCwd(run, cwd), run.controller.signal)
      } catch (error) {
        if (state.resolve(token) !== run || run.controller.signal.aborted) return { error: 'bridge token 无效或已过期', status: 401 }
        throw error
      }
      const tools = await toolsFor(token)
      if (state.resolve(token) !== run) return { error: 'bridge token 无效或已过期', status: 401 }
      // Without an agent, retain skill availability but never advertise unsafe host tools.
      if ('error' in tools && !(tools.status === 403 && skills.length > 0)) return tools
      const hostTools = 'error' in tools ? [] : tools
      // Freeze meaning, not authority: subsequent catalogs may only narrow the
      // initial roster. A newly registered host tool cannot take the name of
      // an injected skill, even if that skill is later removed or disabled.
      if (run.catalog === undefined) {
        const used = new Set(hostTools.map(tool => tool.name))
        const namedSkills = skills.map(skill => {
          let tool = skill.tool
          for (let attempt = 0; used.has(tool); attempt += 1) {
            tool = `skill_${createHash('sha256').update(`${skill.name}:${attempt}`).digest('hex').slice(0, 32)}`
          }
          used.add(tool)
          return { ...skill, tool }
        })
        run.catalog = { serverName: BRIDGE_SERVER_NAME, skills: namedSkills, tools: hostTools }
      }
      return {
        serverName: BRIDGE_SERVER_NAME,
        skills: run.catalog.skills.filter(skill => skills.some(current => current.name === skill.name)),
        tools: hostTools.filter(tool => run.catalog?.tools.some(initial => initial.name === tool.name)),
      }
    },
    async loadSkill(token, name, cwd, signal) {
      const run = state.resolve(token)
      if (run === undefined) return { ok: false, status: 401, error: 'bridge token 无效或已过期' }
      if (!run.includeSkills || !skillsActive()) return { ok: false, status: 403, error: '本次运行未开启技能桥接' }
      if (!cwdMatches(run, cwd)) return { ok: false, status: 403, error: 'bridge cwd 与本次运行绑定目录不一致' }
      if (typeof name !== 'string' || name === '') return { ok: false, status: 400, error: '"name" 不能为空' }
      const operationSignal = signal === undefined ? run.controller.signal : AbortSignal.any([signal, run.controller.signal])
      try {
        const effectiveCwd = boundCwd(run, cwd)
        const face = parts.skills()
        const raw = await within('技能加载', limits.skillMs,
          async () => await face?.get(name, { ...(effectiveCwd === undefined ? {} : { cwd: effectiveCwd }), signal: operationSignal }), operationSignal)
        if (state.resolve(token) !== run || operationSignal.aborted) return { ok: false, status: 401, error: 'bridge token 无效或已过期' }
        if (!skillsActive()) return { ok: false, status: 403, error: '本次运行未开启技能桥接' }
        const skill = skillContentOf(raw)
        const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
        const invocation = record['invocation']
        if (skill === undefined || skill.name !== name || (typeof invocation === 'object' && invocation !== null && (invocation as Record<string, unknown>)['modelInvocable'] === false)) {
          return { ok: false, status: 404, error: `技能不存在或不可模型调用：${name}` }
        }
        return { ok: true, text: renderSkillBody(skill) }
      } catch (error) {
        if (operationSignal.aborted) return { ok: false, status: 401, error: 'bridge token 无效或已过期' }
        if (error instanceof DeadlineError) return { ok: false, status: 504, error: `技能 ${name} 加载超时，已停止等待（底层读取可能仍在运行）` }
        return { ok: false, status: 500, error: '技能加载失败（详细错误未向子代理公开）' }
      }
    },
    async callTool(token, name, args) {
      const run = state.resolve(token)
      if (run === undefined) return { ok: false, status: 401, error: 'bridge token 无效或已过期' }
      if (!run.includeTools) return { ok: false, status: 403, error: '本次运行未开启宿主工具桥接' }
      if (typeof name !== 'string' || name === '') return { ok: false, status: 400, error: '"name" 不能为空' }
      const allowed = await toolsFor(token)
      if ('error' in allowed) return { ok: false, status: allowed.status, error: allowed.error }
      if ((run.catalog !== undefined && !run.catalog.tools.some(tool => tool.name === name)) || !allowed.some(tool => tool.name === name)) return { ok: false, status: 403, error: `工具 ${name} 不在本次桥接名单中` }
      if (state.resolve(token) !== run) return { ok: false, status: 401, error: 'bridge token 无效或已过期' }
      if (parts.readConfig().bridgeTools === 'scoped') run.scoped = true
      const scoped = run.scoped
      let boundArguments = args ?? {}
      if (scoped) {
        const prepared = await prepareScopedToolArguments(name, boundArguments, run.context.cwd)
        if (!prepared.ok) return prepared
        boundArguments = prepared.arguments
      }
      const face = parts.tools()
      const agent = run.context.agent
      if (face === undefined || typeof face.execute !== 'function') return { ok: false, status: 500, error: '宿主工具注册表不可用' }
      if (agent === undefined || !agentMatches(run.context)) return { ok: false, status: 403, error: '宿主工具桥接缺少可信执行 agent 或归属不一致' }
      // A call id is correlation data we own; parent is the exact host-minted symbol,
      // not the HTTP bearer token or a fabricated execution token. Without parent,
      // native mode still works and the host itself rejects collapsed PTC calls.
      const callId = `${run.context.callId ?? 'maestro'}:bridge:${randomUUID()}`
      const rootCallId = run.context.rootCallId ?? run.context.callId
      let outcome: unknown
      try {
        outcome = await within(`工具 ${name} 执行`, limits.toolMs,
          async () => {
            // Recheck *inside* the execution callback, after asynchronous path binding
            // and deadline scheduling. Revocation or policy shrink must win that race.
            if (state.resolve(token) !== run || run.controller.signal.aborted) throw new BridgeToolAdmissionError(401, 'bridge token 无效或已过期')
            if (parts.readConfig().bridgeTools === 'scoped') run.scoped = true
            if (run.scoped && !scoped) throw new BridgeToolAdmissionError(403, '桥接策略已收紧为 scoped，请重试以绑定任务路径')
            if (!pickTools(run.context).some(tool => tool.name === name)) throw new BridgeToolAdmissionError(403, `工具 ${name} 不在本次桥接名单中`)
            const executionFace = parts.tools()
            if (executionFace === undefined || typeof executionFace.execute !== 'function') throw new BridgeToolAdmissionError(403, '宿主工具注册表不可用')
            // One call still rides as a one-element batch: `ctx.tools.execute`
            // hands the input straight to `executeToolBatch`, which reads
            // `input.calls`. A lone `{ callId, name, ... }` made `calls`
            // undefined and the registry threw before any tool body ran.
            return await executionFace.execute({
              calls: [{ id: callId, name, arguments: boundArguments }],
              signal: run.controller.signal,
              agent,
              ...(rootCallId === undefined ? {} : { rootCallId }),
              ...(run.context.parent === undefined ? {} : { parent: run.context.parent }),
            })
          },
          run.controller.signal)
      } catch (error) {
        if (run.controller.signal.aborted) return { ok: false, status: 401, error: 'bridge token 无效或已过期' }
        if (error instanceof BridgeToolAdmissionError) return { ok: false, status: error.status, error: error.message }
        if (error instanceof DeadlineError) return { ok: false, status: 504, error: `工具 ${name} 在 ${String(Math.round(limits.toolMs / 60_000))} 分钟内没有返回，已停止等待（底层执行可能仍在运行）` }
        // The child must be able to act on this, but an unclassified exception
        // message can embed anything — see describeHostToolError.
        const described = describeHostToolError(error)
        parts.logger?.warn(`dsh-maestro-codex: bridged tool "${name}" threw: ${described.detail}`)
        return { ok: false, status: 500, error: `工具 ${name} 执行异常：${described.summary}` }
      }
      if (state.resolve(token) !== run) return { ok: false, status: 401, error: 'bridge token 无效或已过期' }
      const settled = hostToolOutcomeOf(outcome, callId)
      state.observeHostToolContract(settled.contract)
      if (settled.contract === 'unknown' || settled.result === undefined) {
        parts.logger?.warn(`dsh-maestro-codex: bridged tool "${name}" answered with an unrecognised settlement (${settled.contract}); expected { results: [{ callId, result }] }`)
        return { ok: false, status: 502, error: `工具 ${name} 的宿主结算结果无法识别（契约 ${settled.contract}）：期望 { results: [{ callId, result }] }。请附带 dsh 版本反馈，桥接层按实际形状适配。` }
      }
      const projected = toolOutcomeOf(settled.result)
      // Intentional tool outcomes retain their body (e.g. image-generation
      // failures); unlike thrown exceptions, they are the host tool's public contract.
      if (projected.isError) return { ok: false, status: 502, error: projected.error ?? (projected.text.trim() !== '' ? projected.text : `工具 ${name} 执行失败`) }
      return { ok: true, text: projected.text }
    },
    async stageNativeSkills(cwd, signal) {
      signal?.throwIfAborted()
      if (!skillsActive()) return undefined
      const face = parts.skills()
      if (face === undefined) return undefined
      const summaries = await listSkills(cwd, signal)
      signal?.throwIfAborted()
      if (summaries.length === 0) return undefined
      if (summaries.length > MAX_NATIVE_SKILLS) parts.logger?.warn(`dsh-maestro-codex: 原生技能目录上限 ${MAX_NATIVE_SKILLS}，已省略 ${summaries.length - MAX_NATIVE_SKILLS} 项`)
      const root = join(tmpdir(), `dsh-maestro-claude-skills-${randomUUID()}`)
      const skillsRoot = join(root, '.claude', 'skills')
      let staged = 0
      try {
        await mkdir(skillsRoot, { recursive: true })
        for (const summary of summaries.slice(0, MAX_NATIVE_SKILLS)) {
          signal?.throwIfAborted()
          try {
            const raw = await within('原生技能读取', limits.skillMs,
              async () => await face.get(summary.name, { ...(cwd === undefined ? {} : { cwd }), ...(signal === undefined ? {} : { signal }) }), signal)
            signal?.throwIfAborted()
            const skill = skillStageOf(raw)
            if (skill === undefined || skill.name !== summary.name) continue
            const dest = join(skillsRoot, skillToolName(skill.name).slice(6))
            const bundleDir = skill.resourceDirectory ?? (skill.path !== undefined && basename(skill.path) === 'SKILL.md' ? dirname(skill.path) : undefined)
            if (bundleDir !== undefined) await cp(bundleDir, dest, { recursive: true, force: true, errorOnExist: false, dereference: true })
            else await mkdir(dest, { recursive: true })
            signal?.throwIfAborted()
            await writeFile(join(dest, 'SKILL.md'), claudeSkillMarkdown(skill), 'utf8')
            signal?.throwIfAborted()
            staged += 1
          } catch (error) {
            signal?.throwIfAborted()
            parts.logger?.warn(error instanceof DeadlineError
              ? `dsh-maestro-codex: native staging of skill "${summary.name}" timed out and was skipped`
              : `dsh-maestro-codex: native staging of skill "${summary.name}" failed (exception details omitted)`)
          }
        }
        signal?.throwIfAborted()
        if (staged > 0) return { dir: root, count: staged }
      } catch (error) {
        await within('原生技能清理', limits.cleanupMs, async () => { await rm(root, { recursive: true, force: true }) }).catch(() => {})
        throw error
      }
      await within('原生技能清理', limits.cleanupMs, async () => { await rm(root, { recursive: true, force: true }) }).catch(() => {})
      return undefined
    },
    async discardStagedSkills(dir) {
      await within('原生技能清理', limits.cleanupMs, async () => { await rm(dir, { recursive: true, force: true }) }).catch(() => {})
    },
    async diagnose(cwd) {
      const config = parts.readConfig()
      const httpReady = parts.portOf() > 0
      const skillsEnabled = config.bridgeSkills !== false && parts.skills() !== undefined
      const skills = httpReady && skillsEnabled ? (await this.skillsFor(cwd)).length : 0
      const tools = config.bridgeTools !== 'off' ? (await pickTools()).length : 0
      return { skillsEnabled, toolsMode: config.bridgeTools, skills, tools, httpReady, hostToolContract: state.lastHostToolContract }
    },
  }
}

/** Native staging cap: claude's own catalog budget stays readable. */
const MAX_NATIVE_SKILLS = 64

/** Project one raw registry definition for staging. */
function skillStageOf(raw: unknown): { name: string; description: string; whenToUse: string | undefined; content: string; path: string | undefined; resourceDirectory: string | undefined } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const name = record['name']
  const description = record['description']
  const content = record['content']
  if (typeof name !== 'string' || typeof description !== 'string' || typeof content !== 'string') return undefined
  const invocation = record['invocation']
  const modelInvocable = (typeof invocation === 'object' && invocation !== null
    ? (invocation as Record<string, unknown>)['modelInvocable']
    : true) !== false
  if (!modelInvocable) return undefined
  const whenToUse = typeof record['whenToUse'] === 'string' ? record['whenToUse'] : undefined
  const path = typeof record['path'] === 'string' ? record['path'] : undefined
  const resource = record['resourceBase']
  const resourceDirectory = typeof resource === 'object' && resource !== null
    && (resource as Record<string, unknown>)['kind'] === 'directory'
    && typeof (resource as Record<string, unknown>)['path'] === 'string'
    ? (resource as Record<string, unknown>)['path'] as string : undefined
  return { name, description, content, whenToUse, path, resourceDirectory }
}

/**
 * Claude-frontmatter SKILL.md for one staged skill. Field names follow claude's
 * convention (`when_to_use`, hyphenated words elsewhere); JSON.stringify output
 * is a valid YAML double-quoted scalar, so arbitrary descriptions quote safely.
 */
function claudeSkillMarkdown(skill: { name: string; description: string; whenToUse: string | undefined; content: string }): string {
  return [
    '---',
    `name: ${JSON.stringify(skillToolName(skill.name).slice(6))}`,
    `description: ${JSON.stringify(skill.description)}`,
    ...(skill.whenToUse === undefined ? [] : [`when_to_use: ${JSON.stringify(skill.whenToUse)}`]),
    '---',
    '',
    skill.content,
    '',
  ].join('\n')
}

/** The compiled shim sits beside this module in lib/ (and beside src/ under vitest). */
export function bridgeShimPath(): string {
  return fileURLToPath(new URL('./bridge-shim.js', import.meta.url))
}

/**
 * The node command that runs the shim. The cordis host usually IS node, so
 * `process.execPath` is exact — but under an Electron main process it would be
 * the app binary, which cannot execute a script; delegate to PATH's `node`
 * then (the CLI children resolve bare commands through their own PATH).
 */
export function bridgeNodeCommand(execPath: string = process.execPath): string {
  // A Windows exec path (`C:\...\node.exe`) must be recognized on every host OS:
  // the app shell that hands the path over is Windows even when this module
  // runs elsewhere (CI, cross-platform tests). Parse with the win32 rules.
  const base = win32.basename(execPath).toLowerCase()
  return base === 'node' || base === 'node.exe' || base === 'node.cmd' ? execPath : 'node'
}

/** The stdio MCP server entry handed to the CLI channels as one more dsh server. */
export function bridgeServerEntry(options: { port: number; token: string; shimPath: string }): DshMcpServer {
  return {
    name: BRIDGE_SERVER_NAME,
    transport: 'stdio',
    command: bridgeNodeCommand(),
    args: [options.shimPath],
    env: {
      [BRIDGE_URL_ENV]: `http://127.0.0.1:${String(options.port)}`,
      [BRIDGE_TOKEN_ENV]: options.token,
    },
    source: 'maestro-bridge',
  }
}

/** The model-facing text of one loaded skill (the shim's tools/call payload). */
export function renderSkillBody(skill: { name: string; content: string; resourceHint: string | undefined }): string {
  return [
    `<skill_content name="${skill.name}">`,
    ...(skill.resourceHint === undefined ? [] : ['', skill.resourceHint]),
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

/** Per-entry description cap in the task-text catalog (keeps the block摘要级). */
const CATALOG_DESCRIPTION_CAP = 200
/** Whole-block cap; omitted entries are explicitly reported. */
const CATALOG_TOTAL_CAP = 6_000

/**
 * Escape model-facing prose embedded in the catalog envelope, so a skill
 * description cannot forge or close the `<available_skills>` block (same
 * judgment as dsh's own `renderSkillContent` prose escaping).
 */
function escapeCatalogProse(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * The catalog block prepended to the child's task text — dsh's two-step skill
 * experience, translated for a CLI child: names + one-line descriptions here,
 * full bodies only a tool call away.
 */
export function skillCatalogText(skills: readonly BridgeSkillSummary[]): string {
  if (skills.length === 0) return ''
  const lines: string[] = [
    '<available_skills>',
    '以下 dsh 技能已桥接到本子代理（MCP 服务器 dsh_bridge）。任务涉及某条技能时，先调用它的加载工具取得完整指令再动手，不要凭摘要臆测步骤：',
    '',
  ]
  let used = lines.join('\n').length
  let included = 0
  for (const skill of skills) {
    const description = skill.description.length > CATALOG_DESCRIPTION_CAP
      ? `${skill.description.slice(0, CATALOG_DESCRIPTION_CAP)}…`
      : skill.description
    const line = `- ${escapeCatalogProse(skill.name)} — ${escapeCatalogProse(description)}（加载工具：${skill.tool}）`
    if (used + line.length + 120 > CATALOG_TOTAL_CAP) break
    lines.push(line)
    used += line.length + 1
    included += 1
  }
  if (included < skills.length) lines.push(`目录上限 ${CATALOG_TOTAL_CAP} 字符：已省略 ${skills.length - included} 条技能；完整目录可通过 dsh_bridge 查询。`)
  lines.push('</available_skills>')
  return lines.join('\n')
}
