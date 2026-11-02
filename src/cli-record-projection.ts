/** Host-only CLI identity/usage fold. Classification is NOT read authorization.
 * Public sessionProjections register/stateOf contract; no wire projection and no
 * snapshotEvents/ownEvents calls. Fork-inherited CLI markers never claim a child.
 */
import { CLI_CHILD_RECORD_EVENT } from './child-session.js'

export const CLI_RECORD_PROJECTION_KEY = 'maestroCliRecord'
export interface CliRecordMarker {
  readonly taskId: string
  readonly childSessionId: string
  readonly parentSessionId: string
  readonly usageId: string
  readonly source: string
  readonly uncached: boolean
}
export interface CliRecordNativeUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly totalTokens?: number
}
export interface CliRecordAcceptedUsage extends CliRecordNativeUsage {
  readonly usageId: string
  readonly source: string
  readonly provider: string
  readonly model: string
}
export interface CliRecordState {
  readonly sessionId: string | null
  readonly parentSessionId: string | null
  readonly origin: 'subagent' | null
  readonly inheritedEventCount: number
  readonly headerValid: boolean
  readonly marker: CliRecordMarker | null
  readonly route: { readonly provider: string; readonly model: string } | null
  /** True even for malformed/unattributed usage: never silently re-charge it. */
  readonly usageObserved: boolean
  /** One cumulative attempt is one event; extra or unknown events block recovery. */
  readonly usageEventCount: number
  readonly acceptedUsages: readonly CliRecordAcceptedUsage[]
}
export interface CliRecordFoldEvent { readonly seq: number; readonly type: string; readonly data?: unknown }
export interface CliRecordProjectionDefinition {
  readonly key: string
  readonly stateVersion: number
  readonly stateSchema: { parse(value: unknown): CliRecordState }
  init(header: unknown, inheritedEventCount: number): CliRecordState
  apply(state: CliRecordState, event: CliRecordFoldEvent): CliRecordState
}
export interface CliRecordProjectionService {
  register(definition: CliRecordProjectionDefinition): unknown
  stateOf(session: unknown, key: string): unknown
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim() !== '' }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) }
export function cliRecordNativeUsageOf(value: unknown): CliRecordNativeUsage | undefined {
  if (!object(value) || !count(value.inputTokens) || !count(value.outputTokens)) return undefined
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) if (value[key] !== undefined && !count(value[key])) return undefined
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens,
    ...(value.cacheReadTokens === undefined ? {} : { cacheReadTokens: value.cacheReadTokens as number }),
    ...(value.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: value.cacheWriteTokens as number }),
    ...(value.totalTokens === undefined ? {} : { totalTokens: value.totalTokens as number }) }
}
function routeOf(value: unknown): CliRecordState['route'] {
  return object(value) && text(value.provider) && text(value.model) ? { provider: value.provider, model: value.model } : null
}
export function initCliRecordState(header: unknown, inheritedEventCount: number): CliRecordState {
  const valid = object(header) && text(header.id) && text(header.parentSession) && header.id !== header.parentSession
    && header.origin === 'subagent' && count(inheritedEventCount)
  return { sessionId: object(header) && text(header.id) ? header.id : null,
    parentSessionId: object(header) && text(header.parentSession) ? header.parentSession : null,
    origin: object(header) && header.origin === 'subagent' ? 'subagent' : null,
    inheritedEventCount: count(inheritedEventCount) ? inheritedEventCount : 0, headerValid: valid,
    marker: null, route: null, usageObserved: false, usageEventCount: 0, acceptedUsages: [] }
}
function markerOf(state: CliRecordState, value: unknown): CliRecordMarker | null {
  if (!state.headerValid || !object(value) || value.version !== 1 || value.kind !== 'cli-record'
    || value.executor !== 'external-cli' || !text(value.taskId) || !text(value.usageId) || !text(value.source)
    || value.childSessionId !== state.sessionId || value.childSessionId !== `cli-${value.taskId}`
    || value.parentSessionId !== state.parentSessionId) return null
  return { taskId: value.taskId, childSessionId: value.childSessionId as string,
    parentSessionId: value.parentSessionId as string, usageId: value.usageId, source: value.source,
    uncached: value.nativeInputSemantics === 'uncached' || value.inputSemantics === 'uncached' }
}
export function applyCliRecordEvent(state: CliRecordState, event: CliRecordFoldEvent): CliRecordState {
  if (!state.headerValid || !count(event.seq) || event.seq < state.inheritedEventCount) return state
  if (event.type === CLI_CHILD_RECORD_EVENT) return { ...state, marker: markerOf(state, event.data) }
  if (event.type === 'request/context') return { ...state, route: routeOf(event.data) }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
  if (!object(event.data)) return state
  let observed = Object.prototype.hasOwnProperty.call(event.data, 'usage')
  const candidates: unknown[] = []
  // A message's top-level usage is canonical; its stream is not an extra charge.
  if (event.type === 'assistant/message' && observed) candidates.push(event.data.usage)
  if (Array.isArray(event.data.stream)) for (const item of event.data.stream) {
    if (!object(item) || item.type !== 'chunk' || !object(item.chunk) || item.chunk.type !== 'usage') continue
    observed = true
    if (event.type === 'assistant/attempt') candidates.push(item.chunk.usage)
  }
  if (!observed) return state
  const marker = state.marker, route = state.route
  const next = { ...state, usageObserved: true, usageEventCount: state.usageEventCount + 1 }
  if (marker === null || !marker.uncached || route === null) return next
  if (event.type === 'assistant/message') {
    const message = event.data.message
    const source = object(message) ? message.source : undefined
    const messageRoute = routeOf(source)
    if (!object(source) || source.kind !== 'model' || messageRoute === null
      || messageRoute.provider !== route.provider || messageRoute.model !== route.model) return next
  }
  // Successive cumulative usage chunks in one attempt are not extra charges.
  let usage: CliRecordNativeUsage | undefined
  for (const candidate of candidates) usage = cliRecordNativeUsageOf(candidate)
  if (usage === undefined) return next
  return { ...next, acceptedUsages: [...state.acceptedUsages, { ...usage,
    usageId: marker.usageId, source: marker.source, provider: route.provider, model: route.model }] }
}
function parseState(value: unknown): CliRecordState {
  if (!object(value) || !count(value.inheritedEventCount) || typeof value.headerValid !== 'boolean'
    || typeof value.usageObserved !== 'boolean' || !count(value.usageEventCount) || !Array.isArray(value.acceptedUsages)
    || value.acceptedUsages.length > value.usageEventCount || value.usageObserved !== (value.usageEventCount > 0)
    || !(value.sessionId === null || text(value.sessionId)) || !(value.parentSessionId === null || text(value.parentSessionId))
    || !(value.origin === null || value.origin === 'subagent') || !(value.route === null || routeOf(value.route) !== null)) throw new Error('invalid CLI record projection state')
  if (value.marker !== null) {
    if (!object(value.marker) || !text(value.marker.taskId) || !text(value.marker.usageId) || !text(value.marker.source)
      || value.marker.childSessionId !== value.sessionId || value.marker.childSessionId !== `cli-${value.marker.taskId}`
      || value.marker.parentSessionId !== value.parentSessionId || typeof value.marker.uncached !== 'boolean') throw new Error('invalid CLI record projection marker')
  }
  for (const sample of value.acceptedUsages) if (!object(sample) || cliRecordNativeUsageOf(sample) === undefined
    || !text(sample.usageId) || !text(sample.source) || routeOf(sample) === null) throw new Error('invalid CLI record projection usage')
  return value as unknown as CliRecordState
}
export function cliRecordProjectionDefinition(): CliRecordProjectionDefinition {
  return { key: CLI_RECORD_PROJECTION_KEY, stateVersion: 2, stateSchema: { parse: parseState }, init: initCliRecordState, apply: applyCliRecordEvent }
}
function serviceOf(host: unknown): CliRecordProjectionService | undefined {
  try {
    const service = object(host) ? host.sessionProjections : undefined
    if (!object(service) || typeof service.register !== 'function' || typeof service.stateOf !== 'function') return undefined
    return service as unknown as CliRecordProjectionService
  } catch { return undefined }
}
export function installCliRecordProjection(host: unknown): (() => void) | undefined {
  const service = serviceOf(host)
  if (service === undefined) return undefined
  try {
    const disposer = service.register(cliRecordProjectionDefinition())
    return typeof disposer === 'function' ? () => { disposer() } : () => {}
  } catch { return undefined }
}
export function cliRecordStateOf(host: unknown, session: unknown): CliRecordState | undefined {
  try {
    const service = serviceOf(host)
    if (service === undefined || !object(session) || !object(session.header)) return undefined
    const state = parseState(service.stateOf(session, CLI_RECORD_PROJECTION_KEY))
    if (state.sessionId !== session.id || state.sessionId !== session.header.id
      || state.parentSessionId !== session.header.parentSession || state.origin !== session.header.origin
      || state.inheritedEventCount !== session.inheritedEventCount) return undefined
    return state
  } catch { return undefined }
}
export function ownsCliRecordSession(host: unknown, session: unknown): boolean {
  const state = cliRecordStateOf(host, session)
  return state?.headerValid === true && state.marker !== null
}
