/**
 * The claude channel: one headless `claude -p` run over the stream-json wire.
 * The task text rides stdin (never argv), progress events stream out line by
 * line, and the final `result` frame carries the answer back to the agent.
 */

import { runProcess } from '../spawn.js'
import type { ClaudePermissionMode } from '../config.js'

/** Parsed outcome of one claude run. */
export interface ClaudeRunResult {
  ok: boolean
  finalText: string
  sessionId: string
  exitCode: number | null
  stderrTail: string
  stats: Record<string, string | number | boolean>
  error: string | undefined
}

/** Claude stream-json frames this channel understands (fields it reads only). */
interface ClaudeFrame {
  type?: string
  subtype?: string
  session_id?: string
  model?: string
  cwd?: string
  result?: string
  is_error?: boolean
  num_turns?: number
  duration_ms?: number
  duration_api_ms?: number
  total_cost_usd?: number
  message?: { content?: Array<{ type?: string; text?: string; name?: string }> }
}

/** `--permission-mode` value for the configured mode; `inherit` sends none. */
export function claudePermissionArgs(permissionMode: ClaudePermissionMode): string[] {
  if (permissionMode === 'inherit' || permissionMode === 'default') return []
  if (permissionMode === 'bypassPermissions') return ['--dangerously-skip-permissions']
  return ['--permission-mode', permissionMode]
}

/** The argv for one headless run (before the resolved path is prepended). */
export function claudeArgs(model: string, permissionMode: ClaudePermissionMode): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose']
  if (model !== '') args.push('--model', model)
  args.push(...claudePermissionArgs(permissionMode))
  return args
}

/** Environment overlays for pointing claude at a dsh-configured provider. */
export function claudeEnv(baseUrl: string, authToken: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (baseUrl !== '') env['ANTHROPIC_BASE_URL'] = baseUrl
  if (authToken !== '') env['ANTHROPIC_AUTH_TOKEN'] = authToken
  return env
}

/** Extract the progress-worthy text/tool facts out of one assistant frame. */
export function claudeFrameEvents(frame: ClaudeFrame): Array<{ kind: 'text' | 'note' | 'error'; text: string }> {
  const events: Array<{ kind: 'text' | 'note' | 'error'; text: string }> = []
  if (frame.type === 'system' && frame.subtype === 'init') {
    events.push({ kind: 'note', text: `会话已初始化（model=${frame.model ?? '?'}${frame.session_id === undefined ? '' : `, session=${frame.session_id}`}）` })
    return events
  }
  if (frame.type === 'assistant') {
    for (const block of frame.message?.content ?? []) {
      if (block.type === 'text' && (block.text ?? '').trim() !== '') {
        events.push({ kind: 'text', text: block.text ?? '' })
      } else if (block.type === 'tool_use' && block.name !== undefined) {
        events.push({ kind: 'note', text: `调用工具 ${block.name}` })
      }
    }
    return events
  }
  if (frame.type === 'result') {
    const label = frame.subtype === 'success' ? '运行完成' : `运行结束（${frame.subtype ?? 'unknown'}）`
    events.push({ kind: frame.is_error === true ? 'error' : 'note', text: label })
  }
  return events
}

/** The final answer of a `result` frame, plus the stats worth keeping. */
export function claudeResultOf(frame: ClaudeFrame): { finalText: string; stats: Record<string, string | number | boolean> } {
  const stats: Record<string, string | number | boolean> = {}
  if (typeof frame.num_turns === 'number') stats['turns'] = frame.num_turns
  if (typeof frame.duration_ms === 'number') stats['cliDurationMs'] = frame.duration_ms
  if (typeof frame.total_cost_usd === 'number') stats['costUsd'] = Number(frame.total_cost_usd.toFixed(4))
  if (frame.session_id !== undefined) stats['sessionId'] = frame.session_id
  return { finalText: frame.result ?? '', stats }
}

/**
 * Run one claude task to completion. Events surface through `onEvent` as the
 * stream arrives; the promise settles when the child exits.
 */
export async function runClaudeTask(options: {
  spawnFn?: Parameters<typeof runProcess>['0']['spawnFn']
  claudePath: string
  task: string
  cwd: string | undefined
  model: string
  permissionMode: ClaudePermissionMode
  baseUrl: string
  authToken: string
  timeoutMs: number
  signal: AbortSignal
  onEvent: (kind: 'text' | 'note' | 'error', text: string) => void
}): Promise<ClaudeRunResult> {
  const args = claudeArgs(options.model, options.permissionMode)
  const env = claudeEnv(options.baseUrl, options.authToken)

  let finalText = ''
  let sessionId = ''
  let resultError: string | undefined
  let resultStats: Record<string, string | number | boolean> = {}

  const handleLine = (line: string): void => {
    let frame: ClaudeFrame
    try {
      frame = JSON.parse(line) as ClaudeFrame
    } catch {
      // Non-JSON chatter (update banners, warnings) — keep it visible but harmless.
      if (line.trim().startsWith('{')) return
      options.onEvent('note', line.slice(0, 300))
      return
    }
    if (frame.session_id !== undefined && sessionId === '') sessionId = frame.session_id
    for (const event of claudeFrameEvents(frame)) options.onEvent(event.kind, event.text)
    if (frame.type === 'result') {
      const parsed = claudeResultOf(frame)
      finalText = parsed.finalText
      resultStats = parsed.stats
      if (frame.is_error === true && (frame.result ?? '').trim() !== '') resultError = frame.result
    }
  }

  const { outcome } = runProcess({
    ...(options.spawnFn === undefined ? {} : { spawnFn: options.spawnFn }),
    file: options.claudePath,
    args,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
    stdin: options.task,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onStdoutLine: handleLine,
  })
  const ended = await outcome

  const stats = { ...resultStats }
  if (ended.timedOut) stats['timedOut'] = true
  const ok = !ended.timedOut && ended.code === 0 && finalText.trim() !== '' && resultError === undefined
  return {
    ok,
    finalText,
    sessionId,
    exitCode: ended.code,
    stderrTail: ended.stderrTail,
    stats,
    error: resultError
      ?? (ended.timedOut ? '任务超时，进程已被终止' : undefined)
      ?? (ended.code === 0 ? undefined : `进程退出码 ${ended.code ?? 'null'}${ended.stderrTail.trim() === '' ? '' : `：${lastLines(ended.stderrTail)}`}`),
  }
}

/** The last non-empty stderr lines, for error strings. */
export function lastLines(text: string, count = 4): string {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  return lines.slice(-count).join(' | ')
}
