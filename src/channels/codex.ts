/**
 * The codex channel: one non-interactive `codex exec --json` run. The task
 * text rides stdin (`codex exec -`), progress streams as JSONL thread/item
 * events, and the last `agent_message` item is the answer brought back to the
 * agent. The configured sandbox IS the permission axis of the run.
 */

import { runProcess } from '../spawn.js'
import type { CodexSandboxMode } from '../config.js'

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
  item?: { id?: string; type?: string; text?: string; message?: string; command?: string; aggregated_output?: string; exit_code?: number | null; status?: string; files?: Array<{ path?: string }>; changes?: Array<{ path?: string }> }
  error?: { message?: string } | string
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
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
 */
export function codexDshModelArgs(model: string, baseUrl: string, wireApi: 'responses' | 'chat'): { args: string[]; envKey: string } {
  return {
    args: [
      '-c', `model=${tomlString(model)}`,
      '-c', 'model_provider=maestro_dsh',
      '-c', 'model_providers.maestro_dsh.name="dsh-maestro"',
      '-c', `model_providers.maestro_dsh.base_url=${tomlString(baseUrl)}`,
      '-c', 'model_providers.maestro_dsh.env_key="MAESTRO_DSH_PROVIDER_KEY"',
      '-c', `model_providers.maestro_dsh.wire_api=${tomlString(wireApi)}`,
    ],
    envKey: 'MAESTRO_DSH_PROVIDER_KEY',
  }
}

/** The argv for one non-interactive run (before the resolved path is prepended). */
export function codexArgs(model: string, sandbox: CodexSandboxMode, configOverrides: readonly string[] = [], dshModel?: { model: string; baseUrl: string; wireApi: 'responses' | 'chat' }, mcpServers?: ReadonlyArray<{ name: string; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }>): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check']
  if (dshModel !== undefined) {
    // A dsh-catalog model wins: the synthesized provider overrides pin the
    // model, route, base URL and key source, so no `-m` and no config edit.
    args.push(...codexDshModelArgs(dshModel.model, dshModel.baseUrl, dshModel.wireApi).args)
  } else if (model !== '') {
    args.push('-m', model)
  }
  for (const override of configOverrides) {
    const trimmed = override.trim()
    if (trimmed !== '') args.push('-c', trimmed)
  }
  if (mcpServers !== undefined) args.push(...codexMcpArgs(mcpServers))
  args.push(...codexSandboxArgs(sandbox))
  // `-` reads the prompt from stdin — no quoting surface for task text.
  args.push('-')
  return args
}

/**
 * `-c mcp_servers.*` overrides handing dsh's MCP servers to codex. The whole
 * server record rides ONE TOML inline table per `-c` pair, so each server is
 * a single atomic override (no multi-pair ordering hazards).
 */
export function codexMcpArgs(servers: ReadonlyArray<{ name: string; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }>): string[] {
  const args: string[] = []
  for (const server of servers) {
    // `http` transport rows carry no command — codex cannot spawn them, and an
    // empty `command = ""` would make codex reject the whole override.
    if (server.command.trim() === '') continue
    const parts = [`command = ${tomlString(server.command)}`]
    if (server.args.length > 0) parts.push(`args = [${server.args.map(tomlString).join(', ')}]`)
    const envEntries = Object.entries(server.env)
    if (envEntries.length > 0) {
      parts.push(`env = { ${envEntries.map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(', ')} }`)
    }
    // Names come from user config and may contain `.` or spaces; a bare dotted
    // key would be parsed as a nested path, so quote only when necessary.
    args.push('-c', `mcp_servers.${tomlKey(server.name)} = { ${parts.join(', ')} }`)
  }
  return args
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
  return `${label} (completed) ${item.command ?? '?'}${suffix}${status}${output.trim() === '' ? '' : `\n输出：\n${preview ? commandOutputPreview(output) : output}`}`
}

/** Extract progress facts out of one JSONL frame. */
export function codexFrameEvents(frame: CodexFrame): Array<{ kind: 'text' | 'note' | 'error'; text: string }> {
  const events: Array<{ kind: 'text' | 'note' | 'error'; text: string }> = []
  // Modern thread/item dialect.
  if (frame.type === 'thread.started') return events
  if (frame.type === 'item.started' || frame.type === 'item.updated' || frame.type === 'item.completed') {
    const item = frame.item ?? {}
    if (item.type === 'command_execution') {
      // updated frames repeat an accumulating output snapshot. The completed
      // item contains the full aggregate, so emit it once, not on every update.
      if (frame.type === 'item.started') {
        events.push({ kind: 'note', text: `命令开始 (started) ${item.command ?? '?'}` })
      } else if (frame.type === 'item.completed') {
        events.push({ kind: commandFailed(item) ? 'error' : 'note', text: commandSummary(item, true) })
      }
    } else if (item.type === 'file_change') {
      const paths = (item.changes ?? item.files ?? []).map(file => file.path ?? '?').join(', ')
      events.push({ kind: item.status === 'failed' ? 'error' : 'note', text: `文件变更 ${item.status ?? ''} ${paths}`.trim() })
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
  const stats: Record<string, string | number | boolean> = {}
  const usage = frame.usage
  if (usage === undefined) return stats
  if (typeof usage.input_tokens === 'number') stats['inputTokens'] = usage.input_tokens
  if (typeof usage.cached_input_tokens === 'number') stats['cachedInputTokens'] = usage.cached_input_tokens
  if (typeof usage.output_tokens === 'number') stats['outputTokens'] = usage.output_tokens
  return stats
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
  configOverrides?: readonly string[]
  dshModel?: { model: string; baseUrl: string; apiKey: string; wireApi: 'responses' | 'chat' }
  mcpServers?: ReadonlyArray<{ name: string; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }>
  baseUrl: string
  apiKey: string
  timeoutMs: number
  signal: AbortSignal
  onEvent: (kind: 'text' | 'note' | 'error', text: string) => void
}): Promise<CodexRunResult> {
  const args = codexArgs(options.model, options.sandbox, options.configOverrides ?? [], options.dshModel === undefined ? undefined : { model: options.dshModel.model, baseUrl: options.dshModel.baseUrl, wireApi: options.dshModel.wireApi }, options.mcpServers)
  const env = codexEnv(options.baseUrl, options.apiKey)
  if (options.dshModel !== undefined) env['MAESTRO_DSH_PROVIDER_KEY'] = options.dshModel.apiKey

  let finalText = ''
  let threadId = ''
  let turnStatus: 'completed' | 'failed' | undefined
  let pendingStreamError = false
  const failureReasons: string[] = []
  let stats: Record<string, string | number | boolean> = {}

  const handleLine = (line: string): void => {
    let frame: CodexFrame
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      frame = parsed as CodexFrame
    } catch {
      if (line.trim().startsWith('{')) return
      options.onEvent('note', line.slice(0, 300))
      return
    }
    if (frame.thread_id !== undefined && threadId === '') threadId = frame.thread_id
    for (const event of codexFrameEvents(frame)) {
      options.onEvent(event.kind, event.text)
      if (event.kind === 'error') {
        // Progress previews are bounded; the returned failure retains the full
        // command diagnostic if the overall run ultimately fails.
        failureReasons.push(frame.item?.type === 'command_execution' ? commandSummary(frame.item, false) : event.text)
      }
    }
    if (frame.type === 'item.completed' && frame.item?.type === 'agent_message' && (frame.item.text ?? '').trim() !== '') {
      finalText = frame.item.text ?? ''
    }
    if (frame.msg?.type === 'agent_message' && (frame.msg.message ?? '').trim() !== '') finalText = frame.msg.message ?? ''
    if (frame.type === 'turn.completed') {
      stats = { ...stats, ...codexUsageStats(frame) }
      turnStatus = 'completed'
      // Some builds emit top-level errors during reconnects. A subsequent
      // completed turn is positive recovery evidence, not a failed task.
      pendingStreamError = false
    }
    if (frame.type === 'turn.failed') turnStatus = 'failed'
    if (frame.type === 'error') pendingStreamError = true
  }

  const { outcome } = runProcess({
    ...(options.spawnFn === undefined ? {} : { spawnFn: options.spawnFn }),
    file: options.codexPath,
    args,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
    stdin: options.task,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onStdoutLine: handleLine,
    // stderr is diagnostics, not protocol — surface it as notes so a hung or
    // failing run is visible while it runs, not only in the final error string.
    onStderrLine: (line: string) => { options.onEvent('note', `stderr: ${line.slice(0, 300)}`) },
  })
  const ended = await outcome

  const runStats = { ...stats }
  if (threadId !== '') runStats['threadId'] = threadId
  if (ended.timedOut) runStats['timedOut'] = true
  // Individual tool errors are recoverable. Final turn/stream state, process
  // exit, and an actual answer decide whether this CLI task returned a result.
  const noAnswer = finalText.trim() === ''
  const ok = !ended.timedOut && !options.signal.aborted && ended.code === 0 && turnStatus !== 'failed' && !pendingStreamError && !noAnswer
  if (!ok) {
    if (ended.timedOut) failureReasons.push('任务超时，进程已被终止')
    else if (options.signal.aborted) failureReasons.push('任务已取消，进程已被终止')
    if (ended.code !== 0) failureReasons.push(`进程退出码 ${ended.code ?? 'null'}`)
    if (noAnswer) failureReasons.push('Codex CLI 未返回最终答复（缺少非空 agent_message）')
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
