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
  item?: { type?: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number; status?: string; files?: Array<{ path?: string }> }
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
export function codexArgs(model: string, sandbox: CodexSandboxMode, configOverrides: readonly string[] = [], dshModel?: { model: string; baseUrl: string; wireApi: 'responses' | 'chat' }): string[] {
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
  args.push(...codexSandboxArgs(sandbox))
  // `-` reads the prompt from stdin — no quoting surface for task text.
  args.push('-')
  return args
}

/** Environment overlays for pointing codex at an OpenAI-compatible provider. */
export function codexEnv(baseUrl: string, apiKey: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (baseUrl !== '') env['OPENAI_BASE_URL'] = baseUrl
  if (apiKey !== '') env['OPENAI_API_KEY'] = apiKey
  return env
}

/** Extract progress facts out of one JSONL frame. */
export function codexFrameEvents(frame: CodexFrame): Array<{ kind: 'text' | 'note' | 'error'; text: string }> {
  const events: Array<{ kind: 'text' | 'note' | 'error'; text: string }> = []
  // Modern thread/item dialect.
  if (frame.type === 'thread.started') return events
  if (frame.type === 'item.started' || frame.type === 'item.updated' || frame.type === 'item.completed') {
    const item = frame.item ?? {}
    if (item.type === 'command_execution' && item.command !== undefined) {
      const suffix = frame.type === 'item.completed' && typeof item.exit_code === 'number' ? `（退出码 ${item.exit_code}）` : ''
      events.push({ kind: 'note', text: `命令 ${item.command}${suffix}` })
    } else if (item.type === 'file_change') {
      const paths = (item.files ?? []).map(file => file.path ?? '?').join(', ')
      events.push({ kind: 'note', text: `文件变更 ${item.status ?? ''} ${paths}`.trim() })
    } else if (item.type === 'agent_message' && frame.type === 'item.completed' && (item.text ?? '').trim() !== '') {
      events.push({ kind: 'text', text: item.text ?? '' })
    } else if (item.type === 'error' && (item.text ?? '').trim() !== '') {
      events.push({ kind: 'error', text: item.text ?? '' })
    }
    return events
  }
  if (frame.type === 'turn.completed') return events
  if (frame.type === 'turn.failed') {
    const message = typeof frame.error === 'string' ? frame.error : frame.error?.message ?? 'turn failed'
    events.push({ kind: 'error', text: message })
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
  baseUrl: string
  apiKey: string
  timeoutMs: number
  signal: AbortSignal
  onEvent: (kind: 'text' | 'note' | 'error', text: string) => void
}): Promise<CodexRunResult> {
  const args = codexArgs(options.model, options.sandbox, options.configOverrides ?? [], options.dshModel === undefined ? undefined : { model: options.dshModel.model, baseUrl: options.dshModel.baseUrl, wireApi: options.dshModel.wireApi })
  const env = codexEnv(options.baseUrl, options.apiKey)
  if (options.dshModel !== undefined) env['MAESTRO_DSH_PROVIDER_KEY'] = options.dshModel.apiKey

  let finalText = ''
  let threadId = ''
  let turnFailed: string | undefined
  let stats: Record<string, string | number | boolean> = {}

  const handleLine = (line: string): void => {
    let frame: CodexFrame
    try {
      frame = JSON.parse(line) as CodexFrame
    } catch {
      if (line.trim().startsWith('{')) return
      options.onEvent('note', line.slice(0, 300))
      return
    }
    if (frame.thread_id !== undefined && threadId === '') threadId = frame.thread_id
    for (const event of codexFrameEvents(frame)) options.onEvent(event.kind, event.text)
    if (frame.type === 'item.completed' && frame.item?.type === 'agent_message' && (frame.item.text ?? '').trim() !== '') {
      finalText = frame.item.text ?? ''
    }
    if (frame.msg?.type === 'agent_message' && (frame.msg.message ?? '').trim() !== '') finalText = frame.msg.message ?? ''
    if (frame.type === 'turn.completed') stats = { ...stats, ...codexUsageStats(frame) }
    if (frame.type === 'turn.failed') {
      turnFailed = typeof frame.error === 'string' ? frame.error : frame.error?.message ?? 'turn failed'
    }
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
  })
  const ended = await outcome

  const runStats = { ...stats }
  if (threadId !== '') runStats['threadId'] = threadId
  if (ended.timedOut) runStats['timedOut'] = true
  const ok = !ended.timedOut && ended.code === 0 && turnFailed === undefined && finalText.trim() !== ''
  return {
    ok,
    finalText,
    threadId,
    exitCode: ended.code,
    stderrTail: ended.stderrTail,
    stats: runStats,
    error: turnFailed
      ?? (ended.timedOut ? '任务超时，进程已被终止' : undefined)
      ?? (ended.code === 0 ? undefined : `进程退出码 ${ended.code ?? 'null'}${ended.stderrTail.trim() === '' ? '' : `：${ended.stderrTail.split(/\r?\n/).filter(l => l.trim() !== '').slice(-4).join(' | ')}`}`),
  }
}
