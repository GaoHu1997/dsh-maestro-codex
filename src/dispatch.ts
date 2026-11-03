/**
 * The shared dispatch runner: one CLI task from request to settled registry
 * record. Both the `dispatch_cli_task` tool and the config card's manual
 * dispatch route go through here, so cancellation, concurrency, timeouts and
 * phase bookkeeping behave identically no matter who asks.
 */

import type { ToolExec } from './tool.js'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { modelTokenError, type EffectiveConfig, type TaskDifficulty } from './config.js'
import { runClaudeTask } from './channels/claude.js'
import { runCodexTask } from './channels/codex.js'
import { detectCli, type CliDetection } from './cli-manager.js'
import { RoutingError, assertTaskDifficulty, pickCli, taskDifficultyError } from './routing.js'
import { isTerminalPhase, Limiter, TaskRegistry, type MaestroTask as TaskRegistryTask } from './task-registry.js'
import type { SpawnFn } from './spawn.js'
import { writeClaudeMcpConfig, unlinkQuiet, type DshMcpServer } from './mcp.js'
import { skillCatalogText, type BridgeHandle, type NativeSkillsStaging } from './bridge.js'
import { gitContextFor } from './git-context.js'
import type { DshPreflight } from './preflight.js'
import { parseDshModelSelection, type DshModelEndpoint } from './dsh-models.js'
import { reportCliUsage, type CliUsageSession } from './usage.js'
import type { ChildSessionRecorder } from './child-session.js'
import { cleanLogText, type MaestroChannelEvent, type MaestroCliId, type MaestroPhase } from './wire.js'
import { dedupeKeyOf, type DedupeGuard } from './dedupe.js'
import type { EffectQueue } from './effects.js'
import type { HealthReporter } from './health.js'
import { parseResultLine, RESULT_PROTOCOL_LINE } from './result-protocol.js'
import { runPrepare } from './prepare.js'

/** Channel stats use normalized camelCase buckets; retain native aliases too
 * if a channel reports them. Missing usage is unknown, never a fabricated zero.
 * Non-usage metadata describes the last attempt (not a stale failed attempt).
 */
export function accumulateAttemptStats(
  previous: TaskRegistryTask['stats'],
  current: TaskRegistryTask['stats'] | null,
): TaskRegistryTask['stats'] {
  const usageKeys = [
    'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'costUsd',
    'input_tokens', 'output_tokens', 'cached_input_tokens',
    'cache_read_input_tokens', 'cache_creation_input_tokens', 'cache_write_input_tokens',
  ] as const
  const attempts = typeof previous?.['usageAttempts'] === 'number' ? previous['usageAttempts'] : 0
  const stats: NonNullable<TaskRegistryTask['stats']> = { ...current, usageAttempts: attempts + 1 }
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
  for (const key of usageKeys) {
    const before = previous?.[key]
    const now = current?.[key]
    if (count(before) && count(now)) stats[key] = before + now
    else if (count(before) && !count(now)) stats[key] = before
    else if (!count(now)) delete stats[key]
    if ((['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens'] as readonly string[]).includes(key)) {
      const partial = `usagePartial_${key}`
      if (previous?.[partial] === true || !count(now) || (attempts > 0 && !count(before))) stats[partial] = true
    }
  }
  return stats
}

/** Faces the dispatcher needs; the host apply builds one stable instance. */
export interface DispatchDeps {
  ensureSessionAccess?: ((sessionId: string, session: CliUsageSession) => void) | undefined
  /** Plugin-owned accounting journal: begin must commit before any CLI launch. */
  beginUsage?: ((task: TaskRegistryTask) => Promise<void>) | undefined
  settleUsage?: ((task: TaskRegistryTask, session: unknown) => Promise<void>) | undefined
  readConfig: () => EffectiveConfig
  registry: TaskRegistry
  limiter: Limiter
  /** Abort controllers by task id — the cancel route kills through these. */
  controllers: Map<string, AbortController>
  pathCache: CliPathCache
  /** Resolve a `<provider>::<model>` dsh-catalog selection into a CLI endpoint. */
  resolveDshModel?: ((selection: string) => Promise<DshModelEndpoint>) | undefined
  /**
   * Confirm the resolved endpoint actually serves that model before a child is
   * spawned (declared-model check + one-token probe). Absent = no check.
   */
  preflightDshModel?: ((endpoint: DshModelEndpoint, cli?: MaestroCliId, signal?: AbortSignal) => Promise<DshPreflight>) | undefined
  /** dsh's own MCP servers (the bridge hands them to every dispatched run). */
  listMcpServers?: (() => DshMcpServer[]) | undefined
  /**
   * The dsh skills/tools bridge: prepends the skill catalog into the task text
   * and mounts the `dsh_bridge` MCP server onto the child with a per-run token.
   * Absent = the host has no skills service or HTTP surface; dispatches run
   * unbridged.
   */
  bridge?: BridgeHandle | undefined
  /** Injectable spawn seam (tests); absent = the real system spawn. */
  spawnFn?: SpawnFn | undefined
  /**
   * Settled-task sink (the $DSH_HOME persistence, see `persist.ts`). Called
   * once per settled run, after the usage report; best effort by contract.
   */
  persist?: ((task: TaskRegistryTask) => void) | undefined
  /**
   * Native record sessions: each dispatch becomes one real dsh child session
   * (usage in standard event shapes + a host-native catalog row), so every
   * statistics plugin reads CLI spend the same way it reads dsh subagent
   * spend. Absent = the host has no session store; the board still reports.
   */
  childSessions?: ChildSessionRecorder | undefined
  /**
   * 持久化副作用队列：派发前落一行 `launch`，结算后清掉。进程被杀时这行
   * 还在，下次启动就能区分「它没跑完」和「它根本没跑」——这是恢复语义的
   * 唯一事实来源。
   */
  effects?: EffectQueue | undefined
  /** 派发幂等窗口：同一父会话对同一任务重复派发会被挡住。 */
  dedupe?: DedupeGuard | undefined
  /** 本插件派发健康条目（P1-1）；失败时由 runner 上报，成功时清除。 */
  health?: HealthReporter | undefined
  /**
   * 可选的就绪命令（配置项 `prepareCommand`）：spawn 前在 cwd 里跑一次，
   * 典型用法是 `git worktree add`。失败即任务失败——目录没准备好，跑出来的
   * 结果也是错的。
   */
  prepareCommand?: (() => string) | undefined
  /** 收尾协议那一行（可从提示模板覆盖，见 prompts.ts）。 */
  protocolLine?: (() => string) | undefined
  logger?: { warn(message: string): void; error?(message: string): void }
}

/** One dispatch request (already validated by the caller). */
export interface DispatchParams {
  cli: string
  task: string
  /** 简短任务名（看板节点标题）；省略时由 {@link taskNameOf} 从 task 推导。 */
  taskName?: string | undefined
  /** Semantic assessment by the main agent; absent legacy assessments rank low. */
  taskDifficulty?: TaskDifficulty | undefined
  difficultyReason?: string | undefined
  /** Resume a previous CLI session (claude session id / codex thread id). */
  resume?: string | undefined
  cwd?: string | undefined
  model?: string | undefined
  /**
   * An explicit dsh-catalog selection (`provider::model`, e.g. the session
   * page's model picker). Resolved through `resolveDshModel` and fatal when it
   * cannot be — it never falls back to the CLI's own configuration.
   */
  dshModel?: string | undefined
  /** `dshModel` was inherited from the conversation's previous turn, not picked. */
  dshModelInherited?: boolean | undefined
  /** Thinking level override (the model's configured reasoningEfforts keys). */
  thinking?: string | undefined
  /** The task this run continues (a session-page reply); pins CLI + skips the difficulty gate. */
  replyTo?: string | undefined
  /**
   * 显式幂等键（工具参数 `dedupe_key`）。省略时按
   * (父会话, cli, 任务名, cwd) 自动推导——同一父会话在窗口内重复派发同一件事
   * 只会启动一次。
   */
  dedupeKey?: string | undefined
  timeoutMinutes?: number | undefined
  /** The calling agent's session id — the task board scopes by it. Not a model
   * parameter: the tool injects it from `exec.agent`. */
  sessionId?: string | undefined
  /**
   * The calling agent's own model route. The dispatch prefers it over the
   * configuration card's dsh model (see the resolution order in
   * {@link runDispatch}). Injected from `exec.agent`; never model-supplied.
   */
  primaryModel?: { provider: string; model: string } | undefined
  /** Trusted tool execution context; never accepted from model JSON or HTTP. */
  executionAgent?: ToolExec['agent']
  /** Native execution identity captured only by the registered host tool body. */
  executionContext?: Pick<ToolExec, 'agent' | 'token' | 'callId' | 'rootCallId'> | undefined
  /** The calling agent's session, used only to append the `maestro/cli-usage`
   * event so dsh and other plugins can read CLI spend. Injected from
   * `exec.agent`; headless runs have none.
   */
  usageSession?: CliUsageSession | undefined
}

/** The structured answer the tool returns and the card renders. */
export interface DispatchValue {
  ok: boolean
  taskId: string
  phase: MaestroPhase
  error?: string | undefined
  cli: MaestroCliId
  model: string
  cwd: string
  durationMs: number
  exitCode: number | null
  sessionRef: string
  finalText: string
  notes: string[]
}

/** Pre-task failures have no value; settled tasks retain a model-facing result. */
export class DispatchError extends Error {
  constructor(message: string, readonly value?: DispatchValue, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DispatchError'
  }
}

/** Detection cache: one `where` + `--version` per minute per (cli, override). */
export class CliPathCache {
  private readonly cache = new Map<string, { at: number; detection: CliDetection }>()
  private static readonly TTL_MS = 60_000

  constructor(private readonly readConfig: () => EffectiveConfig, private readonly spawnFn?: SpawnFn) {}

  /** The resolved CLI path, or a friendly not-installed error. */
  async pathOf(cli: MaestroCliId, signal?: AbortSignal): Promise<string> {
    const config = this.readConfig()
    const override = cli === 'claude' ? config.claude.cliPath : config.codex.cliPath
    const key = `${cli}:${override}`
    const cached = this.cache.get(key)
    if (cached !== undefined && Date.now() - cached.at < CliPathCache.TTL_MS) {
      if (!cached.detection.installed) throw new DispatchError(notInstalledMessage(cli, cached.detection.error))
      return cached.detection.path
    }
    const detection = await detectCli({ cli, override, ...(this.spawnFn === undefined ? {} : { spawnFn: this.spawnFn }), ...(signal === undefined ? {} : { signal }) })
    this.cache.set(key, { at: Date.now(), detection })
    if (!detection.installed) throw new DispatchError(notInstalledMessage(cli, detection.error))
    return detection.path
  }

  /** Drop the cache (the refresh route and the npm jobs call this). */
  invalidate(): void {
    this.cache.clear()
  }
}

function notInstalledMessage(cli: MaestroCliId, error: string | undefined): string {
  return `${cli} cli 未安装或不可用${error === undefined ? '' : `（${error}）`}。可在本插件的配置页点击「安装」。`
}

/** `<provider>::<model>`, the selection shape `resolveDshModelEndpoint` consumes. */
function selectionOf(route: { provider: string; model: string } | undefined): string | undefined {
  if (route === undefined) return undefined
  const provider = route.provider.trim()
  const model = route.model.trim()
  if (provider === '' || model === '') return undefined
  return `${provider}::${model}`
}

/** Why a resolved dsh endpoint cannot drive this CLI, or undefined when it can. */
function protocolProblem(cli: MaestroCliId, endpoint: DshModelEndpoint): string | undefined {
  if (cli === 'claude' && endpoint.api !== 'anthropic-messages') {
    return `dsh 供应商 "${endpoint.provider}" 使用 ${endpoint.api} 协议，claude cli 只能映射 Anthropic 兼容（anthropic-messages）的供应商`
  }
  // codex ≥0.146 dropped the chat dialect (wire_api="chat" now fails config
  // parsing outright) and never spoke anthropic-messages. It only knows the
  // responses dialect — but that says nothing about the upstream: dsh's `api`
  // field describes how *dsh* talks to a provider, and most OpenAI-compatible
  // gateways serve `/responses` too (measured: ofox/xm/tokenrhythm all answer
  // it, and a real codex run against ofox over responses completed cleanly).
  // So a completions-declared provider stays drivable — it is simply driven over
  // responses. Refusing it here is what made a session that had picked
  // `ofox::openai/gpt-6.1-sol` lose its model entirely.
  if (cli === 'codex' && endpoint.api !== 'openai-responses' && endpoint.api !== 'openai-completions') {
    return `dsh 供应商 "${endpoint.provider}" 使用 ${endpoint.api} 协议，codex 只认 OpenAI 兼容端点；请在配置页选择 openai-responses 或 openai-completions 协议的供应商`
  }
  return undefined
}

/** 任务名上限：看板节点标题是一行小字，再长的概括也要截在这里。 */
const TASK_NAME_CAP = 40

/**
 * 任务名：显式 `task_name` 优先；否则取 task 的首个非空行——首行通常是目标
 * 陈述，比把全文压平截到 80 字更像一个「名字」。去掉 markdown 列表/标题前缀、
 * 压平空白、截到 {@link TASK_NAME_CAP}（截断补省略号）。
 */
export function taskNameOf(task: string, taskName?: string | undefined): string {
  const cap = (value: string): string => {
    const flat = value.replace(/\s+/g, ' ').trim()
    return flat.length > TASK_NAME_CAP ? `${flat.slice(0, TASK_NAME_CAP)}…` : flat
  }
  if (taskName !== undefined) {
    const flat = cap(taskName)
    if (flat !== '') return flat
  }
  for (const line of task.split(/\r?\n/)) {
    const stripped = line.replace(/^\s{0,3}(?:[#>+]|[-*+]\s+|\d+[.)]\s+)+/, '')
    const flat = cap(stripped)
    if (flat !== '') return flat
  }
  return 'CLI 任务'
}

/** Validate one raw dispatch body; a string return is the error message. */
export function parseDispatchParams(raw: unknown): DispatchParams | string {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const task = record['task']
  if (typeof task !== 'string' || task.trim() === '') return '"task" 不能为空：CLI 子代理需要完整任务描述'
  if (task.length > 100_000) return '"task" 超过 100k 字符上限'
  const taskName = typeof record['task_name'] === 'string' && record['task_name'].trim() !== ''
    ? record['task_name'].trim()
    : undefined
  const taskDifficulty = record['task_difficulty']
  const difficultyReason = record['difficulty_reason']
  const assessmentError = taskDifficultyError(taskDifficulty, difficultyReason)
  if (assessmentError !== undefined) return assessmentError
  const cli = typeof record['cli'] === 'string' && record['cli'].trim() !== '' ? record['cli'].trim() : 'auto'
  const cwd = typeof record['cwd'] === 'string' && record['cwd'].trim() !== '' ? record['cwd'].trim() : undefined
  if (cwd !== undefined && (!isAbsolute(cwd) || !existsSync(cwd))) return `"cwd" 必须是已存在的绝对路径：${cwd}`
  const model = typeof record['model'] === 'string' && record['model'].trim() !== '' ? record['model'].trim() : undefined
  if (model !== undefined) {
    const error = modelTokenError(model)
    if (error !== undefined) return `"model" ${error}`
  }
  const resume = typeof record['resume'] === 'string' && record['resume'].trim() !== '' ? record['resume'].trim() : undefined
  if (resume !== undefined && !/^[\w.:@+-]{1,128}$/.test(resume)) return '"resume" 必须是上次结果返回的会话引用（sessionRef）'
  const dedupeKey = typeof record['dedupe_key'] === 'string' && record['dedupe_key'].trim() !== ''
    ? record['dedupe_key'].trim().slice(0, 200)
    : undefined
  let timeoutMinutes: number | undefined
  if (typeof record['timeout_minutes'] === 'number' && Number.isFinite(record['timeout_minutes'])) {
    timeoutMinutes = Math.min(240, Math.max(1, Math.round(record['timeout_minutes'])))
  }
  return {
    cli, task, cwd,
    ...(taskName === undefined ? {} : { taskName }),
    ...(taskDifficulty === undefined ? {} : {
      taskDifficulty: taskDifficulty as TaskDifficulty,
      difficultyReason: (difficultyReason as string).trim(),
    }),
    ...(resume === undefined ? {} : { resume }),
    ...(model === undefined ? {} : { model }),
    ...(dedupeKey === undefined ? {} : { dedupeKey }),
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
  }
}

/**
 * Run one dispatch to settlement. Throws `DispatchError` (or the abort reason)
 * on failure; resolves with the structured value on success. The registry
 * record carries the full event trail either way. `hooks.onTaskId` fires as
 * soon as the registry record exists (the manual route answers with the id
 * and polls, instead of holding the HTTP request open). `hooks.onEvent` /
 * `hooks.onPhase` mirror the registry stream for the dsh job row — they are
 * observability taps and can never change the run's semantics.
 */
export async function runDispatch(deps: DispatchDeps, params: DispatchParams, signal: AbortSignal, hooks?: {
  onTaskId?: (id: string) => void
  onEvent?: (kind: MaestroChannelEvent['kind'], text: string, detail?: string) => void
  onPhase?: (phase: MaestroPhase, note: string | undefined) => void
}): Promise<DispatchValue> {
  signal.throwIfAborted()
  const config = deps.readConfig()
  if (!config.enabled) throw new DispatchError('CLI 子代理插件已停用（配置页可重新开启）')

  // Resume is an authenticated continuation, never a free-form CLI reference.
  // Resolve ownership before routing or creating a task, for BOTH tool and UI.
  if (params.resume !== undefined || params.replyTo !== undefined) {
    if (params.sessionId === undefined || params.sessionId === '') throw new DispatchError('续接缺少可信父会话归属')
    const reference = params.resume ?? ''
    const anchors = deps.registry.list().filter(candidate => candidate.sessionRef === reference)
    if (reference === '' || anchors.length === 0 || anchors.some(candidate => candidate.sessionId !== params.sessionId)) throw new DispatchError('CLI 会话引用不存在或不属于当前父会话')
    const anchorSummary = params.replyTo === undefined ? anchors[0] : anchors.find(candidate => candidate.id === params.replyTo)
    const anchor = anchorSummary === undefined ? undefined : deps.registry.get(anchorSummary.id)
    if (anchor === undefined || !isTerminalPhase(anchor.phase)) throw new DispatchError('续接锚点不存在或尚未结束')
    if (params.cli !== '' && params.cli !== 'auto' && params.cli !== anchor.cli) throw new DispatchError('续接不能更换原 CLI 执行器')
    if (!config[anchor.cli].enabled) throw new DispatchError(`原 CLI ${anchor.cli} 已停用，无法续接；不会回落其他执行器`)
    if (params.cwd !== undefined && params.cwd !== anchor.cwd) throw new DispatchError('续接必须沿用原会话 cwd')
    const inherited = typeof anchor.stats?.['dshModel'] === 'string' ? anchor.stats['dshModel'] : undefined
    const inheritedThinking = typeof anchor.stats?.['dshThinking'] === 'string' ? anchor.stats['dshThinking'] : undefined
    params = { ...params, cli: anchor.cli, cwd: anchor.cwd, replyTo: anchor.id,
      ...(params.thinking !== undefined || params.model !== undefined || (params.dshModel !== undefined && params.dshModelInherited !== true) || inheritedThinking === undefined ? {} : { thinking: inheritedThinking }),
      ...(params.dshModel !== undefined || params.model !== undefined || inherited === undefined ? {} : { dshModel: inherited, dshModelInherited: true }) }
  }

  // An authenticated continuation pins its executor and reuses the admission
  // decision of its original task; new dispatches still obey their own gate.
  const isReply = params.replyTo !== undefined
  let decision
  let taskDifficulty: TaskDifficulty
  if (isReply) {
    decision = { cli: params.cli as MaestroCliId, reason: 'requested' as const, note: undefined }
    taskDifficulty = 'low'
  } else {
    try {
      decision = pickCli(config, params.cli, params.task)
      taskDifficulty = assertTaskDifficulty(config, decision.cli, params.taskDifficulty, params.difficultyReason)
    } catch (error) {
      throw error instanceof RoutingError ? new DispatchError(error.message) : error
    }
  }

  const notes: string[] = isReply
    ? [`会话续接（回复 ${params.replyTo}）：CLI 固定为 ${decision.cli}，沿用已通过的难度门槛`]
    : [
      `难度评估：${taskDifficulty}；${decision.cli} 最低难度：${config[decision.cli].minTaskDifficulty}；依据：${params.difficultyReason === undefined ? '旧调用未提供评估，保守按 low 处理' : cleanLogText(params.difficultyReason.trim())}`,
    ]
  if (decision.note !== undefined) notes.push(decision.note)
  const model = params.model ?? ''
  const timeoutMinutes = params.timeoutMinutes ?? (decision.cli === 'claude' ? config.claude.timeoutMinutes : config.codex.timeoutMinutes)
  // A missing cwd used to travel as `undefined`, silently inheriting whatever
  // directory the host process happened to be in. Resolve it once, say which
  // directory the run really used, and hand that same path to the child.
  const requestedCwd = params.cwd
  const cwd = requestedCwd ?? process.cwd()
  if (requestedCwd === undefined) notes.push(`未指定 cwd，沿用宿主进程目录：${cwd}`)

  const releaseResume = params.resume === undefined ? undefined : deps.registry.claimResume(decision.cli, params.resume)
  // 幂等：同一父会话对同一件事的重复派发只启动一次（窗口见 dedupe.ts）。
  // 续接（reply）是人对同一任务的追加指令，天然可以重复，不参与去重。
  const dedupeKey = isReply
    ? undefined
    : dedupeKeyOf({
      ...(params.sessionId === undefined ? {} : { parentSessionId: params.sessionId }),
      cli: decision.cli,
      taskName: taskNameOf(params.task, params.taskName),
      cwd,
    }, params.dedupeKey)
  if (dedupeKey !== undefined) deps.dedupe?.claim(dedupeKey)
  const id = `task-${randomUUID()}`
  // The claude native-skills staging tree, cleaned up however the run settles.
  let stagedSkillsDir: string | undefined
  // The model route the child actually used (provider falls back to the CLI
  // channel name when no dsh endpoint resolved), and whether the runner got
  // far enough to spawn — the record session only settles a spawned run.
  let resolvedRoute: { provider: string; model: string } | undefined
  const abort = new AbortController()
  const onOuterAbort = (): void => abort.abort(signal.reason)
  if (signal.aborted) onOuterAbort()
  else signal.addEventListener('abort', onOuterAbort, { once: true })
  deps.controllers.set(id, abort)

  // The record exists before availability checks so a failed lookup is
  // visible in the monitor, and the manual route can answer with the id.
  const task = deps.registry.create({
    id,
    cli: decision.cli,
    // 节点标题是简短任务名（task_name 参数或 task 首行）；截断的完整输入
    // 由 registry 摘要的 inputPreview 承载，看板把它画成节点的描述行。
    title: taskNameOf(params.task, params.taskName),
    prompt: params.task,
    cwd,
    model,
    ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
    ...(params.replyTo === undefined ? {} : { replyTo: params.replyTo }),
  })
  try { hooks?.onTaskId?.(id) } catch { deps.registry.push(task, 'note', '任务观测回调不可用，执行继续') }

  // Native record session: real dsh child (usage lands in standard event
  // shapes), seeded with the task text, plus the host-native catalog row on
  // the dispatching session. Best effort — a host without the store (or with
  // recording switched off) keeps every other feature.
  try {
    deps.childSessions?.start({
      taskId: id,
      label: task.title,
      taskText: params.task,
      cwd,
      cli: task.cli,
      startedAt: task.startedAt,
      ...(params.sessionId === undefined ? {} : { parentSessionId: params.sessionId }),
      ...(params.usageSession === undefined ? {} : { parentSession: params.usageSession }),
    })
  } catch { deps.registry.push(task, 'note', '子会话记录不可用，CLI 执行继续') }

  // 先记账再干活：这一行在进程被杀时会留下来，下次启动据此把它标成
  // interrupted（而不是当成从没发生过，也不是当成它自己失败）。
  try {
    await deps.effects?.enqueue('launch', id, {
      taskId: id,
      cli: decision.cli,
      taskName: task.title,
      prompt: params.task,
      cwd,
      taskDifficulty,
      ...(params.difficultyReason === undefined ? {} : { difficultyReason: params.difficultyReason }),
      model,
      ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
      ...(params.replyTo === undefined ? {} : { replyTo: params.replyTo }),
      startedAt: task.startedAt,
    })
  } catch { deps.registry.push(task, 'note', '副作用队列不可用，本次派发无法在重启后恢复') }

  try {
    abort.signal.throwIfAborted()
    if (deps.beginUsage !== undefined) {
      try {
        await deps.beginUsage(task)
        task.stats = { ...task.stats, accountingBeginState: 'stored' }
      } catch (error) {
        task.stats = { ...task.stats, accountingBeginState: 'failed' }
        throw error
      }
    }
    abort.signal.throwIfAborted()
    if (params.sessionId !== undefined && params.usageSession !== undefined) deps.ensureSessionAccess?.(params.sessionId, params.usageSession)
    let cliPath: string
    try {
      abort.signal.throwIfAborted()
      cliPath = await deps.pathCache.pathOf(decision.cli, abort.signal)
      abort.signal.throwIfAborted()
    } catch (error) {
      deps.registry.setPhase(task, abort.signal.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error))
      throw error
    }

    // 人在等的那一轮（页面回复 / 会话续接）排到机器派发前面：并发满时它还能
    // 借用溢出槽，不会再被一串后台任务卡在队列里。
    const slot = deps.limiter.acquire(abort.signal, { priority: isReply ? 'human' : 'normal' })
    try {
      await slot.waited
    } catch (error) {
      deps.registry.setPhase(task, 'cancelled', error instanceof Error ? error.message : '已取消')
      throw error instanceof Error ? error : new Error(String(error))
    }

    try {
      abort.signal.throwIfAborted()
      const setPhaseOf = (phase: MaestroPhase, note?: string): void => {
        deps.registry.setPhase(task, phase, note)
        try { hooks?.onPhase?.(phase, note) } catch { /* observability is best effort */ }
      }
      setPhaseOf('running', `开始执行（${decision.cli}${model === '' ? '' : `, model=${model}`}, cwd=${cwd}，连续无输出超时 ${timeoutMinutes} 分钟）`)
      const startedAt = Date.now()
      const onEvent = (kind: MaestroChannelEvent['kind'], text: string, detail?: string): void => {
        deps.registry.push(task, kind, text, detail)
        try { hooks?.onEvent?.(kind, text, detail) } catch { /* observability is best effort */ }
      }
      // 回复轮的续接说明也进事件流：会话页/看板上能看到这一轮是怎么来的。
      if (isReply && notes[0] !== undefined) onEvent('note', notes[0])
      // 就绪命令：跑一次，失败即当轮失败。默认不配（空串）就完全跳过。
      const prepare = deps.prepareCommand?.() ?? ''
      if (prepare.trim() !== '') {
        onEvent('note', `执行 prepareCommand：${prepare.replace(/\s+/g, ' ').slice(0, 200)}`)
        abort.signal.throwIfAborted()
        const prepared = await runPrepare(prepare, { cwd, signal: abort.signal })
        abort.signal.throwIfAborted()
        if (!prepared.ok) {
          setPhaseOf('failed', `prepareCommand 失败：${prepared.output}`)
          throw new DispatchError(`prepareCommand 失败：${prepared.output}`)
        }
        onEvent('note', `prepareCommand 完成${prepared.output === '' ? '' : `：${prepared.output}`}`)
      }
      // CLI watchdogs measure consecutive output silence, not total runtime.
      // Warnings live beside the watchdog so actual chunks reset both clocks.
      const timeoutMs = timeoutMinutes * 60_000
      {
        // A fully qualified tool model pins its DSH provider. A bare model
        // changes only the model within a trusted primary/configured provider;
        // every candidate is resolved and probed with that exact model name.
        const qualifiedModel = params.model?.includes('::') === true ? params.model : undefined
        const explicitSelection = params.dshModel || qualifiedModel
        const bareModel = qualifiedModel === undefined ? params.model : undefined
        if (explicitSelection !== undefined && parseDshModelSelection(explicitSelection) === undefined) {
          throw new DispatchError('显式模型必须使用有效的 <provider>::<model> DSH 选择')
        }
        if (params.dshModel && params.model !== undefined && (qualifiedModel !== undefined
          ? qualifiedModel !== params.dshModel
          : parseDshModelSelection(params.dshModel)?.model !== bareModel)) {
          throw new DispatchError('model 与 dshModel 指向不同模型；请只指定一个明确的 DSH provider::model')
        }
        const withBareModel = (selection: string): string => {
          const route = parseDshModelSelection(selection)
          return bareModel !== undefined && route !== undefined ? `${route.provider}::${bareModel}` : selection
        }
        // There is no fallback to CLI-owned configuration, including hosts
        // without a settings/credentials resolver. Explicit providers never
        // fall back; automatic providers may use the configured DSH route.
        let dshEndpoint: DshModelEndpoint | undefined
        const requireEndpoint = (endpoint: DshModelEndpoint): void => {
          if (endpoint.baseURL.trim() === '' || endpoint.apiKey.trim() === '' || endpoint.provider.trim() === '' || endpoint.model.trim() === '') {
            throw new DispatchError('DSH 模型端点缺少 provider、model、baseURL 或凭据，不能回落到 CLI 自身配置')
          }
          if (params.model !== undefined) {
            const requested = qualifiedModel === undefined ? undefined : parseDshModelSelection(qualifiedModel)
            const expectedModel = requested?.model ?? bareModel
            if (endpoint.model !== expectedModel || (requested !== undefined && endpoint.provider !== requested.provider)) {
              throw new DispatchError('DSH 解析结果与显式 model 不一致，不能改用其他 provider 或模型')
            }
          }
        }
        // 会话模型：这一轮真正解析成功的 dsh 选择（provider::model）。记录到
        // stats 后，续发（reply）据此沿用同一条会话的模型——与 dsh 子智能体
        // 的子会话携带自身模型一致，而不是回落 CLI 自身配置或重新路由。
        let resolvedSelection = ''
        // One note reaches both readers: the board's event trail and the tool
        // result the model sees.
        const note = (text: string): void => {
          notes.push(text)
          onEvent('note', text)
        }
        // An explicit dsh-catalog selection (the session page's model picker)
        // outranks every automatic route: resolve it on the spot and fail
        // loudly when it cannot — it never falls back to the CLI's own config.
        // The same preflight as the automatic routes guards the spawn.
        if (explicitSelection !== undefined) {
          if (deps.resolveDshModel === undefined) {
            const message = `本部署读不到 dsh 模型目录（settings/credentials 服务不可用），无法使用所选模型 ${explicitSelection}`
            setPhaseOf('failed', message)
            throw new DispatchError(message)
          }
          let endpoint: DshModelEndpoint
          try {
            abort.signal.throwIfAborted()
            endpoint = await deps.resolveDshModel(explicitSelection)
            abort.signal.throwIfAborted()
            requireEndpoint(endpoint)
          } catch (error) {
            abort.signal.throwIfAborted()
            const message = error instanceof Error ? error.message : String(error)
            setPhaseOf('failed', message)
            throw error instanceof DispatchError ? error : new DispatchError(message)
          }
          const problem = protocolProblem(decision.cli, endpoint)
          if (problem !== undefined) {
            setPhaseOf('failed', problem)
            throw new DispatchError(problem)
          }
          abort.signal.throwIfAborted()
          const preflight = deps.preflightDshModel === undefined
            ? undefined
            : await deps.preflightDshModel(endpoint, decision.cli, abort.signal)
          abort.signal.throwIfAborted()
          if (preflight !== undefined && preflight.status === 'mismatch') {
            setPhaseOf('failed', preflight.detail)
            throw new DispatchError(preflight.detail)
          }
          if (preflight?.note !== undefined) note(preflight.note)
          dshEndpoint = endpoint
          resolvedSelection = explicitSelection
          note(params.dshModelInherited === true
            ? `沿用会话模型：${explicitSelection}`
            : params.dshModel !== undefined
              ? `使用会话页选择的 dsh 模型：${explicitSelection}`
              : `使用显式选择的 dsh 模型：${explicitSelection}`)
        } else {
          const cliLabel = decision.cli
          const configuredSelection = withBareModel(cliLabel === 'claude' ? config.claude.dshModel : config.codex.dshModel)
          const configuredKey = cliLabel === 'claude' ? 'claudeDshModel' : 'codexDshModel'
          const attempts: Array<{ selection: string; label: string; fatal: boolean }> = []
          const primary = selectionOf(params.primaryModel)
          const primarySelection = primary === undefined ? undefined : withBareModel(primary)
          if (primarySelection !== undefined) attempts.push({ selection: primarySelection, label: '主代理模型', fatal: false })
          if (configuredSelection !== '') attempts.push({ selection: configuredSelection, label: '配置页模型', fatal: true })
          // Every rejected candidate is remembered: when nothing survives, the
          // failure has to name the real reason instead of blaming the task.
          const rejected: string[] = []
          for (const attempt of attempts) {
            abort.signal.throwIfAborted()
            if (deps.resolveDshModel === undefined) break
            let endpoint: DshModelEndpoint
            try {
              endpoint = await deps.resolveDshModel(attempt.selection)
              abort.signal.throwIfAborted()
              requireEndpoint(endpoint)
            } catch (error) {
              abort.signal.throwIfAborted()
              const message = error instanceof Error ? error.message : String(error)
              if (attempt.fatal) {
                setPhaseOf('failed', message)
                throw error
              }
              rejected.push(`主代理模型 ${attempt.selection} 不可用（${message}）`)
              if (configuredSelection !== '') note(`主代理模型 ${attempt.selection} 不可用（${message}），直接使用配置页模型`)
              continue
            }
            const problem = protocolProblem(cliLabel, endpoint)
            if (problem === undefined) {
              // The protocol is speakable; the model name may still be wrong for
              // this endpoint. Check before spawning so a dead alias fails here
              // with a sentence instead of mid-run with a 4xx.
              abort.signal.throwIfAborted()
              const preflight = deps.preflightDshModel === undefined
                ? undefined
                : await deps.preflightDshModel(endpoint, decision.cli, abort.signal)
              abort.signal.throwIfAborted()
              if (preflight !== undefined && preflight.status === 'mismatch') {
                if (attempt.fatal) {
                  setPhaseOf('failed', preflight.detail)
                  throw new DispatchError(preflight.detail)
                }
                rejected.push(`主代理模型 ${attempt.selection} 预检未通过（${preflight.detail}）`)
                if (configuredSelection !== '') note(`主代理模型 ${attempt.selection} 预检未通过（${preflight.detail}），直接使用配置页模型`)
                continue
              }
              if (preflight?.note !== undefined) note(preflight.note)
              dshEndpoint = endpoint
              resolvedSelection = attempt.selection
              if (attempt.label === '主代理模型') note(`CLI 模型沿用主代理：${attempt.selection}`)
              break
            }
            if (attempt.fatal) {
              setPhaseOf('failed', problem)
              throw new DispatchError(problem)
            }
            rejected.push(`主代理模型 ${attempt.selection} 的协议不受 ${cliLabel} 支持（${problem}）`)
            if (configuredSelection !== '') note(`主代理模型 ${attempt.selection} 的协议不受 ${cliLabel} 支持（${problem}），直接使用配置页模型`)
          }
          if (dshEndpoint === undefined) {
            const reasons = [...rejected]
            if (deps.resolveDshModel === undefined) reasons.push('读不到 dsh 模型目录（settings/credentials 服务不可用）')
            if (configuredSelection === '') reasons.push(`配置页未设置 ${configuredKey}`)
            const hint = cliLabel === 'codex'
              ? '请在插件设置里为 codex 选择一个 OpenAI 兼容的 dsh 模型（openai-responses 或 openai-completions 协议的供应商，形如 provider::model，例如 wb::gpt-6.1-sol），或把主代理切到这类供应商。'
              : '请在插件设置里为 claude 选择 anthropic-messages 协议的模型（形如 provider::model），或把主代理切到 anthropic-messages 协议的供应商。'
            const message = [
              `${cliLabel} 子代理需要一个 dsh 模型端点，但当前没有可用的路由：`,
              ...reasons.map(reason => `· ${reason}`),
              hint,
              `不会回退到 ${cliLabel} 自身的配置文件：那是另一套供应商与密钥，任务会连到错误的端点。`,
            ].join('\n')
            setPhaseOf('failed', message)
            throw new DispatchError(message)
          }
        }
        abort.signal.throwIfAborted()
        if (dshEndpoint.baseURL.trim() === '' || dshEndpoint.apiKey.trim() === '') {
          throw new DispatchError('DSH 模型端点缺少 baseURL 或凭据，不能回落到 CLI 自身配置')
        }
        const effectiveModel = dshEndpoint.model
        // The board shows the model the child really received, not the pre-route blank.
        deps.registry.setModel(task, effectiveModel)
        resolvedRoute = {
          provider: dshEndpoint.provider,
          model: effectiveModel,
        }

        // 协同接缝①：把 cwd 的 git 工作区快照（分支/未提交改动）注入任务开头，
        // CLI 子代理少猜一轮。只读、best effort、解析不可信即跳过；registry
        // 标题与工具返回仍用原 task 文本。
        let taskText = params.task
        if (config.injectGitContext === true) {
          abort.signal.throwIfAborted()
          const block = await gitContextFor(cwd, deps.spawnFn, abort.signal)
          abort.signal.throwIfAborted()
          if (block !== undefined) {
            taskText = `${block}\n\n${params.task}`
            onEvent('note', '已把 git 工作区快照（分支/改动）注入任务开头')
          }
        }
        // Native staging owns its partial tree on error; once returned, the
        // dispatch owns cleanup even when cancellation won during the await.
        let nativeSkills: NativeSkillsStaging | undefined
        if (decision.cli === 'claude' && config.bridgeSkills === true && config.claudeSkillsMode === 'native' && deps.bridge !== undefined) {
          try {
            abort.signal.throwIfAborted()
            nativeSkills = await deps.bridge.stageNativeSkills(cwd, abort.signal)
          } catch (error) {
            abort.signal.throwIfAborted()
            onEvent('note', '原生技能目录暂存失败（本轮回退 dsh_bridge；详细错误未向子代理公开）')
          }
          if (nativeSkills !== undefined) {
            stagedSkillsDir = nativeSkills.dir
            onEvent('note', `已把 ${String(nativeSkills.count)} 个 dsh 技能暂存为 claude 原生技能目录（--add-dir）`)
          }
          abort.signal.throwIfAborted()
        }
        // 收尾协议：任务末尾附一行说明，让子代理结束时交回结构化结论。
        // 不遵守也无妨——解析器读不到就按 phase 兜底，绝不从日志里猜。
        const protocolLine = deps.protocolLine?.() ?? RESULT_PROTOCOL_LINE
        if (protocolLine.trim() !== '') taskText = `${taskText}\n\n${protocolLine}`
        if (params.resume !== undefined) {
          onEvent('note', `续接 ${decision.cli} 会话 ${params.resume}：原会话对话不会自动带入，需要的结论请写在任务里`)
        }

        // The thinking level: an explicit override (the session page's picker)
        // wins over the configured per-CLI default.
        const thinking = params.thinking ?? (decision.cli === 'claude' ? config.claude.thinking : config.codex.thinking)

        const baseMcpServers = config.bridgeMcp === true ? deps.listMcpServers?.() ?? [] : []
        // 失败自动重试（默认 0 次）：只重试普通失败——超时重试会翻倍等待、取消
        // 重试违背取消语义；文件改动型任务请保持 0，重试可能叠加改动。
        const maxAttempts = 1 + Math.min(2, Math.max(0, Math.trunc(config.failureRetries)))
        let lastSessionRef = ''
        let bridgeNoted = false
        for (let attempt = 1; ; attempt += 1) {
          let mcpConfigPath: string | undefined
          let bridgeToken: string | undefined
          const revokeBridge = (): void => {
            if (bridgeToken === undefined) return
            const token = bridgeToken
            bridgeToken = undefined
            deps.bridge?.revoke(token)
          }
          try {
            abort.signal.throwIfAborted()
            let attemptTaskText = taskText
            // Each attempt gets one token and one stable skill/tool name map.
            // Native skills narrow the bridge to tools only, as before.
            let mcpServers = baseMcpServers
            if (deps.bridge !== undefined) {
              const bridgeRun = deps.bridge.runServerEntry(nativeSkills !== undefined ? { skills: false } : undefined, {
                agent: params.executionContext?.agent ?? params.executionAgent,
                parent: params.executionContext?.token,
                callId: params.executionContext?.callId, rootCallId: params.executionContext?.rootCallId,
                sessionId: params.sessionId, cwd, signal: abort.signal,
              })
              if (bridgeRun !== undefined) {
                bridgeToken = bridgeRun.token
                mcpServers = [...baseMcpServers, bridgeRun.entry]
                if (!bridgeNoted) {
                  bridgeNoted = true
                  onEvent('note', '已挂载 dsh_bridge MCP 服务器（dsh 技能/工具桥）')
                }
                if (nativeSkills === undefined && config.bridgeSkills === true) {
                  abort.signal.throwIfAborted()
                  const skills = await deps.bridge.skillsFor(cwd, abort.signal, bridgeToken)
                  abort.signal.throwIfAborted()
                  if (skills.length > 0) {
                    attemptTaskText = `${skillCatalogText(skills)}\n\n${taskText}`
                    onEvent('note', `已把 ${String(skills.length)} 个 dsh 技能的目录注入任务开头（全文经 dsh_bridge 按需加载）`)
                  }
                }
              }
            }
            abort.signal.throwIfAborted()
            if (decision.cli === 'claude' && mcpServers.length > 0) {
              mcpConfigPath = await writeClaudeMcpConfig(mcpServers)
              abort.signal.throwIfAborted()
            }

            // Live counters: the board polls the task list, so writing the
            // running snapshot here is what puts tokens on a card before the
            // task ends. Settled `stats` still wins once the run resolves. No
            // session log is touched: private session appends are unloadable on
            // hosts whose append has no ignorable channel.
            const onUsage = (stats: Record<string, string | number | boolean>): void => {
              deps.registry.setLiveStats(task, stats)
            }

            abort.signal.throwIfAborted()
            const run = decision.cli === 'claude'
              ? runClaudeTask({
                  ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
                  claudePath: cliPath,
                  task: attemptTaskText,
                  cwd,
                  model: effectiveModel,
                  ...(params.resume === undefined ? {} : { resume: params.resume }),
                  permissionMode: config.claude.permissionMode,
                  thinking,
                  baseUrl: dshEndpoint.baseURL,
                  authToken: dshEndpoint.apiKey,
                  ...(mcpConfigPath === undefined ? {} : { mcpConfigPath, mcpServerNames: mcpServers.map(server => server.name) }),
                  ...(nativeSkills !== undefined ? { addDir: nativeSkills.dir } : {}),
                  timeoutMs,
                  signal: abort.signal,
                  onEvent,
                  onUsage,
                })
              : runCodexTask({
                  ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
                  codexPath: cliPath,
                  task: attemptTaskText,
                  cwd,
                  model: effectiveModel,
                  ...(params.resume === undefined ? {} : { resume: params.resume }),
                  sandbox: config.codex.sandbox,
                  thinking,
                  configOverrides: config.codex.configOverrides,
                  dshModel: {
                    model: dshEndpoint.model,
                    baseUrl: dshEndpoint.baseURL,
                    apiKey: dshEndpoint.apiKey,
                  },
                  ...(mcpServers.length > 0 ? { mcpServers } : {}),
                  baseUrl: config.codex.baseUrl,
                  apiKey: config.codex.apiKey,
                  timeoutMs,
                  signal: abort.signal,
                  onEvent,
                  onUsage,
                })

            // Two cancel paths meet here: the outer signal (tool exec / HTTP cancel)
            // aborts `abort`, the child dies, and the run settles with a failure —
            // no separate race needed.
            const raced = await run
            // Capability ends with this attempt, before any terminal record or hook
            // can observe it. File cleanup may be slow and never extends authority.
            revokeBridge()
            task.stats = accumulateAttemptStats(task.stats, raced.stats)
            task.liveStats = undefined
            if (resolvedRoute !== undefined) task.stats = { ...task.stats, usageProvider: resolvedRoute.provider, usageSource: `cli:${decision.cli}` }
            task.exitCode = raced.exitCode ?? undefined
            task.finalText = cleanLogText(raced.finalText)
            const reportedSessionRef = 'sessionId' in raced ? raced.sessionId : raced.threadId
            if (reportedSessionRef !== '') lastSessionRef = reportedSessionRef
            const sessionRef = lastSessionRef
            if (sessionRef !== '') {
              // Keep the persisted recovery anchor even for failed/timed-out
              // runs; DispatchError.value exposes the same valid reference.
              task.stats = { ...task.stats, sessionRef }
              onEvent('note', `${decision.cli} session: ${sessionRef}`)
            }
            // 会话模型与 sessionRef 同点落账（accumulateAttemptStats 只保留
            // 用量键，解析期的赋值会被结算覆盖）：续发据此沿用这条会话的模型。
            task.stats = { ...task.stats, dshThinking: thinking }
            if (resolvedSelection !== '') task.stats = { ...task.stats, dshModel: resolvedSelection }

            const durationMs = Date.now() - startedAt
            if (raced.ok && !abort.signal.aborted) {
              const finalText = cleanLogText(raced.finalText)
              task.exitCode = raced.exitCode ?? 0
              task.finalText = finalText
              // 收尾协议优先：读到最后一行结构化结论就照它说；读不到就让 phase
              // 兜底（summaryOf 负责），这里不写任何猜测值。
              const result = parseResultLine(finalText)
              if (result !== undefined) {
                deps.registry.setResult(task, result)
                deps.registry.push(task, 'result',
                  `收尾：${result.state}${result.humanAction === undefined ? '' : `（等你：${result.humanAction}）`}`,
                  result.summary)
              }
              setPhaseOf('done', '执行完成')
              if (sessionRef !== '') notes.push(`${decision.cli} session: ${sessionRef}`)
              // 续接提示（notes 走人工/看板侧；模型侧的同款提示在 renderSummary
              // 的结果文本里）：返工/追加时回同一会话，子代理保留完整上下文。
              if (sessionRef !== '') notes.push(`需要返工或补充要求时，传 resume="${sessionRef}" 续接同一 CLI 会话`)
              for (const [key, stat] of Object.entries(task.stats ?? {})) notes.push(`${key}: ${String(stat)}`)
              return {
                ok: true,
                taskId: id,
                phase: 'done',
                cli: decision.cli,
                model: effectiveModel,
                cwd,
                durationMs,
                exitCode: raced.exitCode ?? 0,
                sessionRef,
                finalText,
                notes,
              }
            }
            const message = abort.signal.aborted
              ? '任务已取消'
              // `??` only catches undefined: a channel that settled with an empty
              // error string (all causes deduped away) still needs a reason.
              : raced.error !== undefined && raced.error.trim() !== '' ? raced.error : '任务失败（原因未知）'
            const timedOut = raced.stats?.['timedOut'] === true
            if (attempt < maxAttempts && !timedOut && !abort.signal.aborted) {
              onEvent('note', `第 ${String(attempt)} 次执行失败，自动重试（${String(attempt)}/${String(maxAttempts - 1)}）：${message.split(/\r?\n/)[0]?.slice(0, 200) ?? ''}`)
              continue
            }
            setPhaseOf(abort.signal.aborted ? 'cancelled' : timedOut ? 'timeout' : 'failed', message)
            task.exitCode = raced.exitCode ?? undefined
            throw new DispatchError(`${decision.cli} 任务失败：${message}`)
          } finally {
            revokeBridge()
            if (mcpConfigPath !== undefined) await unlinkQuiet(mcpConfigPath)
          }
        }
      }
    } finally {
      slot.release()
    }
  } catch (error) {
    const message = cleanLogText(error instanceof Error ? error.message : String(error))
    if (!isTerminalPhase(task.phase)) deps.registry.setPhase(task, abort.signal.aborted ? 'cancelled' : 'failed', message)
    // 失败不占幂等窗口：同一件事人可能会立刻再派一次（改完提示再试）。
    if (dedupeKey !== undefined) deps.dedupe?.release(dedupeKey)
    const sessionRef = typeof task.stats?.['sessionRef'] === 'string' ? task.stats['sessionRef'] : ''
    throw new DispatchError(message, {
      ok: false,
      taskId: id,
      phase: task.phase,
      error: message,
      cli: decision.cli,
      model: task.model,
      cwd,
      durationMs: Math.max(0, Date.now() - task.startedAt),
      exitCode: task.exitCode ?? null,
      sessionRef,
      finalText: task.finalText ?? '',
      notes,
    }, { cause: error })
  } finally {
    releaseResume?.()
    deps.controllers.delete(id)
    signal.removeEventListener('abort', onOuterAbort)
    // Commit the plugin-owned source before publishing standard record usage.
    // Failure stays machine-readable and does not erase valid CLI output.
    if (deps.settleUsage !== undefined) {
      try { await deps.settleUsage(task, params.usageSession) }
      catch {
        if (typeof task.stats?.['accountingState'] !== 'string' || !task.stats['accountingState'].startsWith('canonical-stored')) task.stats = { ...task.stats, accountingState: 'unconfirmed' }
        const message = 'CLI 已结算，但持久化用量或宿主投影尚未确认；请查看 accountingState 和插件账本恢复状态'
        deps.registry.push(task, 'note', message)
        notes.push(message)
        reportCliUsage(params.usageSession, task)
      }
    }
    // Every terminal task closes its native record, including preflight errors.
    if (isTerminalPhase(task.phase)) {
      try {
        deps.childSessions?.settle({
          taskId: id,
          ok: task.phase === 'done',
          stats: task.stats,
          ...(resolvedRoute === undefined ? {} : { route: resolvedRoute }),
          ...(task.finalText === undefined ? {} : { finalText: task.finalText }),
        })
      } catch { deps.registry.push(task, 'note', '子会话结算不可用，父 CLI 账本继续结算') }
    }
    if (deps.settleUsage === undefined) reportCliUsage(params.usageSession, task)
    if (typeof task.stats?.['accountingState'] === 'string') notes.push(`accountingState: ${task.stats['accountingState']}`)
    // The claude native-skills staging tree dies with the run.
    if (stagedSkillsDir !== undefined) await deps.bridge?.discardStagedSkills(stagedSkillsDir)
    // And to disk, so the task board survives a host restart (best effort).
    try {
      deps.persist?.(task)
    } catch { /* the sink is best effort by contract; belt and braces */ }
    // 副作用队列：走到终态才清账；没走到终态的留着重试（进程被杀时这行
    // 根本到不了这里，正好被下次启动当成"没跑完"）。
    if (deps.effects !== undefined) {
      try {
        if (isTerminalPhase(task.phase)) await deps.effects.settle('launch', id)
        else await deps.effects.fail('launch', id, '派发未走到终态')
      } catch { deps.logger?.warn('副作用队列结算失败') }
    }
    // 健康条目：成功即清除；失败留一条人话，面板不翻日志也知道卡在哪。
    try {
      if (task.phase === 'done') deps.health?.clear()
      else if (task.phase === 'failed' || task.phase === 'timeout') deps.health?.set('degraded', `${decision.cli} 任务失败：${(task.error ?? '').slice(0, 200)}`)
    } catch { /* health is best effort */ }
  }
}
