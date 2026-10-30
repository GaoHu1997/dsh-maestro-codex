/**
 * The claude channel: one headless `claude -p` run over the stream-json wire.
 * The task text rides stdin (never argv), progress events stream out line by
 * line, and the final `result` frame carries the answer back to the agent.
 */

import { runProcess } from '../spawn.js'
import { CLAUDE_THINKING_BUDGETS } from '../wire.js'
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
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string }> }
}

/** `--permission-mode` value for the configured mode; `inherit` sends none. */
export function claudePermissionArgs(permissionMode: ClaudePermissionMode): string[] {
  if (permissionMode === 'inherit' || permissionMode === 'default') return []
  if (permissionMode === 'bypassPermissions') return ['--dangerously-skip-permissions']
  return ['--permission-mode', permissionMode]
}

/** MCP bridge argv: ONLY the bridged dsh servers, claude's own global config ignored. */
export function claudeMcpArgs(mcpConfigPath: string, serverNames: readonly string[]): string[] {
  // `--allowedTools` carries the server-level grants; the names must NOT ride
  // as bare tokens — in `claude -p` a positional arg IS the prompt, so they
  // would be prepended to every task's stdin text.
  return [
    '--strict-mcp-config',
    '--mcp-config', mcpConfigPath,
  ].concat(serverNames.length > 0 ? ['--allowedTools', serverNames.map(name => `mcp__${name}`).join(',')] : [])
}

/** The argv for one headless run (before the resolved path is prepended). */
export function claudeArgs(model: string, permissionMode: ClaudePermissionMode, mcpConfigPath?: string, mcpServerNames?: readonly string[], resume?: string): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose']
  if (model !== '') args.push('--model', model)
  args.push(...claudePermissionArgs(permissionMode))
  // `--resume <session-id>` continues a previous headless session; the
  // follow-up instruction still rides stdin.
  if (resume !== undefined && resume !== '') args.push('--resume', resume)
  if (mcpConfigPath !== undefined) args.push(...claudeMcpArgs(mcpConfigPath, mcpServerNames ?? []))
  return args
}

/**
 * Environment overlays for pointing claude at a dsh-configured provider, plus
 * the thinking budget: the level rides `MAX_THINKING_TOKENS`, the env knob
 * Claude Code itself reads (headless runs cannot flip the /think keywords).
 */
export function claudeEnv(baseUrl: string, authToken: string, thinking: string = ''): Record<string, string> {
  const env: Record<string, string> = {}
  if (baseUrl !== '') env['ANTHROPIC_BASE_URL'] = baseUrl
  if (authToken !== '') env['ANTHROPIC_AUTH_TOKEN'] = authToken
  const budget = (CLAUDE_THINKING_BUDGETS as Record<string, number | undefined>)[thinking]
  if (budget !== undefined) env['MAX_THINKING_TOKENS'] = String(budget)
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
        events.push({ kind: 'note', text: `调用工具 ${block.name}${toolUseDetail(block)}` })
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

/** A short detail suffix for tool calls the user tracks (subagents notably). */
function toolUseDetail(block: { name?: string; input?: Record<string, unknown> }): string {
  const input = block.input
  if (typeof input !== 'object' || input === null) return ''
  const subagentType = input['subagent_type']
  const description = input['description']
  const pattern = input['pattern']
  const command = input['command']
  if (typeof subagentType === 'string' && subagentType !== '') {
    return typeof description === 'string' && description !== '' ? `（子代理 ${subagentType}：${description.slice(0, 80)}）` : `（子代理 ${subagentType}）`
  }
  if (typeof pattern === 'string' && pattern !== '') return `（${pattern.slice(0, 60)}）`
  if (typeof command === 'string' && command !== '') return `（${command.slice(0, 60)}）`
  return ''
}

/** The tool_result frames of one user message (for subagent completion notes). */
export function claudeToolResultEvents(frame: ClaudeFrame, toolNamesById: ReadonlyMap<string, string>): Array<{ kind: 'text' | 'note' | 'error'; text: string }> {
  const events: Array<{ kind: 'text' | 'note' | 'error'; text: string }> = []
  if (frame.type !== 'user') return events
  for (const block of frame.message?.content ?? []) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    const name = toolNamesById.get(block.tool_use_id)
    if (name === 'Task' || name === 'Agent') {
      events.push({ kind: 'note', text: `子代理完成（${name}）` })
    }
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
  const usage = frame.usage
  if (typeof usage === 'object' && usage !== null) {
    if (typeof usage.input_tokens === 'number') stats['inputTokens'] = usage.input_tokens
    if (typeof usage.output_tokens === 'number') stats['outputTokens'] = usage.output_tokens
    if (typeof usage.cache_read_input_tokens === 'number') stats['cachedInputTokens'] = usage.cache_read_input_tokens
    if (typeof usage.cache_creation_input_tokens === 'number') stats['cacheWriteTokens'] = usage.cache_creation_input_tokens
  }
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
  /** Configured thinking level ('' = CLI default); rides MAX_THINKING_TOKENS. */
  thinking?: string
  /** Continue a previous headless session (its result frame's session_id). */
  resume?: string
  baseUrl: string
  authToken: string
  mcpConfigPath?: string
  mcpServerNames?: readonly string[]
  timeoutMs: number
  signal: AbortSignal
  onEvent: (kind: 'text' | 'note' | 'error', text: string) => void
}): Promise<ClaudeRunResult> {
  const args = claudeArgs(options.model, options.permissionMode, options.mcpConfigPath, options.mcpServerNames, options.resume)
  const env = claudeEnv(options.baseUrl, options.authToken, options.thinking ?? '')
  // The level came from the model's configured reasoningEfforts; a key with no
  // budget mapping (catalog drift) must not fail the run — say so and move on.
  if (options.thinking !== undefined && options.thinking !== '' && !(options.thinking in CLAUDE_THINKING_BUDGETS)) {
    options.onEvent('note', `思考档位 "${options.thinking}" 未映射到 claude 思考预算，已忽略（沿用 CLI 默认）`)
  }

  let finalText = ''
  let sessionId = ''
  let resultError: string | undefined
  let resultStats: Record<string, string | number | boolean> = {}
  const toolNamesById = new Map<string, string>()

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
    for (const block of frame.message?.content ?? []) {
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const id = typeof (block as { id?: unknown }).id === 'string' ? (block as { id: string }).id : undefined
        if (id !== undefined) toolNamesById.set(id, block.name)
      }
    }
    for (const event of claudeToolResultEvents(frame, toolNamesById)) options.onEvent(event.kind, event.text)
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
    // stderr is diagnostics, not protocol — surface it as notes so a hung or
    // failing run is visible while it runs, not only in the final error string.
    onStderrLine: (line: string) => { options.onEvent('note', `stderr: ${line.slice(0, 300)}`) },
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
      ?? (ended.code === 0 ? undefined : `进程退出码 ${ended.code ?? 'null'}${ended.stderrTail.trim() === '' ? '' : `：${lastLines(ended.stderrTail)}`}`)
      // Exit 0 with no text is a silent CLI (filtered output, crashed renderer):
      // name the reason instead of letting the dispatch report "unknown".
      ?? (finalText.trim() === '' ? 'Claude CLI 未返回文本结果（result 帧缺失或为空）' : undefined),
  }
}

/** The last non-empty stderr lines, for error strings. */
export function lastLines(text: string, count = 4): string {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  return lines.slice(-count).join(' | ')
}
