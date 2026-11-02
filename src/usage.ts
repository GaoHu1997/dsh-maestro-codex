/**
 * CLI-only parent ledger. Native CLI usage belongs to the cli-<taskId> record
 * session, not the parent's LLM step. Both views describe the SAME spend: join
 * by usageId/childSessionId, never add the parent custom and child native totals.
 * SessionStore is live-only; the bounded pending queue below is NOT durable.
 */
import { TERMINAL_PHASES, type MaestroCliId, type MaestroPhase } from './wire.js'

export const CLI_USAGE_EVENT = 'maestro/cli-usage'
export const CLI_USAGE_PROJECTION_KEY = 'maestroCliUsage'
export const CLI_USAGE_RECENT_CAP = 20
export const CLI_USAGE_PENDING_CAP = 256
export type CliTokenCount = number | null
export type CliInputSemantics = 'uncached' | 'includes-cache' | 'unknown'
export interface CliKnownTokens {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cachedInputTokens?: number
  readonly cacheWriteTokens?: number
}
export interface CliUsageSession { readonly id?: string; append(type: string, data: unknown): unknown }

/** Missing counters are null, not a measured zero. Optional fields support v1 records. */
export interface CliUsageRecord {
  readonly taskId: string
  readonly cli: MaestroCliId
  readonly model: string
  readonly phase: MaestroPhase
  readonly sessionId?: string | undefined
  readonly startedAt: number
  readonly endedAt: number
  readonly durationMs: number
  readonly exitCode?: number | undefined
  readonly inputTokens: CliTokenCount
  readonly outputTokens: CliTokenCount
  readonly cachedInputTokens: CliTokenCount
  readonly cacheWriteTokens: CliTokenCount
  /** Subtotals observed across attempts, NOT a complete total when the bucket is null. */
  readonly knownTokens?: CliKnownTokens | undefined
  readonly error?: string | undefined
  readonly usageId?: string | undefined
  /** Origin of the observation, never a second charge for the native mirror. */
  readonly source?: string | undefined
  readonly provider?: string | undefined
  readonly inputSemantics?: CliInputSemantics | undefined
  readonly parentSessionId?: string | undefined
  readonly childSessionId?: string | undefined
}
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
export interface CliUsageTotals {
  readonly requests: number
  readonly inputTokens: CliTokenCount
  readonly outputTokens: CliTokenCount
  readonly cachedInputTokens: CliTokenCount
  readonly cacheWriteTokens: CliTokenCount
  readonly durationMs: number
}
export interface CliUsageState {
  /** Trusted projection header scope, never inferred from a usage payload. */
  readonly sessionId?: string
  readonly totals: CliUsageTotals
  readonly recent: readonly CliUsageRecord[]
  /** Complete settlement identities, independent of the presentation tail cap. */
  readonly settledIds?: readonly string[] | undefined
  /** Known subtotals remain available when a full counter is unknown. */
  readonly knownTotals?: CliUsageTotals | undefined
}
const ZERO_TOTALS: CliUsageTotals = Object.freeze({ requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, durationMs: 0 })
export const EMPTY_CLI_USAGE: CliUsageState = Object.freeze({ totals: ZERO_TOTALS, knownTotals: ZERO_TOTALS, recent: Object.freeze([]), settledIds: Object.freeze([]) })
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function finiteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && !Object.is(value, -0) && value <= Number.MAX_SAFE_INTEGER
}
function knownTokenCountOf(stats: CliUsageTask['stats'], key: string): CliTokenCount {
  const raw = stats?.[key]
  return finiteCount(raw) ? Math.round(raw) : null
}
/** A complete total requires a valid sample from EVERY actual CLI attempt. */
export function cliTokenCountOf(stats: CliUsageTask['stats'], key: string): CliTokenCount {
  return stats?.[`usagePartial_${key}`] === true ? null : knownTokenCountOf(stats, key)
}
function stringStat(stats: CliUsageTask['stats'], key: string): string | undefined {
  const value = stats?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}
export function cliUsageIdentityOf(record: Pick<CliUsageRecord, 'taskId' | 'cli' | 'startedAt' | 'usageId' | 'source'>): string {
  // Dispatch reports accumulated attempts ONCE. Explicit ids are for callers
  // reporting distinct actual attempts, not for an additional final aggregate.
  return record.usageId ?? JSON.stringify([record.source ?? `cli:${record.cli}`, record.taskId, record.startedAt])
}
export function cliUsageRecordOf(task: CliUsageTask): CliUsageRecord {
  const startedAt = finiteCount(task.startedAt) ? task.startedAt : 0
  const endedAt = finiteCount(task.endedAt) ? task.endedAt : Date.now()
  const source = stringStat(task.stats, 'usageSource') ?? `cli:${task.cli}`
  const usageId = stringStat(task.stats, 'usageAttemptId') ?? JSON.stringify([source, task.id, startedAt])
  const provider = stringStat(task.stats, 'usageProvider')
  const semantics = stringStat(task.stats, 'usageInputSemantics')
  const inputSemantics: CliInputSemantics = semantics === 'uncached' || semantics === 'includes-cache' ? semantics : 'unknown'
  const knownTokens: Partial<Record<(typeof TOKEN_KEYS)[number], number>> = {}
  if (TOKEN_KEYS.some(key => task.stats?.[`usagePartial_${key}`] === true)) {
    for (const key of TOKEN_KEYS) {
      const count = knownTokenCountOf(task.stats, key)
      if (count !== null) knownTokens[key] = count
    }
  }
  return {
    taskId: task.id, cli: task.cli, model: task.model, phase: task.phase,
    startedAt, endedAt, durationMs: Math.max(0, endedAt - startedAt),
    inputTokens: cliTokenCountOf(task.stats, 'inputTokens'),
    outputTokens: cliTokenCountOf(task.stats, 'outputTokens'),
    cachedInputTokens: cliTokenCountOf(task.stats, 'cachedInputTokens'),
    cacheWriteTokens: cliTokenCountOf(task.stats, 'cacheWriteTokens'),
    ...(Object.keys(knownTokens).length === 0 ? {} : { knownTokens }),
    usageId, source, inputSemantics, childSessionId: `cli-${task.id}`,
    ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId, parentSessionId: task.sessionId }),
    ...(provider === undefined ? {} : { provider }),
    ...(typeof task.exitCode === 'number' && Number.isSafeInteger(task.exitCode) && !Object.is(task.exitCode, -0) ? { exitCode: task.exitCode } : {}),
    ...(task.error === undefined ? {} : { error: task.error }),
  }
}
// The installed Session.append cannot persist ignorable metadata. Never send
// private events through it: these sinks update a volatile display mirror only.
// The UsageJournal remains the durable source of truth across restarts.
const liveUsage = new Map<string, Map<string, CliUsageRecord>>()
const usageSinks = new WeakMap<object, CliUsageSession>()
export function sessionUsageAppendOf(session: unknown): CliUsageSession | undefined {
  if (!isRecord(session) || typeof session['append'] !== 'function') return undefined
  const previous = usageSinks.get(session)
  if (previous !== undefined) return previous
  const visibleId = typeof session['id'] === 'string' ? session['id'] : undefined
  const sink: CliUsageSession = {
    ...(visibleId === undefined ? {} : { id: visibleId }),
    append(type, data) {
      const record = type === CLI_USAGE_EVENT ? parseCliUsageRecord(data) : undefined
      if (record === undefined || record.sessionId === undefined) throw new Error('Invalid parent-scoped CLI usage record')
      if (visibleId !== undefined && record.sessionId !== visibleId) throw new Error('CLI usage target does not own this record')
      let records = liveUsage.get(record.sessionId)
      if (records === undefined) { records = new Map(); liveUsage.set(record.sessionId, records) }
      const identity = cliUsageIdentityOf(record)
      if (!records.has(identity)) records.set(identity, structuredClone(record))
    },
  }
  usageSinks.set(session, sink)
  usageSinks.set(sink, sink)
  return sink
}
/** Clear only volatile display mirrors, never the canonical journal. */
export function clearCliUsageMirrors(): void { liveUsage.clear() }
const pending = new Map<string, CliUsageRecord>()
let droppedPending = 0
export function cliUsageQueueStatus(): { readonly pending: number; readonly dropped: number } {
  return { pending: pending.size, dropped: droppedPending }
}
function queueRecord(record: CliUsageRecord): void {
  if (record.sessionId === undefined) return
  const key = JSON.stringify([record.sessionId, cliUsageIdentityOf(record)])
  pending.set(key, record)
  while (pending.size > CLI_USAGE_PENDING_CAP) {
    const oldest = pending.keys().next().value
    if (oldest === undefined) break
    pending.delete(oldest)
    droppedPending++
  }
}
/** Explicit retry seam for a host live-session activation callback. No invented load API. */
export function flushPendingCliUsage(session: unknown, sessionId: string): number {
  const target = sessionUsageAppendOf(session)
  if (target === undefined) return 0
  let appended = 0
  for (const [key, record] of pending) {
    if (record.sessionId !== sessionId) continue
    try { target.append(CLI_USAGE_EVENT, record); pending.delete(key); appended++ } catch { break }
  }
  return appended
}
export function pendingCliUsageCount(): number { return pending.size }
export function reportCliUsage(session: unknown, task: CliUsageTask): void {
  // A preflight/running task is not a settled call, even if it has no stats.
  if (!TERMINAL_PHASES.includes(task.phase)) return
  const record = cliUsageRecordOf(task)
  const target = sessionUsageAppendOf(session)
  if (target === undefined) { queueRecord(record); return }
  if (task.sessionId !== undefined) flushPendingCliUsage(session, task.sessionId)
  try { target.append(CLI_USAGE_EVENT, record) } catch { queueRecord(record) }
}
const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens'] as const
function recordOfEvent(data: unknown): CliUsageRecord | undefined {
  if (!isRecord(data) || typeof data['taskId'] !== 'string' || data['taskId'] === ''
    || (data['cli'] !== 'claude' && data['cli'] !== 'codex') || typeof data['model'] !== 'string'
    || typeof data['phase'] !== 'string' || !TERMINAL_PHASES.includes(data['phase'] as MaestroPhase)
    || !finiteCount(data['startedAt']) || !finiteCount(data['endedAt']) || !finiteCount(data['durationMs'])) return undefined
  for (const key of TOKEN_KEYS) if (data[key] !== null && !finiteCount(data[key])) return undefined
  const knownTokens = data['knownTokens']
  if (knownTokens !== undefined) {
    if (!isRecord(knownTokens) || (Object.getPrototypeOf(knownTokens) !== Object.prototype && Object.getPrototypeOf(knownTokens) !== null)
      || Object.keys(knownTokens).some(key => !TOKEN_KEYS.includes(key as (typeof TOKEN_KEYS)[number]))) return undefined
    for (const key of TOKEN_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(knownTokens, key)) continue
      if (!finiteCount(knownTokens[key]) || (data[key] !== null && data[key] !== knownTokens[key])) return undefined
    }
  }
  for (const key of ['sessionId', 'error', 'usageId', 'source', 'provider', 'parentSessionId', 'childSessionId']) {
    if (data[key] !== undefined && typeof data[key] !== 'string') return undefined
  }
  if (data['exitCode'] !== undefined && (typeof data['exitCode'] !== 'number' || !Number.isSafeInteger(data['exitCode']) || Object.is(data['exitCode'], -0))) return undefined
  if (data['inputSemantics'] !== undefined && !['uncached', 'includes-cache', 'unknown'].includes(String(data['inputSemantics']))) return undefined
  if (data['usageId'] === '' || data['source'] === '') return undefined
  return data as unknown as CliUsageRecord
}
export function parseCliUsageRecord(value: unknown): CliUsageRecord | undefined { return recordOfEvent(value) }
function sumKnown(a: CliTokenCount, b: CliTokenCount): CliTokenCount {
  if (a === null || b === null) return null
  const sum = a + b
  return finiteCount(sum) ? sum : null
}
function addTotals(totals: CliUsageTotals, record: CliUsageRecord, knownOnly = false): CliUsageTotals {
  const count = (key: (typeof TOKEN_KEYS)[number]): CliTokenCount => knownOnly
    ? record.knownTokens?.[key] ?? record[key] ?? 0 : record[key]
  return {
    requests: totals.requests + 1,
    inputTokens: sumKnown(totals.inputTokens, count('inputTokens')),
    outputTokens: sumKnown(totals.outputTokens, count('outputTokens')),
    cachedInputTokens: sumKnown(totals.cachedInputTokens, count('cachedInputTokens')),
    cacheWriteTokens: sumKnown(totals.cacheWriteTokens, count('cacheWriteTokens')),
    durationMs: totals.durationMs + record.durationMs,
  }
}
export function applyCliUsage(state: CliUsageState, event: { readonly type: string; readonly data?: unknown }): CliUsageState {
  if (event.type !== CLI_USAGE_EVENT) return state
  const record = recordOfEvent(event.data)
  if (record === undefined || (state.sessionId !== undefined && record.sessionId !== state.sessionId)) return state
  const identity = cliUsageIdentityOf(record)
  const settledIds = state.settledIds ?? state.recent.map(cliUsageIdentityOf)
  if (settledIds.includes(identity)) return state
  const totals = addTotals(state.totals, record)
  const knownTotals = addTotals(state.knownTotals ?? state.totals, record, true)
  if (!finiteCount(totals.requests) || !finiteCount(totals.durationMs)) return state
  return { ...state, totals, knownTotals, recent: [record, ...state.recent].slice(0, CLI_USAGE_RECENT_CAP), settledIds: [...settledIds, identity] }
}
export interface SchemaLike<T> { parse(value: unknown): T }
function validTotals(value: unknown): value is CliUsageTotals {
  return isRecord(value) && finiteCount(value['requests']) && Number.isSafeInteger(value['requests']) && finiteCount(value['durationMs'])
    && TOKEN_KEYS.every(key => value[key] === null || finiteCount(value[key]))
}
function parseUsageState(value: unknown): CliUsageState {
  if (!isRecord(value) || (value['sessionId'] !== undefined && (typeof value['sessionId'] !== 'string' || value['sessionId'] === ''))
    || !validTotals(value['totals']) || !Array.isArray(value['recent'])
    || value['recent'].length > CLI_USAGE_RECENT_CAP || !value['recent'].every(record => recordOfEvent(record) !== undefined)
    || (value['knownTotals'] !== undefined && !validTotals(value['knownTotals']))
    || (value['settledIds'] !== undefined && (!Array.isArray(value['settledIds'])
      || !value['settledIds'].every(id => typeof id === 'string' && id !== '') || new Set(value['settledIds']).size !== value['settledIds'].length))) {
    throw new TypeError('not a maestro CLI usage state')
  }
  return value as unknown as CliUsageState
}
const USAGE_STATE_SCHEMA: SchemaLike<CliUsageState> = { parse: parseUsageState }
export interface ProjectionDefinitionLike {
  readonly key: string
  readonly stateVersion: number
  readonly stateSchema: SchemaLike<CliUsageState>
  init(header: unknown, inheritedEventCount: number): CliUsageState
  apply(state: CliUsageState, event: { readonly type: string; readonly data?: unknown }): CliUsageState
  readonly wire: { readonly viewSchema: SchemaLike<CliUsageState>; readonly view: (state: CliUsageState) => CliUsageState }
}
export function cliUsageProjectionDefinition(readCanonical: (sessionId: string) => readonly CliUsageRecord[] = () => []): ProjectionDefinitionLike {
  const view = (state: CliUsageState): CliUsageState => {
    if (state.sessionId === undefined) return state
    let visible = state
    for (const record of [...readCanonical(state.sessionId), ...(liveUsage.get(state.sessionId)?.values() ?? [])]) {
      if (record.sessionId === state.sessionId) visible = applyCliUsage(visible, { type: CLI_USAGE_EVENT, data: record })
    }
    return visible
  }
  // v3 adds trusted header scope and reconstructs from the durable journal at
  // the wire boundary. Volatile mirrors are NEVER serialized as checkpoints.
  return { key: CLI_USAGE_PROJECTION_KEY, stateVersion: 3, stateSchema: USAGE_STATE_SCHEMA,
    init: header => isRecord(header) && typeof header['id'] === 'string' ? { ...EMPTY_CLI_USAGE, sessionId: header['id'] } : EMPTY_CLI_USAGE,
    // A subsequent native event refreshes the view even when its log-only fold
    // is unchanged. Sidecar delivery itself does not pretend to be a log event.
    apply: (state, event) => ({ ...applyCliUsage(state, event) }),
    wire: { viewSchema: USAGE_STATE_SCHEMA, view } }
}
export interface ProjectionRegistryLike { register(definition: ProjectionDefinitionLike): unknown }
export function projectionRegistryOf(host: unknown): ProjectionRegistryLike | undefined {
  let service: unknown
  try { service = typeof host === 'object' && host !== null ? (host as { sessionProjections?: unknown }).sessionProjections : undefined } catch { return undefined }
  if (typeof service !== 'object' || service === null) return undefined
  const register = (service as { register?: unknown }).register
  if (typeof register !== 'function') return undefined
  return { register: definition => (register as (value: ProjectionDefinitionLike) => unknown).call(service, definition) }
}
export function installCliUsageProjection(host: unknown, readCanonical?: (sessionId: string) => readonly CliUsageRecord[]): (() => void) | undefined {
  const registry = projectionRegistryOf(host)
  if (registry === undefined) return undefined
  try {
    const disposer = registry.register(cliUsageProjectionDefinition(readCanonical))
    return typeof disposer === 'function' ? () => { (disposer as () => void)() } : () => {}
  } catch { return undefined }
}
