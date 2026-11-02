/**
 * Live token usage for a codex run.
 *
 * `codex exec --json` reports usage once per turn (`turn.completed`), so a long
 * run shows no numbers on the board until it ends. The CLI itself is not that
 * quiet: after every model response it appends a `token_count` event to its
 * rollout transcript, while the turn is still running —
 *
 *   <codex home>/sessions/<YYYY>/<MM>/<DD>/rollout-<stamp>-<thread id>.jsonl
 *   {"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{…}}}}
 *
 * Tailing that file (day folders are local time) gives the board the same
 * per-response cadence claude's stream-json frames provide, without touching
 * codex's stdout protocol or its rollout format beyond one event shape.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Usage snapshot in the shared stats contract ({@link tokenUsageOfStats}). */
export interface RolloutUsageStats {
  inputTokens?: number
  /** Raw inclusive input when cache reads are unavailable; never projected as uncached input. */
  reportedInputTokens?: number
  usageInputSemantics?: 'uncached' | 'includes-cache'
  outputTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** One chunk bound: a transcript line is small, the file can be megabytes. */
const READ_CHUNK = 256 * 1024

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined

/**
 * Project a `total_token_usage` record onto the shared stats contract.
 * Codex `input_tokens` includes cache reads, while the contract wants mutually
 * exclusive uncached input / cache read / cache write (same split as
 * {@link codexUsageStats}).
 */
export function usageFromTotals(raw: unknown): RolloutUsageStats | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  const input = count(row['input_tokens'])
  const output = count(row['output_tokens'])
  const cached = count(row['cached_input_tokens'])
  const cacheWrite = count(row['cache_write_input_tokens'])
  if (input === undefined && output === undefined && cached === undefined && cacheWrite === undefined) return undefined
  const stats: RolloutUsageStats = {}
  if (input !== undefined) {
    if (cached === undefined) {
      stats.reportedInputTokens = input
      stats.usageInputSemantics = 'includes-cache'
    } else {
      stats.inputTokens = Math.max(0, input - cached - (cacheWrite ?? 0))
      stats.usageInputSemantics = 'uncached'
    }
  }
  if (cached !== undefined) stats.cachedInputTokens = cached
  if (output !== undefined) stats.outputTokens = output
  if (cacheWrite !== undefined) stats.cacheWriteTokens = cacheWrite
  return stats
}

const USAGE_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens'] as const
type UsageKey = typeof USAGE_KEYS[number]
type UsageTotals = Partial<Record<UsageKey, number>>

/** Reconstruct inclusive counters before combining two observations of ONE run. */
function totalsOfStats(stats: RolloutUsageStats): UsageTotals {
  const totals: UsageTotals = {}
  const input = count(stats.reportedInputTokens) ?? (stats.inputTokens === undefined ? undefined
    : stats.inputTokens + (stats.cachedInputTokens ?? 0) + (stats.cacheWriteTokens ?? 0))
  if (input !== undefined) totals.input_tokens = input
  if (stats.cachedInputTokens !== undefined) totals.cached_input_tokens = stats.cachedInputTokens
  if (stats.cacheWriteTokens !== undefined) totals.cache_write_input_tokens = stats.cacheWriteTokens
  if (stats.outputTokens !== undefined) totals.output_tokens = stats.outputTokens
  return totals
}

/** Never merge already-disjoint input with an additional cache-write bucket. */
export function mergeCodexUsageStats(primary: RolloutUsageStats, fallback: RolloutUsageStats): RolloutUsageStats {
  const first = totalsOfStats(primary)
  const second = totalsOfStats(fallback)
  // Both sources observe monotonic counters for ONE run. Either stream can
  // arrive late or omit individual buckets; output can grow without input.
  // Combine raw counters, not normalized/disjoint input from different frames.
  const totals: UsageTotals = {}
  for (const key of USAGE_KEYS) {
    const value = Math.max(first[key] ?? -1, second[key] ?? -1)
    if (value >= 0) totals[key] = value
  }
  return usageFromTotals(totals) ?? {}
}

/** Read inclusive counters first: resume must subtract its pre-launch baseline. */
function parseRolloutTotalsLine(line: string): UsageTotals | undefined {
  const trimmed = line.trim()
  if (trimmed === '' || !trimmed.startsWith('{')) return undefined
  let row: unknown
  try {
    row = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined
  const record = row as { type?: unknown; payload?: unknown }
  if (record.type !== 'event_msg') return undefined
  const payload = record.payload
  if (payload === null || typeof payload !== 'object') return undefined
  const event = payload as { type?: unknown; info?: unknown }
  if (event.type !== 'token_count') return undefined
  const info = event.info
  if (info === null || typeof info !== 'object') return undefined
  const raw = (info as { total_token_usage?: unknown }).total_token_usage
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const totals: UsageTotals = {}
  for (const key of USAGE_KEYS) {
    const value = count((raw as Record<string, unknown>)[key])
    if (value !== undefined) totals[key] = value
  }
  return Object.keys(totals).length === 0 ? undefined : totals
}

/** Parse one rollout line; only `token_count` events carry usage. */
export function parseRolloutUsageLine(line: string): RolloutUsageStats | undefined {
  return usageFromTotals(parseRolloutTotalsLine(line))
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** The day folder codex writes rollouts into (local date, not UTC). */
export function sessionDayDir(home: string, day: Date): string {
  return join(home, 'sessions', String(day.getFullYear()), pad2(day.getMonth() + 1), pad2(day.getDate()))
}

/**
 * Locate the rollout file of one thread. Tomorrow's folder cannot exist yet and
 * a run started just before midnight still writes into yesterday's, so the two
 * relevant days are enough.
 */
export function findRolloutFile(threadId: string, home: string, nowMs: number): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(threadId)) return undefined
  const matchIn = (dir: string): string | undefined => {
    try {
      const match = readdirSync(dir, { withFileTypes: true }).find(entry => entry.isFile()
        && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${threadId}.jsonl`))
      return match === undefined ? undefined : join(dir, match.name)
    } catch { return undefined }
  }
  for (const backMs of [0, DAY_MS]) {
    const found = matchIn(sessionDayDir(home, new Date(nowMs - backMs)))
    if (found !== undefined) return found
  }
  // Resume writes to the original date folder, potentially months ago. Visit
  // only calendar folders and exact thread-id suffixes, never unrelated files.
  const directories = (root: string, pattern: RegExp): string[] => {
    try { return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && pattern.test(entry.name))
      .map(entry => join(root, entry.name)).sort().reverse() } catch { return [] }
  }
  for (const year of directories(join(home, 'sessions'), /^\d{4}$/)) {
    for (const month of directories(year, /^\d{2}$/)) {
      for (const day of directories(month, /^\d{2}$/)) {
        const found = matchIn(day)
        if (found !== undefined) return found
      }
    }
  }
  return undefined
}

/** `$CODEX_HOME` when set, else the CLI default. */
export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['CODEX_HOME']
  return configured !== undefined && configured.trim() !== '' ? configured : join(homedir(), '.codex')
}

export interface RolloutTailOptions {
  readonly threadId: string
  /** Codex home holding `sessions/`; defaults to {@link defaultCodexHome}. */
  readonly codexHome?: string
  /** Poll period; a transcript gains a few rows per run. */
  readonly intervalMs?: number
  /** Capture an existing thread's cumulative counters synchronously BEFORE spawn. */
  readonly resume?: boolean
  readonly onUsage: (stats: RolloutUsageStats) => void
  /** Telemetry degradation is explicit but must not prevent CLI execution. */
  readonly onWarning?: (message: string) => void
  /** Clock injection: day folders follow the local calendar. */
  readonly now?: () => number
}

export interface RolloutUsageTail {
  stop: () => void
}

/**
 * Follow the rollout file of `threadId` and report every new `token_count`
 * snapshot. Missing files are retried (codex creates the transcript right after
 * `thread.started`), and any filesystem surprise is swallowed: telemetry must
 * never break a task run.
 */
export function startRolloutUsageTail(options: RolloutTailOptions): RolloutUsageTail {
  const home = options.codexHome ?? defaultCodexHome()
  const intervalMs = options.intervalMs ?? 1000
  const now = options.now ?? (() => Date.now())
  let filePath: string | undefined
  let fd: number | undefined
  let offset = 0
  let pending: Buffer = Buffer.alloc(0)
  let lastKey = ''
  let stopped = false
  let initializing = options.resume === true
  let baseline: UsageTotals | undefined
  let telemetryInvalid = false

  const invalidate = (message: string): void => {
    if (telemetryInvalid) return
    telemetryInvalid = true
    options.onWarning?.(message)
  }
  const consume = (line: string): void => {
    const totals = parseRolloutTotalsLine(line)
    if (totals === undefined) return
    if (initializing) { baseline = totals; return }
    if (telemetryInvalid) return
    let current = totals
    if (options.resume === true) {
      if (baseline === undefined) return
      const delta: UsageTotals = {}
      for (const key of USAGE_KEYS) {
        const value = totals[key]
        const before = baseline[key]
        // A missing historical bucket is unknown, never an assumed zero.
        if (value === undefined || before === undefined) continue
        if (value < before) {
          invalidate('Codex 线程累计用量发生回退；已停用本轮 rollout 计量，仅采用 CLI 当轮用量帧。')
          return
        }
        delta[key] = value - before
      }
      if (!Object.values(delta).some(value => value > 0)) return
      current = delta
    }
    const stats = usageFromTotals(current)
    if (stats === undefined) return
    const key = JSON.stringify(stats)
    if (key === lastKey) return
    lastKey = key
    options.onUsage(stats)
  }

  const drain = (): void => {
    if (fd === undefined || filePath === undefined) return
    const size = statSync(filePath).size
    if (size < offset) {
      // Rotated or truncated: replay from the top instead of stalling forever.
      offset = 0
      pending = Buffer.alloc(0)
    }
    while (offset < size) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK, size - offset))
      const read = readSync(fd, chunk, 0, chunk.length, offset)
      if (read <= 0) break
      offset += read
      const bytes = chunk.subarray(0, read)
      pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes])
      let newline = pending.indexOf(0x0a)
      while (newline !== -1) {
        consume(pending.subarray(0, newline).toString('utf8'))
        pending = pending.subarray(newline + 1)
        newline = pending.indexOf(0x0a)
      }
    }
  }

  const tick = (): void => {
    if (stopped) return
    try {
      if (fd === undefined) {
        const found = findRolloutFile(options.threadId, home, now())
        if (found === undefined) return
        fd = openSync(found, 'r')
        filePath = found
        offset = 0
        pending = Buffer.alloc(0)
      }
      drain()
    } catch {
      // Transcript churn (rotation, move, permissions) never breaks the run.
    }
  }

  tick()
  if (initializing) {
    if (pending.length > 0) consume(pending.toString('utf8'))
    initializing = false
    if (baseline === undefined) invalidate('Codex 续接的历史用量基线不可读；已停用本轮 rollout 计量，仅采用 CLI 当轮用量帧，缺失值保持未知。')
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref()

  return {
    stop: () => {
      if (stopped) return
      // The child may append its final usage after the last polling tick.
      tick()
      if (pending.length > 0) consume(pending.toString('utf8'))
      stopped = true
      clearInterval(timer)
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // Already gone.
        }
        fd = undefined
      }
    },
  }
}
