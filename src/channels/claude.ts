/**
 * The claude channel: one headless `claude -p` run over the stream-json wire.
 * The task text rides stdin (never argv), progress events stream out line by
 * line, and the final `result` frame carries the answer back to the agent.
 */

import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../spawn.js'
import { CLAUDE_THINKING_BUDGETS, type MaestroChannelEvent } from '../wire.js'
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
  message?: {
    content?: Array<{ type?: string; text?: string; thinking?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean }>
    /** Assistant frames carry their own usage; it is what feeds the live counters. */
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  }
}

/** One streamed usage snapshot, as both frame kinds report it. */
export type ClaudeUsage = NonNullable<ClaudeFrame['usage']>

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
export function claudeArgs(model: string, permissionMode: ClaudePermissionMode, mcpConfigPath?: string, mcpServerNames?: readonly string[], resume?: string, settingsPath?: string, addDir?: string): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose']
  if (settingsPath !== undefined && settingsPath !== '') args.push('--settings', settingsPath)
  if (model !== '') args.push('--model', model)
  args.push(...claudePermissionArgs(permissionMode))
  // `--resume <session-id>` continues a previous headless session; the
  // follow-up instruction still rides stdin.
  if (resume !== undefined && resume !== '') args.push('--resume', resume)
  // An additional working directory whose `.claude/skills/` claude loads as
  // native skills (the dsh skills staging tree — nothing else lives there).
  if (addDir !== undefined && addDir !== '') args.push('--add-dir', addDir)
  if (mcpConfigPath !== undefined) args.push(...claudeMcpArgs(mcpConfigPath, mcpServerNames ?? []))
  return args
}

/**
 * One-run settings file carrying the provider env. Claude Code applies its own
 * settings files' `env` block ON TOP of the inherited process environment, so
 * `claudeEnv()` alone loses whenever the user's `~/.claude/settings.json` pins
 * a gateway of its own — the run then silently talks to that gateway (a stale
 * one fails the whole task with its 403). `--settings` outranks the user file,
 * so the dsh-configured provider actually wins.
 */
export async function writeClaudeSettingsFile(env: Record<string, string>): Promise<string> {
  const file = join(tmpdir(), `dsh-maestro-claude-${randomUUID().slice(0, 8)}.json`)
  // The file carries the auth token: owner-only where the platform honours the
  // mode, and unlinked as soon as the run settles.
  try {
    await writeFile(file, JSON.stringify({ env }, null, 2), { encoding: 'utf8', mode: 0o600 })
    return file
  } catch (error) {
    await unlink(file).catch(() => {})
    throw error
  }
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

/** Extract the progress-worthy text/thinking/tool facts out of one assistant frame. */
export function claudeFrameEvents(frame: ClaudeFrame): MaestroChannelEvent[] {
  const events: MaestroChannelEvent[] = []
  if (frame.type === 'system' && frame.subtype === 'init') {
    events.push({ kind: 'note', text: `会话已初始化（model=${frame.model ?? '?'}${frame.session_id === undefined ? '' : `, session=${frame.session_id}`}）` })
    return events
  }
  if (frame.type === 'assistant') {
    for (const block of claudeBlocks(frame)) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        events.push({ kind: 'text', text: block.text ?? '' })
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim() !== '') {
        // 思考正文单独成事件：会话页折叠成「思考过程」行，不再混进回答。
        events.push({ kind: 'thinking', text: block.thinking ?? '' })
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        events.push({ kind: 'tool', text: block.name, detail: toolUseDetail(block) })
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

/** The tool row's expandable body: a one-line summary, then the call's params. */
function toolUseDetail(block: { name?: string; input?: Record<string, unknown> }): string {
  const input = block.input
  const summary = toolUseSummary(block)
  const params = typeof input !== 'object' || input === null || Object.keys(input).length === 0
    ? ''
    : JSON.stringify(input, null, 2)
  return params === '' ? summary : `${summary}\n${params}`
}

/** A short detail line for tool calls the user tracks (subagents notably). */
function toolUseSummary(block: { name?: string; input?: Record<string, unknown> }): string {
  const input = block.input
  if (typeof input !== 'object' || input === null) return ''
  const subagentType = input['subagent_type']
  const description = input['description']
  const pattern = input['pattern']
  const command = input['command']
  if (typeof subagentType === 'string' && subagentType !== '') {
    return typeof description === 'string' && description !== '' ? `子代理 ${subagentType}：${description.slice(0, 80)}` : `子代理 ${subagentType}`
  }
  if (typeof pattern === 'string' && pattern !== '') return pattern.slice(0, 60)
  if (typeof command === 'string' && command !== '') return command.slice(0, 60)
  return ''
}

/** Ignore malformed/null content blocks without losing subsequent frames. */
function claudeBlocks(frame: ClaudeFrame): NonNullable<NonNullable<ClaudeFrame['message']>['content']> {
  const blocks = frame.message?.content
  return Array.isArray(blocks) ? blocks.filter(block => typeof block === 'object' && block !== null && !Array.isArray(block)) : []
}

/** Tool-result identity and full text/error projection, including MCP skills. */
export function claudeToolResultEvents(frame: ClaudeFrame, toolNamesById: ReadonlyMap<string, string>): MaestroChannelEvent[] {
  const events: MaestroChannelEvent[] = []
  if (frame.type !== 'user') return events
  for (const block of claudeBlocks(frame)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    const name = toolNamesById.get(block.tool_use_id) ?? (typeof block.name === 'string' ? block.name : 'tool_result')
    const content = block.content
    const detail = typeof content === 'string' ? content : Array.isArray(content)
      ? content.map(part => typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>)['text'] === 'string'
        ? (part as Record<string, unknown>)['text'] as string : JSON.stringify(part)).join('\n')
      : content === undefined ? '' : JSON.stringify(content)
    events.push({ kind: block.is_error === true ? 'error' : 'tool',
      text: `${name}（${block.is_error === true ? '工具失败' : '工具完成'}，use_id=${block.tool_use_id}）`, detail })
    if (name === 'Task' || name === 'Agent') events.push({ kind: 'note', text: `子代理${block.is_error === true ? '失败' : '完成'}（${name}）` })
  }
  return events
}

/**
 * Fold one streamed usage snapshot into the running counters the board shows
 * while the task runs.
 *
 * Assistant frames report the context size of that message (`input_tokens`)
 * and that message's own output, so inputs are replaced while outputs
 * accumulate. The final `result` frame reports whole-run totals, so it simply
 * overwrites everything — that is also why the board may see one jump at the
 * end rather than a perfectly monotonic climb.
 */
export function mergeLiveUsage(
  previous: Readonly<Record<string, string | number | boolean>>,
  usage: ClaudeUsage,
  kind: 'assistant' | 'result',
): Record<string, string | number | boolean> {
  if (typeof usage !== 'object' || usage === null) return { ...previous }
  const next: Record<string, string | number | boolean> = { ...previous }
  const measured = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
  if (measured(usage.input_tokens)) {
    next['inputTokens'] = usage.input_tokens
    next['usageInputSemantics'] = 'uncached'
  }
  if (measured(usage.cache_read_input_tokens)) next['cachedInputTokens'] = usage.cache_read_input_tokens
  if (measured(usage.cache_creation_input_tokens)) next['cacheWriteTokens'] = usage.cache_creation_input_tokens
  if (measured(usage.output_tokens)) {
    const prior = next['outputTokens']
    next['outputTokens'] = kind === 'result'
      ? usage.output_tokens
      : typeof prior === 'number' ? prior + usage.output_tokens : usage.output_tokens
  }
  return next
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
    const measured = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
    if (measured(usage.input_tokens)) {
      stats['inputTokens'] = usage.input_tokens
      stats['usageInputSemantics'] = 'uncached'
    }
    if (measured(usage.output_tokens)) stats['outputTokens'] = usage.output_tokens
    if (measured(usage.cache_read_input_tokens)) stats['cachedInputTokens'] = usage.cache_read_input_tokens
    if (measured(usage.cache_creation_input_tokens)) stats['cacheWriteTokens'] = usage.cache_creation_input_tokens
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
  /** Extra `--add-dir` (the staged dsh skills tree; see bridge.stageNativeSkills). */
  addDir?: string
  timeoutMs: number
  signal: AbortSignal
  onEvent: (kind: MaestroChannelEvent['kind'], text: string, detail?: string) => void
  /** Running usage snapshot, one call per frame that carries counts. */
  onUsage?: (stats: Record<string, string | number | boolean>) => void
}): Promise<ClaudeRunResult> {
  // Claude auto memory is repository-global across independent conversations.
  // Disable it for delegated runs via the documented per-process switch; native
  // session transcripts/resume remain enabled and user settings are untouched.
  const env = { ...claudeEnv(options.baseUrl, options.authToken, options.thinking ?? ''), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }
  const settingsPath = await writeClaudeSettingsFile(env)
  try {
  const args = claudeArgs(options.model, options.permissionMode, options.mcpConfigPath, options.mcpServerNames, options.resume, settingsPath, options.addDir)
  // The level came from the model's configured reasoningEfforts; a key with no
  // budget mapping (catalog drift) must not fail the run — say so and move on.
  if (options.thinking !== undefined && options.thinking !== '' && !(options.thinking in CLAUDE_THINKING_BUDGETS)) {
    options.onEvent('note', `思考档位 "${options.thinking}" 未映射到 claude 思考预算，已忽略（沿用 CLI 默认）`)
  }

  let finalText = ''
  let sessionId = ''
  let resultError: string | undefined
  let resultStats: Record<string, string | number | boolean> = {}
  let liveUsage: Record<string, string | number | boolean> = {}
  const toolNamesById = new Map<string, string>()

  const handleLine = (line: string): void => {
    let frame: ClaudeFrame
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      const record = parsed as Record<string, unknown>
      for (const key of ['type', 'subtype', 'session_id', 'result', 'model', 'cwd']) {
        if (record[key] !== undefined && typeof record[key] !== 'string') delete record[key]
      }
      frame = record as ClaudeFrame
    } catch {
      // Non-JSON chatter (update banners, warnings) — keep it visible but harmless.
      if (line.trim().startsWith('{')) return
      options.onEvent('note', line.slice(0, 300))
      return
    }
    if (frame.session_id !== undefined && sessionId === '') sessionId = frame.session_id
    for (const event of claudeFrameEvents(frame)) options.onEvent(event.kind, event.text, event.detail)
    for (const block of claudeBlocks(frame)) {
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const id = typeof (block as { id?: unknown }).id === 'string' ? (block as { id: string }).id : undefined
        if (id !== undefined) toolNamesById.set(id, block.name)
      }
    }
    for (const event of claudeToolResultEvents(frame, toolNamesById)) options.onEvent(event.kind, event.text, event.detail)
    if (frame.type === 'result') {
      const parsed = claudeResultOf(frame)
      finalText = parsed.finalText
      resultStats = parsed.stats
      if (frame.is_error === true && (frame.result ?? '').trim() !== '') resultError = frame.result
    }
    // Live counters: assistant frames move them as the answer streams, the
    // result frame lands the authoritative totals.
    const streamed = frame.type === 'result' ? frame.usage : frame.type === 'assistant' ? frame.message?.usage : undefined
    if (streamed !== undefined && options.onUsage !== undefined) {
      liveUsage = mergeLiveUsage(liveUsage, streamed, frame.type === 'result' ? 'result' : 'assistant')
      options.onUsage({ ...liveUsage })
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
    timeoutMode: 'idle',
    onTimeoutWarning: remainingMs => {
      options.onEvent('note', `CLI 已连续无 stdout/stderr 输出；若仍无输出，将在约 ${String(Math.round(remainingMs / 1000))} 秒后超时终止（无输出保护，不代表任务语义进展）`)
    },
    signal: options.signal,
    onStdoutLine: handleLine,
    // stderr is diagnostics, not protocol — surface it as notes so a hung or
    // failing run is visible while it runs, not only in the final error string.
    onStderrLine: (line: string) => { options.onEvent('note', `stderr: ${line.slice(0, 300)}`) },
  })
  const ended = await outcome

  const stats = { ...resultStats }
  if (sessionId !== '') stats['sessionId'] = sessionId
  if (ended.timedOut) stats['timedOut'] = true
  const ok = !ended.timedOut && !options.signal.aborted && ended.code === 0 && finalText.trim() !== '' && resultError === undefined
  return {
    ok,
    finalText,
    sessionId,
    exitCode: ended.code,
    stderrTail: ended.stderrTail,
    stats,
    error: (options.signal.aborted ? '任务已取消，进程已被终止' : undefined)
      ?? resultError
      ?? (ended.timedOut ? `连续无 stdout/stderr 输出 ${String(Math.round(options.timeoutMs / 1000))} 秒超时，进程已被终止（无输出保护，不代表任务语义进展）` : undefined)
      ?? (ended.code === 0 ? undefined : `进程退出码 ${ended.code ?? 'null'}${ended.stderrTail.trim() === '' ? '' : `：${lastLines(ended.stderrTail)}`}`)
      // Exit 0 with no text is a silent CLI (filtered output, crashed renderer):
      // name the reason instead of letting the dispatch report "unknown".
      ?? (finalText.trim() === '' ? 'Claude CLI 未返回文本结果（result 帧缺失或为空）' : undefined),
  }
  } finally {
    if (settingsPath !== undefined) await unlink(settingsPath).catch(() => {})
  }
}

/** The last non-empty stderr lines, for error strings. */
export function lastLines(text: string, count = 4): string {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  return lines.slice(-count).join(' | ')
}
