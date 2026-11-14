/**
 * The codex channel: one non-interactive `codex exec --json` run. The task
 * text rides stdin (`codex exec -`), progress streams as JSONL thread/item
 * events, and the last `agent_message` item is the answer brought back to the
 * agent. The configured sandbox IS the permission axis of the run.
 */

import { fileURLToPath } from 'node:url'
import { runProcess, type ChildOutcome } from '../spawn.js'
import { bridgeNodeCommand } from '../bridge.js'
import { CODEX_REASONING_EFFORTS, type MaestroChannelEvent } from '../wire.js'
import type { CodexSandboxMode } from '../config.js'
import { mergeCodexUsageStats, startRolloutUsageTail, usageFromTotals, type RolloutUsageStats, type RolloutUsageTail } from './codex-rollout.js'

/** Parsed outcome of one codex run. */
export interface CodexRunResult {
  ok: boolean
  finalText: string
  threadId: string
  exitCode: number | null
  stderrTail: string
  stats: Record<string, string | number | boolean>
  error: string | undefined
}

/** Codex JSONL frames (thread/item dialect plus the legacy msg dialect). */
interface CodexFrame {
  type?: string
  thread_id?: string
  message?: string
  item?: {
    id?: string; type?: string; text?: string; message?: string; command?: string; aggregated_output?: string
    exit_code?: number | null; status?: string
    /** Modern MCP calls include public arguments/results, not just an item type. */
    server?: string; tool?: string; arguments?: unknown; result?: unknown; error?: unknown
    files?: Array<{ path?: string }>; changes?: Array<{ path?: string }>
    /** Reasoning items: streaming summaries (summary_text entries) and raw thoughts. */
    summary?: Array<{ type?: string; text?: string }>
    content?: Array<{ type?: string; text?: string }>
  }
  error?: { message?: string } | string
  usage?: { input_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number; output_tokens?: number }
  msg?: { type?: string; message?: string; content?: string }
}

/** Sandbox mode → `codex exec` flags. */
export function codexSandboxArgs(sandbox: CodexSandboxMode): string[] {
  // `--full-auto` is deprecated on current codex builds; the plain sandbox
  // flag is the non-interactive equivalent (exec never asks).
  if (sandbox === 'workspace-write') return ['--sandbox', 'workspace-write']
  if (sandbox === 'danger-full-access') return ['--dangerously-bypass-approvals-and-sandbox']
  return ['--sandbox', 'read-only']
}

/** Quote one value as a TOML basic string for `-c key=value` overrides. */
export function tomlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** Quote a key only when TOML's bare-key charset (`A-Za-z0-9_-`) rejects it. */
export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)
}

/**
 * Synthesized `model_providers` overrides that point codex at one dsh-configured
 * provider: the model, a `maestro_dsh` provider route (base URL + key via env
 * var) and the wire dialect. The key VALUE travels in the child env under
 * `envKey`, never on the command line.
 *
 * The dialect is always `responses`: codex ≥0.146 refuses to even parse a config
 * with `wire_api = "chat"` (`Error loading config.toml: \`wire_api = "chat"\` is
 * no longer supported`), and every dsh provider this channel can reach — whether
 * dsh declares it openai-responses or openai-completions — serves `/responses`
 * in practice, so there is no second dialect to offer.
 */
export function codexDshModelArgs(model: string, baseUrl: string): { args: string[]; envKey: string } {
  return {
    args: [
      '-c', `model=${tomlString(model)}`,
      '-c', 'model_provider=maestro_dsh',
      '-c', 'model_providers.maestro_dsh.name="dsh-maestro"',
      '-c', `model_providers.maestro_dsh.base_url=${tomlString(baseUrl)}`,
      '-c', 'model_providers.maestro_dsh.env_key="MAESTRO_DSH_PROVIDER_KEY"',
      '-c', 'model_providers.maestro_dsh.wire_api="responses"',
    ],
    envKey: 'MAESTRO_DSH_PROVIDER_KEY',
  }
}

/** The argv for one non-interactive run (before the resolved path is prepended). */
export function codexArgs(model: string, sandbox: CodexSandboxMode, configOverrides: readonly string[] = [], dshModel?: { model: string; baseUrl: string }, mcpServers?: ReadonlyArray<{ name: string; transport?: 'stdio' | 'http'; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }>, thinking?: string, resume?: string): string[] {
  // `codex exec resume <thread-id>` continues a prior non-interactive thread
  // and uses its own supported flag set; the prompt still rides stdin (`-`).
  const args = resume !== undefined && resume !== ''
    ? ['exec', 'resume', resume, '--json', '--skip-git-repo-check']
    : ['exec', '--json', '--skip-git-repo-check']
  if (dshModel !== undefined) {
    // A dsh-catalog model wins: the synthesized provider overrides pin the
    // model, route, base URL and key source, so no `-m` and no config edit.
    // A dsh route also never loads the operator's own `$CODEX_HOME/config.toml`:
    // that file pins a model + provider of its own (say `free/qwen3.8` behind a
    // private local router), agent hook binaries, plugins and MCP servers — none
    // of which belong to a dispatched task, and all of which take over the run
    // whenever this channel has no `-c` override to outrank them (that is how a
    // dispatch ended up on an unknown model and a 503 from the CLI's own router).
    // The overrides below plus env carry everything this run needs, so dropping
    // the user config only keeps the run deterministic.
    args.push('--ignore-user-config')
    // The provider pins are appended after every configurable override below.
    // ...but one key of the user config is load-bearing on Windows: codex runs
    // model commands through its own Windows sandbox, and with the default
    // (unelevated) policy every `exec_command` is refused — measured on this
    // host, the child got `Rejected(... blocked by policy)` for `pwsh`, `cmd`
    // and `bash` alike, i.e. a subagent that could not read a single file. The
    // operator's `[windows] sandbox = "elevated"` was doing exactly this job
    // before `--ignore-user-config` dropped it, so it is re-stated here (an
    // explicit `codexConfigOverrides` entry still wins, being appended later).
    args.push(...codexWindowsSandboxArgs())
  } else if (model !== '') {
    args.push('-m', model)
  }
  // The thinking level rides a regular `-c` override, ahead of the user's own
  // override list so an explicit `model_reasoning_effort` line there wins.
  // codex config-parses the value up front, so an unsupported key (the catalog
  // may declare `off`) must be skipped rather than passed through.
  if (thinking !== undefined && (CODEX_REASONING_EFFORTS as readonly string[]).includes(thinking)) {
    args.push('-c', `model_reasoning_effort=${tomlString(thinking)}`)
  }
  for (const override of configOverrides) {
    const trimmed = override.trim()
    if (trimmed !== '') args.push('-c', trimmed)
  }
  if (mcpServers !== undefined) args.push(...codexMcpArgs(mcpServers))
  if (resume !== undefined && resume !== '') {
    // Codex 0.165 exec resume has no --sandbox. The supported config override
    // preserves the selected policy; never turn workspace-write into bypass.
    args.push('-c', `sandbox_mode=${tomlString(sandbox)}`)
    args.push('-c', 'approval_policy="never"')
  } else args.push(...codexSandboxArgs(sandbox))
  // Pin the selected dsh endpoint AFTER untrusted/general config overrides.
  if (dshModel !== undefined) args.push(...codexDshModelArgs(dshModel.model, dshModel.baseUrl).args)
  // `-` reads the prompt from stdin — no quoting surface for task text.
  args.push('-')
  return args
}

/**
 * `-c windows.sandbox=...` restoring codex's Windows sandbox policy that
 * `--ignore-user-config` would otherwise drop. Only Windows has this knob; on
 * other platforms codex does not need it (and an unknown `windows.*` key would
 * just be noise).
 */
export function codexWindowsSandboxArgs(platform: string = process.platform): string[] {
  return platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : []
}

/**
 * Approval mode stamped onto every bridged MCP server: `approve` pre-approves
 * the server's tools so a non-interactive run can call them (see
 * {@link codexMcpArgs}). Legal values on codex 0.165: `auto`, `prompt`,
 * `writes`, `approve`.
 */
const CODEX_MCP_APPROVAL_MODE = 'approve'

/**
 * `-c mcp_servers.*` overrides handing dsh's MCP servers to codex. The whole
 * server record rides ONE TOML inline table per `-c` pair, so each server is
 * a single atomic override (no multi-pair ordering hazards).
 */
export function codexMcpArgs(servers: ReadonlyArray<{ name: string; transport?: 'stdio' | 'http'; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }>): string[] {
  const args: string[] = []
  for (const [index, server] of servers.entries()) {
    // `http` transport rows carry no command — codex cannot spawn them, and an
    // empty `command = ""` would make codex reject the whole override.
    if (server.transport === 'http' || server.command.trim() === '') continue
    const keys = Object.keys(server.env)
    const aliases = keys.map((_, keyIndex) => mcpSecretAlias(index, keyIndex))
    // Codex env_vars copies named environment values, it does not interpolate TOML.
    // Each server gets disjoint aliases; the shim restores only its own key names.
    const command = keys.length === 0 ? server.command : bridgeNodeCommand()
    const serverArgs = keys.length === 0 ? server.args : [fileURLToPath(new URL('../mcp-env-shim.js', import.meta.url)), JSON.stringify({ command: server.command, args: server.args, keys, aliases })]
    const parts = [`command = ${tomlString(command)}`]
    if (serverArgs.length > 0) parts.push(`args = [${serverArgs.map(tomlString).join(', ')}]`)
    if (aliases.length > 0) parts.push(`env_vars = [${aliases.map(tomlString).join(', ')}]`)
    // `codex exec` is non-interactive: its approval policy is `never`, so an MCP
    // tool call that asks for approval can never be granted and every bridge
    // call dies with `MCP tool call requires approval, but approval policy is
    // never`. These servers are dsh's own tool surface (already granted to every
    // claude dispatch through `--allowedTools`), so pre-approve them per server.
    // Legal values on codex 0.165: `auto`, `prompt`, `writes`, `approve`.
    parts.push(`default_tools_approval_mode = ${tomlString(CODEX_MCP_APPROVAL_MODE)}`)
    // Names come from user config and may contain `.` or spaces; a bare dotted
    // key would be parsed as a nested path, so quote only when necessary.
    // No spaces around the top-level `=`: codex splits `-c key=value` on the
    // first `=` and an untrimmed key would silently miss the override.
    args.push('-c', `mcp_servers.${tomlKey(server.name)}={ ${parts.join(', ')} }`)
  }
  return args
}

export function mcpSecretAlias(serverIndex: number, keyIndex: number): string {
  return 'MAESTRO_MCP_SECRET_' + String(serverIndex) + '_' + String(keyIndex)
}

/** Values travel only in the Codex process environment; never argv or disk. */
export function codexMcpEnv(servers: Parameters<typeof codexMcpArgs>[0]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [index, server] of servers.entries()) {
    if (server.transport === 'http' || server.command.trim() === '') continue
    Object.values(server.env).forEach((value, keyIndex) => { env[mcpSecretAlias(index, keyIndex)] = value })
  }
  return env
}

/** Environment overlays for pointing codex at an OpenAI-compatible provider. */
export function codexEnv(baseUrl: string, apiKey: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (baseUrl !== '') env['OPENAI_BASE_URL'] = baseUrl
  if (apiKey !== '') env['OPENAI_API_KEY'] = apiKey
  return env
}

const COMMAND_OUTPUT_LIMIT = 6000

/** Keep the beginning and the diagnostic tail; never truncate final answers. */
function commandOutputPreview(output: string): string {
  if (output.length <= COMMAND_OUTPUT_LIMIT) return output
  const headLength = 2000
  const tailLength = COMMAND_OUTPUT_LIMIT - headLength
  return `${output.slice(0, headLength)}\n…[省略 ${output.length - COMMAND_OUTPUT_LIMIT} 字符]…\n${output.slice(-tailLength)}`
}

function frameErrorMessage(frame: CodexFrame): string {
  const message = typeof frame.error === 'string' ? frame.error : frame.error?.message
  return message?.trim() ? message : frame.message?.trim() ? frame.message : frame.type === 'turn.failed' ? 'turn failed' : 'codex stream error'
}

function commandFailed(item: NonNullable<CodexFrame['item']>): boolean {
  // A numeric exit code is authoritative; diagnostic output containing the
  // word "error" (or an ACL query) must not turn a successful command red.
  return typeof item.exit_code === 'number' ? item.exit_code !== 0 : item.status === 'failed' || item.status === 'declined'
}

function commandSummary(item: NonNullable<CodexFrame['item']>, preview: boolean): string {
  const failed = commandFailed(item)
  const label = failed ? '命令失败' : typeof item.exit_code === 'number' || item.status === 'completed' ? '命令完成' : '命令结束'
  const suffix = typeof item.exit_code === 'number' ? `（退出码 ${item.exit_code}）` : ''
  const status = item.status === undefined ? '' : `，状态 ${item.status}`
  const output = item.aggregated_output ?? ''
  return `${label} ${item.command ?? '?'}${suffix}${status}${output.trim() === '' ? '' : `\n输出：\n${preview ? commandOutputPreview(output) : output}`}`
}

function publicToolDetail(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, (key: string, entry: unknown): unknown => {
      if (/^(?:(?:access|refresh|bridge)[_-]?)?token$|^(?:api[_-]?key|authorization|proxy-authorization|password|secret|cookie|set-cookie)$/i.test(key)) return '[redacted]'
      if (typeof entry === 'string') return entry.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
        .replace(/([?&](?:token|api[_-]?key|access_token|bridge_token)=)[^&#\s"']+/gi, '$1[redacted]')
      if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
        const row = entry as Record<string, unknown>
        if ((row['type'] === 'image' || row['type'] === 'audio') && typeof row['data'] === 'string') {
          return { ...row, data: '[binary payload omitted; text and resource references retained]' }
        }
      }
      return entry
    }, 2) ?? ''
  } catch { return '[工具详情无法序列化]' }
}

function codexMcpEvent(item: NonNullable<CodexFrame['item']>, started: boolean): MaestroChannelEvent {
  const name = `${item.server ?? 'mcp'}/${item.tool ?? '?'}`
  const result = item.result !== null && typeof item.result === 'object' ? item.result as Record<string, unknown> : undefined
  const failed = item.status === 'failed' || item.error != null || result?.['isError'] === true || result?.['is_error'] === true
  const detail = [
    `调用 ID：${item.id ?? '?'}；状态：${item.status ?? (started ? 'in_progress' : 'completed')}`,
    item.arguments === undefined ? '' : `参数：\n${publicToolDetail(item.arguments)}`,
    item.result === undefined ? '' : `结果：\n${publicToolDetail(item.result)}`,
    item.error == null ? '' : `错误：\n${publicToolDetail(item.error)}`,
  ].filter(Boolean).join('\n\n')
  return { kind: failed ? 'error' : started ? 'tool' : 'result', text: `MCP ${name}${failed ? ' · 失败' : ''}`, detail }
}

function codexFrameOf(raw: unknown): CodexFrame | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const frame = { ...raw } as Record<string, unknown>
  for (const key of ['type', 'thread_id', 'message']) if (typeof frame[key] !== 'string') delete frame[key]
  for (const key of ['item', 'usage', 'msg']) {
    const value = frame[key]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) { delete frame[key]; continue }
    const record = { ...value } as Record<string, unknown>
    if (key !== 'usage') {
      for (const field of ['id', 'type', 'text', 'message', 'command', 'aggregated_output', 'status', 'content', 'server', 'tool']) {
        if (field === 'content' && key === 'item') continue
        if (typeof record[field] !== 'string') delete record[field]
      }
      if (key === 'item') for (const field of ['files', 'changes', 'summary', 'content']) {
        const entries = record[field]
        if (!Array.isArray(entries)) { delete record[field]; continue }
        record[field] = entries.filter(entry => typeof entry === 'object' && entry !== null && !Array.isArray(entry)).map(entry => {
          const safe = { ...entry } as Record<string, unknown>
          for (const textField of ['path', 'text', 'type']) if (typeof safe[textField] !== 'string') delete safe[textField]
          return safe
        })
      }
    }
    frame[key] = record
  }
  const error = frame['error']
  if (typeof error !== 'string') frame['error'] = typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>)['message'] === 'string'
    ? { message: (error as Record<string, unknown>)['message'] } : undefined
  return frame as CodexFrame
}

/** Extract progress facts out of one JSONL frame. */
export function codexFrameEvents(frame: CodexFrame): MaestroChannelEvent[] {
  frame = codexFrameOf(frame) ?? {}
  const events: MaestroChannelEvent[] = []
  // Modern thread/item dialect.
  if (frame.type === 'thread.started') return events
  if (frame.type === 'item.started' || frame.type === 'item.updated' || frame.type === 'item.completed') {
    const item = frame.item ?? {}
    if (item.type === 'command_execution') {
      // updated frames repeat an accumulating output snapshot. The completed
      // item contains the full aggregate, so emit it once, not on every update.
      if (frame.type === 'item.started') {
        events.push({ kind: 'tool', text: item.command ?? '?', detail: '命令开始 (started)' })
      } else if (frame.type === 'item.completed') {
        events.push({ kind: 'tool', text: item.command ?? '?', detail: commandSummary(item, true) })
      }
    } else if (item.type === 'mcp_tool_call') {
      if (frame.type !== 'item.updated') events.push(codexMcpEvent(item, frame.type === 'item.started'))
    } else if (item.type === 'file_change') {
      const paths = (item.changes ?? item.files ?? []).map(file => file.path ?? '?').join(', ')
      events.push({ kind: item.status === 'failed' ? 'error' : 'note', text: `文件变更 ${item.status ?? ''} ${paths}`.trim() })
    } else if (item.type === 'reasoning' && frame.type === 'item.completed') {
      // 标准 exec JSONL 公开摘要在 text；兼容旧 summary/content 数组：
      // 会话页折叠成「思考过程」行。
      const summary = (item.summary ?? []).map(entry => entry.text ?? '').join('\n').trim()
      const raw = (item.content ?? []).map(entry => entry.text ?? '').join('\n').trim()
      const body = (item.text ?? '').trim() || summary || raw
      if (body !== '') events.push({ kind: 'thinking', text: body })
    } else if (item.type === 'agent_message' && frame.type === 'item.completed' && (item.text ?? '').trim() !== '') {
      events.push({ kind: 'text', text: item.text ?? '' })
    } else if (item.type === 'error' && frame.type !== 'item.updated') {
      const message = item.message?.trim() ? item.message : item.text
      if (message?.trim()) events.push({ kind: 'error', text: message })
    } else if (item.type !== undefined && item.type !== 'reasoning' && frame.type === 'item.started') {
      // Unknown item kinds (subagent spawns, MCP calls, …) stay visible.
      events.push({ kind: 'note', text: `codex item: ${item.type}` })
    }
    return events
  }
  if (frame.type === 'turn.completed') return events
  if (frame.type === 'turn.failed' || frame.type === 'error') {
    events.push({ kind: 'error', text: frameErrorMessage(frame) })
    return events
  }
  // Legacy msg dialect (older codex builds).
  if (frame.msg?.type === 'agent_message' && (frame.msg.message ?? '').trim() !== '') {
    events.push({ kind: 'text', text: frame.msg.message ?? '' })
  }
  return events
}

/** The stats a completed turn reports. */
export function codexUsageStats(frame: CodexFrame): Record<string, string | number | boolean> {
  frame = codexFrameOf(frame) ?? {}
  return { ...usageFromTotals(frame.usage) }
}

/**
 * Run one codex task to completion. `onEvent` surfaces progress as frames
 * arrive; the promise settles when the child exits.
 */
export async function runCodexTask(options: {
  spawnFn?: Parameters<typeof runProcess>['0']['spawnFn']
  codexPath: string
  task: string
  cwd: string | undefined
  model: string
  sandbox: CodexSandboxMode
  /** Configured thinking level ('' = CLI default); rides model_reasoning_effort. */
  thinking?: string
  /** Continue a prior non-interactive thread (its thread_id). */
  resume?: string
  configOverrides?: readonly string[]
  dshModel?: { model: string; baseUrl: string; apiKey: string }
  mcpServers?: ReadonlyArray<{ name: string; transport?: 'stdio' | 'http'; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }>
  baseUrl: string
  apiKey: string
  timeoutMs: number
  signal: AbortSignal
  onEvent: (kind: MaestroChannelEvent['kind'], text: string, detail?: string) => void
  /** Running usage snapshot, one call per frame that carries counts. */
  onUsage?: (stats: Record<string, string | number | boolean>) => void
}): Promise<CodexRunResult> {
  const args = codexArgs(options.model, options.sandbox, options.configOverrides ?? [], options.dshModel === undefined ? undefined : { model: options.dshModel.model, baseUrl: options.dshModel.baseUrl }, options.mcpServers, options.thinking, options.resume)
  // Same skip rule as codexArgs; surface it so a silently dropped level is visible.
  if (options.thinking !== undefined && options.thinking !== '' && !(CODEX_REASONING_EFFORTS as readonly string[]).includes(options.thinking)) {
    options.onEvent('note', `思考档位 "${options.thinking}" 不受 codex model_reasoning_effort 支持，已忽略（沿用 CLI 默认）`)
  }
  const env = { ...codexEnv(options.baseUrl, options.apiKey), ...codexMcpEnv(options.mcpServers ?? []) }
  if (options.dshModel !== undefined) env['MAESTRO_DSH_PROVIDER_KEY'] = options.dshModel.apiKey

  let finalText = ''
  let threadId = ''
  let turnStatus: 'completed' | 'failed' | undefined
  let pendingStreamError = false
  let protocolStreamFailed = false
  const failureReasons: string[] = []
  let stats: RolloutUsageStats = {}
  const reconnectController = new AbortController()
  const processSignal = AbortSignal.any([options.signal, reconnectController.signal])
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectTimedOut = false
  const reconnectFailure = `Codex 持续重连 ${String(Math.round(options.timeoutMs / 1000))} 秒仍未恢复，已请求终止进程（重连日志不会延长等待）`
  const clearReconnect = (): void => {
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }
  const observeReconnect = (message: string): void => {
    if (!/\breconnecting\b/i.test(message) || reconnectTimer !== undefined || processSignal.aborted) return
    // A separate recovery deadline: repeated diagnostics must not keep a
    // broken connection alive forever by resetting the byte-idle watchdog.
    reconnectTimer = setTimeout(() => {
      if (processSignal.aborted) return
      reconnectTimedOut = true
      reconnectController.abort()
      options.onEvent('error', reconnectFailure)
    }, options.timeoutMs)
    options.onEvent('note', `Codex 正在重连；若持续 ${String(Math.round(options.timeoutMs / 1000))} 秒未恢复，将按超时结束`)
  }

  // `codex exec` only reports usage on `turn.completed`, but the CLI appends a
  // `token_count` row to its rollout transcript after every model response
  // (see codex-rollout.ts). Tailing that file keeps the board live; the
  // turn-level numbers fill gaps until the last transcript drain settles totals.
  let liveUsage: RolloutUsageStats = {}
  let usageTail: RolloutUsageTail | undefined
  const startUsageTail = (thread: string): void => {
    if (usageTail !== undefined) return
    usageTail = startRolloutUsageTail({
      threadId: thread,
      resume: options.resume === thread,
      onUsage: usage => {
        liveUsage = usage
        options.onUsage?.({ ...mergeCodexUsageStats(liveUsage, stats) })
      },
      onWarning: message => {
        liveUsage = {}
        options.onEvent('note', message)
      },
    })
  }

  const handleLine = (line: string): void => {
    let frame: CodexFrame
    try {
      const parsed = codexFrameOf(JSON.parse(line))
      if (parsed === undefined) return
      frame = parsed
    } catch {
      if (line.trim().startsWith('{')) return
      observeReconnect(line)
      options.onEvent('note', line.slice(0, 300))
      return
    }
    if (frame.type === 'error' || frame.type === 'turn.failed') observeReconnect(frameErrorMessage(frame))
    else if (frame.item?.type === 'error') observeReconnect(frame.item.message ?? frame.item.text ?? '')
    else if (frame.msg?.type === 'error') observeReconnect(frame.msg.message ?? '')
    else if (frame.type === 'turn.completed'
      || (['item.started', 'item.updated', 'item.completed'].includes(frame.type ?? '')
        && ['command_execution', 'mcp_tool_call', 'file_change', 'reasoning', 'agent_message'].includes(frame.item?.type ?? ''))
      || (frame.msg?.type === 'agent_message' && (frame.msg.message ?? '').trim() !== '')) clearReconnect()
    if (frame.thread_id !== undefined && threadId === '') {
      threadId = frame.thread_id
      startUsageTail(threadId)
    }
    for (const event of codexFrameEvents(frame)) {
      options.onEvent(event.kind, event.text, event.detail)
      // 失败命令的事件本体是 tool 行（会话页折叠展示），失败归因在这里补。
      if (frame.type === 'item.completed' && frame.item?.type === 'command_execution' && commandFailed(frame.item)) {
        // Progress previews are bounded; the returned failure retains the full
        // command diagnostic if the overall run ultimately fails.
        failureReasons.push(commandSummary(frame.item, false))
      } else if (event.kind === 'error') {
        failureReasons.push(event.text)
      }
    }
    if (frame.type === 'item.completed' && frame.item?.type === 'agent_message' && (frame.item.text ?? '').trim() !== '') {
      finalText = frame.item.text ?? ''
    }
    if (frame.msg?.type === 'agent_message' && (frame.msg.message ?? '').trim() !== '') finalText = frame.msg.message ?? ''
    // Keep real usage even if this frame/run fails; never infer it from logs.
    const usageDelta = usageFromTotals(frame.usage) ?? {}
    if (Object.keys(usageDelta).length > 0) {
      stats = mergeCodexUsageStats(usageDelta, stats)
      options.onUsage?.({ ...mergeCodexUsageStats(liveUsage, stats) })
    }
    if (frame.type === 'turn.completed') {
      // One exec request owns one terminal turn. A failed terminal cannot be
      // rehabilitated by a later completion; individual tool/stream retries can.
      if (turnStatus !== 'failed') turnStatus = 'completed'
      // Some builds emit top-level errors during reconnects. A subsequent
      // completed turn is positive recovery evidence, not a failed task.
      pendingStreamError = false
    }
    if (frame.type === 'turn.failed') turnStatus = 'failed'
    if (frame.type === 'error') pendingStreamError = true
  }

  if (options.resume !== undefined && options.resume !== '' && !options.signal.aborted) startUsageTail(options.resume)

  let ended: ChildOutcome
  try {
    const { child, outcome } = runProcess({
      ...(options.spawnFn === undefined ? {} : { spawnFn: options.spawnFn }),
      file: options.codexPath,
      args,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(Object.keys(env).length === 0 ? {} : { env }),
      stdin: options.task,
      environmentPolicy: 'scrub',
      timeoutMs: options.timeoutMs,
      timeoutMode: 'idle',
      onTimeoutWarning: remainingMs => {
        options.onEvent('note', `CLI 已连续无 stdout/stderr 输出；若仍无输出，将在约 ${String(Math.round(remainingMs / 1000))} 秒后超时终止（无输出保护，不代表任务语义进展）`)
      },
      signal: processSignal,
      onStdoutLine: handleLine,
      // stderr is diagnostics, not protocol — surface it while the run is active.
      onStderrLine: (line: string) => {
        observeReconnect(line)
        options.onEvent('note', `stderr: ${line.slice(0, 300)}`)
      },
    })
    const onProtocolStreamError = (): void => { protocolStreamFailed = true }
    child.stdout?.on('error', onProtocolStreamError)
    ended = await outcome.finally(() => { child.stdout?.removeListener('error', onProtocolStreamError) })
  } finally {
    clearReconnect()
    usageTail?.stop()
  }

  const timedOut = ended.timedOut || reconnectTimedOut
  const runStats: Record<string, string | number | boolean> = { ...mergeCodexUsageStats(liveUsage, stats), usageNormalization: 'codex-turn-delta-v2' }
  if (threadId !== '') runStats['threadId'] = threadId
  if (timedOut) runStats['timedOut'] = true
  if (reconnectTimedOut) runStats['reconnectTimedOut'] = true
  // Individual tool errors are recoverable. Exec JSONL's turn.completed is
  // authoritative; legacy msg text remains visible but supplies no independent
  // completion contract. Do not infer completion from a message or exit 0.
  const noAnswer = finalText.trim() === ''
  const ok = !timedOut && !options.signal.aborted && ended.code === 0 && !protocolStreamFailed && turnStatus === 'completed' && !pendingStreamError && !noAnswer
  if (!ok) {
    if (reconnectTimedOut) failureReasons.push(reconnectFailure)
    else if (ended.timedOut) failureReasons.push(`连续无 stdout/stderr 输出 ${String(Math.round(options.timeoutMs / 1000))} 秒超时，进程已被终止（无输出保护，不代表任务语义进展）`)
    else if (options.signal.aborted) failureReasons.push('任务已取消，进程已被终止')
    if (ended.code !== 0) failureReasons.push(`进程退出码 ${ended.code ?? 'null'}`)
    if (protocolStreamFailed) failureReasons.push('Codex CLI stdout 协议流失败（输出完整性未确认）')
    if (noAnswer) failureReasons.push('Codex CLI 未返回最终答复（缺少非空 agent_message）')
    if (turnStatus === undefined && !noAnswer && !pendingStreamError) failureReasons.push('Codex CLI 未返回成功终态（缺少 turn.completed）')
    if (ended.stderrTail.trim() !== '') failureReasons.push(`stderr：\n${ended.stderrTail}`)
  }
  return {
    ok,
    finalText,
    threadId,
    exitCode: ended.code,
    stderrTail: ended.stderrTail,
    stats: runStats,
    error: ok ? undefined : [...new Set(failureReasons)].join('\n\n'),
  }
}
