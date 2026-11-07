/**
 * The grok channel: one headless `grok -p -` run over the
 * streaming-messages-json wire — NDJSON in the Anthropic Messages wire format,
 * the same frame shapes the claude channel parses, so frame handling is shared.
 * The task text rides stdin (never argv), progress events stream out line by
 * line, and the final `result` frame carries the answer back to the agent.
 *
 * Dispatched runs are isolated into a maestro-owned `GROK_HOME` (the grok
 * equivalent of codex's `--ignore-user-config`): the operator's own ~/.grok
 * config — model routes, plugins, MCP servers — must not take over a dispatched
 * task (measured on codex: that is how a run landed on an unknown model behind
 * a private router). The home is stable, not per-run, so grok sessions persist
 * on disk and `-r <session-id>` resume keeps working across runs. Its
 * config.toml is plugin-owned and carries ONLY the bridged dsh MCP servers of
 * the current run; secrets never ride the file — the mcp-env-shim restores the
 * real names from the child process env, exactly like the codex bridge.
 */

import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcess, type ChildOutcome } from '../spawn.js'
import { GROK_REASONING_EFFORTS, type MaestroChannelEvent } from '../wire.js'
import type { GrokPermissionMode } from '../config.js'
import {
  claudeBlocks, claudeFrameEvents, claudeResultOf, claudeToolResultEvents, mergeLiveUsage,
  lastLines, type ClaudeFrame,
} from './claude.js'
import { mcpSecretAlias, tomlKey, tomlString } from './codex.js'

/** Parsed outcome of one grok run. */
export interface GrokRunResult {
  ok: boolean
  finalText: string
  sessionId: string
  exitCode: number | null
  stderrTail: string
  stats: Record<string, string | number | boolean>
  error: string | undefined
}

/** Grok frames add `errors[]` (failure causes), `stop_reason` and MCP mount status. */
export interface GrokFrame extends ClaudeFrame {
  errors?: string[]
  stop_reason?: string
  mcp_servers?: Array<{ name?: string; status?: string }>
}

/** `--permission-mode` value for the configured mode; `inherit` sends none. */
export function grokPermissionArgs(permissionMode: GrokPermissionMode): string[] {
  if (permissionMode === 'inherit' || permissionMode === 'default') return []
  return ['--permission-mode', permissionMode]
}

/** The argv for one headless run (before the resolved path is prepended). */
export function grokArgs(model: string, permissionMode: GrokPermissionMode, thinking?: string, resume?: string, allowRules?: readonly string[]): string[] {
  // `-p -` reads the prompt from stdin — no quoting surface for task text.
  const args = ['-p', '-', '--output-format', 'streaming-messages-json']
  if (model !== '') args.push('-m', model)
  args.push(...grokPermissionArgs(permissionMode))
  // The level came from the model's configured reasoningEfforts; a value grok
  // does not parse must be skipped here (the caller notes the drop).
  if (thinking !== undefined && thinking !== '' && (GROK_REASONING_EFFORTS as readonly string[]).includes(thinking)) {
    args.push('--reasoning-effort', thinking)
  }
  // `-r <session-id>` continues a previous headless session; the follow-up
  // instruction still rides stdin.
  if (resume !== undefined && resume !== '') args.push('-r', resume)
  // Server-level grants pre-approve the bridged dsh MCP servers: a headless
  // run can never answer an approval prompt (same rationale as codex's
  // `default_tools_approval_mode = "approve"`).
  for (const rule of allowRules ?? []) args.push('--allow', rule)
  return args
}

/**
 * Environment overlays for pointing grok at a dsh-configured provider: the
 * key rides `XAI_API_KEY`, the endpoint `GROK_XAI_API_BASE_URL` (the knobs the
 * CLI itself reads for a custom xAI-compatible gateway). `GROK_NO_AUTO_UPDATE`
 * keeps a long-running dispatch from pausing on an update banner.
 */
export function grokEnv(baseUrl: string, apiKey: string, grokHome?: string): Record<string, string> {
  const env: Record<string, string> = { GROK_NO_AUTO_UPDATE: '1' }
  if (baseUrl !== '') env['GROK_XAI_API_BASE_URL'] = baseUrl
  if (apiKey !== '') env['XAI_API_KEY'] = apiKey
  if (grokHome !== undefined && grokHome !== '') env['GROK_HOME'] = grokHome
  return env
}

/**
 * The maestro-owned grok home under the dsh home (stable across runs for
 * resume). Same `$DSH_HOME` resolution rule as persist.ts / mcp.ts.
 */
export function grokHomeOf(dshHome?: string, home: string = homedir(), envDshHome: string | undefined = process.env['DSH_HOME']): string {
  const fromEnv = (dshHome ?? envDshHome ?? '').trim()
  return join(fromEnv !== '' ? fromEnv : join(home, '.dsh'), 'maestro', 'grok-home')
}

/** Secrets ride the child env under these aliases; the file never sees values. */
export function grokMcpEnv(servers: ReadonlyArray<{ env: Readonly<Record<string, string>> }>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [index, server] of servers.entries()) {
    Object.values(server.env).forEach((value, keyIndex) => { env[mcpSecretAlias(index, keyIndex)] = value })
  }
  return env
}

/**
 * The `config.toml` body for the maestro-owned grok home: ONLY the bridged
 * dsh MCP servers of the current run. Servers with env values go through the
 * mcp-env-shim (values restored from the child process env, never from this
 * file); plain servers keep their command/args verbatim.
 */
export function grokHomeConfig(servers: ReadonlyArray<{ name: string; transport?: 'stdio' | 'http'; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }>, shimPath: string): string {
  const lines: string[] = [
    '# Written by dsh-maestro-codex for dispatched grok runs; overwritten per dispatch.',
    '# Add operator settings to your own ~/.grok/config.toml — this home is plugin-owned.',
  ]
  for (const [index, server] of servers.entries()) {
    // `http` servers cannot be spawned by grok either — skip, like codex does.
    if (server.transport === 'http' || server.command.trim() === '') continue
    const keys = Object.keys(server.env)
    const command = keys.length === 0 ? server.command : process.execPath
    const serverArgs = keys.length === 0
      ? server.args
      : [shimPath, JSON.stringify({ command: server.command, args: server.args, keys, aliases: keys.map((_, keyIndex) => mcpSecretAlias(index, keyIndex)) })]
    lines.push(`[mcp_servers.${tomlKey(server.name)}]`)
    lines.push(`command = ${tomlString(command)}`)
    if (serverArgs.length > 0) lines.push(`args = [${serverArgs.map(tomlString).join(', ')}]`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Ensure the maestro-owned grok home exists and carries the current run's MCP
 * servers. The home (and its config.toml) belongs to this plugin, so each
 * dispatch rewrites the file wholesale — stale servers from a previous run can
 * never leak into this one.
 */
export async function writeGrokHomeConfig(home: string, servers: ReadonlyArray<{ name: string; transport?: 'stdio' | 'http'; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }>, shimPath?: string): Promise<void> {
  const shim = shimPath ?? fileURLToPath(new URL('../mcp-env-shim.js', import.meta.url))
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'config.toml'), grokHomeConfig(servers, shim), { encoding: 'utf8', mode: 0o600 })
}

/** Progress facts of one grok frame that go beyond the shared claude parsing. */
export function grokFrameEvents(frame: GrokFrame): MaestroChannelEvent[] {
  const events: MaestroChannelEvent[] = []
  // The init frame lists the servers grok actually mounted (statuses include
  // `connected`, `failed`, `needs-auth`, `pending`, `disabled`); a failed mount
  // must be visible while the run is live, not only after it fails.
  if (frame.type === 'system' && frame.subtype === 'init' && Array.isArray(frame.mcp_servers)) {
    const servers = frame.mcp_servers.filter(server => typeof server === 'object' && server !== null)
    const degraded = servers.filter(server => server['status'] === 'failed' || server['status'] === 'needs-auth')
    if (degraded.length > 0) {
      events.push({ kind: 'error', text: `MCP 服务器未就绪：${degraded.map(server => `${String(server['name'] ?? '?')}（${String(server['status'])}）`).join('、')}` })
    }
  }
  // A non-success result frame carries its causes in `errors[]`. The run-ended
  // label itself already comes from the shared claude result handling, so only
  // the grok-specific causes are emitted here. A successful result frame
  // supersedes earlier stream errors (reconnects), never the other way round.
  if (frame.type === 'result' && (frame.is_error === true || (frame.subtype !== undefined && frame.subtype !== 'success'))) {
    const causes = Array.isArray(frame.errors) ? frame.errors.filter(cause => typeof cause === 'string' && cause.trim() !== '') : []
    for (const cause of causes) events.push({ kind: 'error', text: cause })
  }
  return events
}

/** The stats a completed grok turn reports (same usage shape as claude). */
export function grokResultStats(frame: GrokFrame): Record<string, string | number | boolean> {
  return claudeResultOf(frame).stats
}

/**
 * Run one grok task to completion. Events surface through `onEvent` as the
 * stream arrives; the promise settles when the child exits.
 */
export async function runGrokTask(options: {
  spawnFn?: Parameters<typeof runProcess>['0']['spawnFn']
  grokPath: string
  task: string
  cwd: string | undefined
  model: string
  permissionMode: GrokPermissionMode
  /** Configured thinking level ('' = CLI default); rides --reasoning-effort. */
  thinking?: string
  /** Continue a previous headless session (its result frame's session_id). */
  resume?: string
  /** The maestro-owned grok home (isolation + resume storage); resolved via grokHomeOf when absent. */
  grokHome?: string
  baseUrl: string
  apiKey: string
  /** Bridged dsh MCP servers, written into the home's config.toml. */
  mcpServers?: ReadonlyArray<{ name: string; transport?: 'stdio' | 'http'; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }>
  timeoutMs: number
  signal: AbortSignal
  onEvent: (kind: MaestroChannelEvent['kind'], text: string, detail?: string) => void
  /** Running usage snapshot, one call per frame that carries counts. */
  onUsage?: (stats: Record<string, string | number | boolean>) => void
}): Promise<GrokRunResult> {
  const mcpServers = options.mcpServers ?? []
  const grokHome = options.grokHome ?? grokHomeOf()
  await writeGrokHomeConfig(grokHome, mcpServers)
  const args = grokArgs(options.model, options.permissionMode, options.thinking, options.resume,
    mcpServers.filter(server => server.transport !== 'http' && server.command.trim() !== '').map(server => `mcp__${server.name}`))
  if (options.thinking !== undefined && options.thinking !== '' && !(GROK_REASONING_EFFORTS as readonly string[]).includes(options.thinking)) {
    options.onEvent('note', `思考档位 "${options.thinking}" 不受 grok --reasoning-effort 支持，已忽略（沿用 CLI 默认）`)
  }
  const env = { ...grokEnv(options.baseUrl, options.apiKey, grokHome), ...grokMcpEnv(mcpServers) }

  let finalText = ''
  let sessionId = ''
  let resultError: string | undefined
  let pendingStreamError = false
  const streamErrors: string[] = []
  let resultStats: Record<string, string | number | boolean> = {}
  let liveUsage: Record<string, string | number | boolean> = {}
  const toolNamesById = new Map<string, string>()

  const handleLine = (line: string): void => {
    let frame: GrokFrame
    let errorMessage: string | undefined
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      const record = parsed as Record<string, unknown>
      // Grok error frames carry the cause as a plain string `message` — capture
      // it before the scrub pass strips non-object shapes from ClaudeFrame.
      if (typeof record['message'] === 'string') errorMessage = record['message']
      for (const key of ['type', 'subtype', 'session_id', 'result', 'model', 'cwd']) {
        if (record[key] !== undefined && typeof record[key] !== 'string') delete record[key]
      }
      frame = record as GrokFrame
    } catch {
      // Non-JSON chatter (update banners, plain error lines) — visible, harmless.
      if (line.trim().startsWith('{')) return
      options.onEvent('note', line.slice(0, 300))
      return
    }
    if (frame.session_id !== undefined && sessionId === '') sessionId = frame.session_id
    for (const event of claudeFrameEvents(frame)) options.onEvent(event.kind, event.text, event.detail)
    for (const event of grokFrameEvents(frame)) options.onEvent(event.kind, event.text, event.detail)
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
      // A failed result turns into the run's error; a successful one clears
      // earlier stream errors (reconnect noise), like codex's turn handling.
      if (frame.is_error === true || (frame.subtype !== undefined && frame.subtype !== 'success')) {
        const causes = Array.isArray(frame.errors) ? frame.errors.filter(cause => typeof cause === 'string' && cause.trim() !== '') : []
        resultError = [`${frame.subtype ?? 'unknown'}（stop_reason=${frame.stop_reason ?? 'none'}）`, ...causes].join('\n')
        if ((frame.result ?? '').trim() !== '') resultError = `${resultError}\n${frame.result}`
      } else {
        pendingStreamError = false
      }
    }
    if (frame.type === 'error') {
      pendingStreamError = true
      const message = errorMessage ?? 'grok stream error'
      streamErrors.push(message)
      options.onEvent('error', message)
    }
    // Live counters: assistant frames move them as the answer streams, the
    // result frame lands the authoritative totals.
    const streamed = frame.type === 'result' ? frame.usage : frame.type === 'assistant' ? frame.message?.usage : undefined
    if (streamed !== undefined && options.onUsage !== undefined) {
      liveUsage = mergeLiveUsage(liveUsage, streamed, frame.type === 'result' ? 'result' : 'assistant')
      options.onUsage({ ...liveUsage })
    }
  }

  let ended: ChildOutcome
  {
    const { outcome } = runProcess({
      ...(options.spawnFn === undefined ? {} : { spawnFn: options.spawnFn }),
      file: options.grokPath,
      args,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env,
      stdin: options.task,
      timeoutMs: options.timeoutMs,
      timeoutMode: 'idle',
      onTimeoutWarning: remainingMs => {
        options.onEvent('note', `CLI 已连续无 stdout/stderr 输出；若仍无输出，将在约 ${String(Math.round(remainingMs / 1000))} 秒后超时终止（无输出保护，不代表任务语义进展）`)
      },
      signal: options.signal,
      onStdoutLine: handleLine,
      // stderr is diagnostics, not protocol — surface it so a hung or failing
      // run is visible while it runs, not only in the final error string.
      onStderrLine: (line: string) => { options.onEvent('note', `stderr: ${line.slice(0, 300)}`) },
    })
    ended = await outcome
  }

  const stats = { ...resultStats }
  if (sessionId !== '') stats['sessionId'] = sessionId
  if (ended.timedOut) stats['timedOut'] = true
  // Exit 0 with an error frame is a real failure (measured: grok exits 0 after
  // `error_during_execution`); frames, not the exit code, decide the outcome.
  const ok = !ended.timedOut && !options.signal.aborted && ended.code === 0 && finalText.trim() !== '' && resultError === undefined && !pendingStreamError
  const failureReasons: string[] = []
  if (!ok) {
    if (resultError !== undefined) failureReasons.push(resultError)
    for (const message of streamErrors) failureReasons.push(message)
    if (pendingStreamError && resultError === undefined) failureReasons.push('grok 流式输出报错，且未收到成功的 result 帧')
    if (options.signal.aborted) failureReasons.push('任务已取消，进程已被终止')
    if (ended.timedOut) failureReasons.push(`连续无 stdout/stderr 输出 ${String(Math.round(options.timeoutMs / 1000))} 秒超时，进程已被终止（无输出保护，不代表任务语义进展）`)
    if (ended.code !== 0) failureReasons.push(`进程退出码 ${ended.code ?? 'null'}${ended.stderrTail.trim() === '' ? '' : `：${lastLines(ended.stderrTail)}`}`)
    if (finalText.trim() === '') failureReasons.push('Grok CLI 未返回文本结果（result 帧缺失或为空）')
  }
  return {
    ok,
    finalText,
    sessionId,
    exitCode: ended.code,
    stderrTail: ended.stderrTail,
    stats,
    error: ok ? undefined : [...new Set(failureReasons)].join('\n\n'),
  }
}
