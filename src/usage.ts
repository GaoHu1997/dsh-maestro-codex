/**
 * CLI usage reporting: every settled CLI run reports the tokens it consumed
 * through a custom session event, and a session projection folds those events
 * into one read model.
 *
 * Why a projection instead of the built-in `tokenUsage`: that projection only
 * counts this process's own provider calls, folds `assistant/message` and
 * `assistant/attempt` samples, and replaces a re-sampled (turn, step). Writing
 * an attempt on the current step would *replace* the main model's usage there,
 * and writing a synthetic message would pollute the conversation surface — so
 * the CLI numbers get their own event type and their own projection key
 * (`maestroCliUsage`), which every plugin can read from the session snapshot.
 */

import type { MaestroCliId, MaestroPhase } from './wire.js'

/** Custom session event carrying one settled CLI run's usage. */
export const CLI_USAGE_EVENT = 'maestro/cli-usage'

/** Session-projection key carrying the folded totals and the recent runs. */
export const CLI_USAGE_PROJECTION_KEY = 'maestroCliUsage'

/** How many recent runs the projection keeps (newest first). */
export const CLI_USAGE_RECENT_CAP = 20

/** The `append` slice of a host session the reporter needs. */
export interface CliUsageSession {
  append(type: string, data: unknown): unknown
}

/** One settled run, as read from the registry record's stats. */
export interface CliUsageRecord {
  readonly taskId: string
  readonly cli: MaestroCliId
  readonly model: string
  readonly phase: MaestroPhase
  readonly sessionId: string | undefined
  readonly startedAt: number
  readonly endedAt: number
  readonly durationMs: number
  readonly exitCode: number | undefined
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens: number
  readonly cacheWriteTokens: number
  readonly error: string | undefined
}

/** The slice of a registry task the reporter reads. */
export interface CliUsageTask {
  readonly id: string
  readonly cli: MaestroCliId
  readonly model: string
  readonly phase: MaestroPhase
  readonly sessionId: string | undefined
  readonly startedAt: number
  readonly endedAt: number | undefined
  readonly exitCode: number | undefined
  readonly error: string | undefined
  readonly stats: Record<string, string | number | boolean> | undefined
}

/** Folded totals of every reported run in one session. */
export interface CliUsageTotals {
  readonly requests: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens: number
  readonly cacheWriteTokens: number
  readonly durationMs: number
}

/** The whole projection value: totals plus the most recent runs. */
export interface CliUsageState {
  readonly totals: CliUsageTotals
  readonly recent: readonly CliUsageRecord[]
}

const ZERO_TOTALS: CliUsageTotals = Object.freeze({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  durationMs: 0,
})

/** The state a session starts from (frozen so `Object.is` gates stay quiet). */
export const EMPTY_CLI_USAGE: CliUsageState = Object.freeze({
  totals: ZERO_TOTALS,
  recent: Object.freeze([]) as readonly CliUsageRecord[],
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tokenCount(stats: Record<string, string | number | boolean> | undefined, key: string): number {
  const raw = stats?.[key]
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0
}

/** Turn one settled task into the record the event and the projection carry. */
export function cliUsageRecordOf(task: CliUsageTask): CliUsageRecord {
  const endedAt = task.endedAt ?? Date.now()
  return {
    taskId: task.id,
    cli: task.cli,
    model: task.model,
    phase: task.phase,
    sessionId: task.sessionId,
    startedAt: task.startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - task.startedAt),
    exitCode: task.exitCode,
    inputTokens: tokenCount(task.stats, 'inputTokens'),
    outputTokens: tokenCount(task.stats, 'outputTokens'),
    cachedInputTokens: tokenCount(task.stats, 'cachedInputTokens'),
    cacheWriteTokens: tokenCount(task.stats, 'cacheWriteTokens'),
    error: task.error,
  }
}

/**
 * The `append` slice of an arbitrary session-shaped object. The host's session
 * is only structurally known here; headless runs have none at all.
 */
export function sessionUsageAppendOf(session: unknown): CliUsageSession | undefined {
  if (!isRecord(session)) return undefined
  const append = session['append']
  if (typeof append !== 'function') return undefined
  return {
    append: (type: string, data: unknown) => (append as (t: string, d: unknown) => unknown).call(session, type, data),
  }
}

/**
 * Append one usage record to the owning session. Reporting is a read-model
 * convenience, never a dispatch dependency: a session that refuses the custom
 * event (or none at all) only costs the projection, not the run.
 */
export function reportCliUsage(session: unknown, task: CliUsageTask): void {
  const target = sessionUsageAppendOf(session)
  if (target === undefined) return
  try {
    target.append(CLI_USAGE_EVENT, cliUsageRecordOf(task))
  } catch {
    // Swallowed on purpose — see the doc comment above.
  }
}

function addTotals(totals: CliUsageTotals, record: CliUsageRecord): CliUsageTotals {
  return {
    requests: totals.requests + 1,
    inputTokens: totals.inputTokens + record.inputTokens,
    outputTokens: totals.outputTokens + record.outputTokens,
    cachedInputTokens: totals.cachedInputTokens + record.cachedInputTokens,
    cacheWriteTokens: totals.cacheWriteTokens + record.cacheWriteTokens,
    durationMs: totals.durationMs + record.durationMs,
  }
}

function recordOfEvent(data: unknown): CliUsageRecord | undefined {
  if (!isRecord(data) || typeof data['taskId'] !== 'string') return undefined
  return data as unknown as CliUsageRecord
}

/**
 * Fold one session event into the usage state. Unknown events return the same
 * reference, so the registry's `Object.is` gates skip view work.
 */
export function applyCliUsage(state: CliUsageState, event: { readonly type: string; readonly data?: unknown }): CliUsageState {
  if (event.type !== CLI_USAGE_EVENT) return state
  const record = recordOfEvent(event.data)
  if (record === undefined) return state
  return {
    totals: addTotals(state.totals, record),
    recent: [record, ...state.recent].slice(0, CLI_USAGE_RECENT_CAP),
  }
}

/** The minimal schema surface the projection registry calls (`parse` only). */
export interface SchemaLike<T> {
  parse(value: unknown): T
}

function parseUsageState(value: unknown): CliUsageState {
  if (!isRecord(value) || !isRecord(value['totals']) || !Array.isArray(value['recent'])) {
    throw new TypeError('not a maestro CLI usage state')
  }
  return value as unknown as CliUsageState
}

const USAGE_STATE_SCHEMA: SchemaLike<CliUsageState> = { parse: parseUsageState }

/** The projection definition handed to `ctx.sessionProjections.register`. */
export interface ProjectionDefinitionLike {
  readonly key: string
  readonly stateVersion: number
  readonly stateSchema: SchemaLike<CliUsageState>
  init(header: unknown, inheritedEventCount: number): CliUsageState
  apply(state: CliUsageState, event: { readonly type: string; readonly data?: unknown }): CliUsageState
  readonly wire: {
    readonly viewSchema: SchemaLike<CliUsageState>
    readonly view: (state: CliUsageState) => CliUsageState
  }
}

export function cliUsageProjectionDefinition(): ProjectionDefinitionLike {
  return {
    key: CLI_USAGE_PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: USAGE_STATE_SCHEMA,
    init: () => EMPTY_CLI_USAGE,
    apply: applyCliUsage,
    wire: { viewSchema: USAGE_STATE_SCHEMA, view: (state: CliUsageState) => state },
  }
}

/** The registry surface this plugin uses (duck-typed: dsh-session-projection is not a dependency). */
export interface ProjectionRegistryLike {
  register(definition: ProjectionDefinitionLike): unknown
}

/** Read `ctx.sessionProjections` without requiring its type declaration. */
export function projectionRegistryOf(host: unknown): ProjectionRegistryLike | undefined {
  let service: unknown
  try {
    service = isRecord(host) || typeof host === 'object' ? (host as { sessionProjections?: unknown }).sessionProjections : undefined
  } catch {
    // A context without the service may still throw on access; treat as absent.
    return undefined
  }
  if (typeof service !== 'object' || service === null) return undefined
  const register = (service as { register?: unknown }).register
  if (typeof register !== 'function') return undefined
  return {
    register: (definition: ProjectionDefinitionLike) =>
      (register as (value: ProjectionDefinitionLike) => unknown).call(service, definition),
  }
}

/**
 * Register the usage projection when the host has the registry. Returns the
 * disposer, or `undefined` when the seam is absent (older hosts keep working;
 * the board still shows the per-task stats).
 */
export function installCliUsageProjection(host: unknown): (() => void) | undefined {
  const registry = projectionRegistryOf(host)
  if (registry === undefined) return undefined
  try {
    const disposer = registry.register(cliUsageProjectionDefinition())
    return typeof disposer === 'function' ? () => { (disposer as () => void)() } : () => {}
  } catch {
    return undefined
  }
}
