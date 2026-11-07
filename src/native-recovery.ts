/** Plugin-only native count recovery through public persistence ownership.
 * Query NotFound is only a candidate, never physical absence. A public writer
 * must create with no-overwrite, append, flush, and release before make-live.
 * The canonical journal remains authoritative; no task/reply/Agent is invented.
 */
import { isDeepStrictEqual } from 'node:util'
import { SessionId, SessionLogOffset, SessionSeq, type CreateSessionOptions, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { CLI_CHILD_RECORD_EVENT, cliChildTurnEndReason } from './child-session.js'
import { applyCliRecordEvent, cliRecordNativeUsageOf, cliRecordStateOf, initCliRecordState, type CliRecordAcceptedUsage, type CliRecordNativeUsage, type CliRecordState } from './cli-record-projection.js'
import { cliUsageIdentityOf, parseCliUsageRecord, type CliUsageRecord } from './usage.js'

/** Plugin-owned informational identity marker; not a core executable lifecycle. */
export interface CliChildRecordEventData {
  readonly version: 1
  readonly kind: 'cli-record'
  readonly executor: 'external-cli'
  readonly taskId: string
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly source: string
  readonly usageId: string
  readonly accounting: 'native-mirror-of-parent-cli-ledger'
  readonly cli?: 'claude' | 'codex' | 'grok'
  readonly provider?: string
  readonly model?: string
  readonly inputSemantics?: 'uncached' | 'includes-cache' | 'unknown'
  readonly nativeInputSemantics?: 'uncached' | 'unknown'
  readonly nativeUsageAvailable?: boolean
  readonly legacyNormalizedInput?: boolean
  readonly recoveredFrom?: 'canonical'
  readonly transcriptRecovered?: false
  readonly parentAndNativeSameSpend?: true
}
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'maestro/cli-child': CliChildRecordEventData
  }
}

export type NativeRecoverySession = Pick<Session, 'id' | 'header' | 'inheritedEventCount' | 'append'>
export interface NativeRecoveryStore {
  get(id: SessionId): NativeRecoverySession | undefined
  create(id?: SessionId, options?: CreateSessionOptions): NativeRecoverySession
}
export interface NativeRecoveryQuery { readSession(id: SessionId): Promise<unknown> }
export interface NativeRecoveryHandleOptions { readonly signal?: AbortSignal }
/** Public @0.2.1-rc.5 SessionHandle facade, not private storage fields. */
export interface NativeRecoveryHandle {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly access: 'read' | 'write'
  read(offset?: number, length?: number, options?: NativeRecoveryHandleOptions): Promise<{ readonly eventState: unknown; readonly events: readonly SessionEvent[] }>
  append(events: readonly SessionEvent[], options?: NativeRecoveryHandleOptions): Promise<void>
  flush(options?: NativeRecoveryHandleOptions): Promise<void>
  close(): Promise<void>
}
export interface NativeRecoveryPersistence {
  readonly identity: symbol
  create(header: SessionHeader, options?: NativeRecoveryHandleOptions & { readonly inheritedEventCount?: SessionLogOffset }): Promise<NativeRecoveryHandle>
  open(id: SessionId, access: 'read' | 'write', options?: NativeRecoveryHandleOptions): Promise<NativeRecoveryHandle>
}
export interface NativeRecoveryParts {
  readonly store: () => NativeRecoveryStore | undefined
  readonly projections: () => unknown
  readonly query?: (() => NativeRecoveryQuery | undefined) | undefined
  /** Verified public error discriminator: candidate only, not physical absence. */
  readonly isNotFound?: ((error: unknown) => boolean) | undefined
  readonly persistence?: (() => NativeRecoveryPersistence | undefined) | undefined
  /** Monotonic adapter generation; absent/invalid cannot prove an unchanged binding. */
  readonly bindingVersion?: (() => number) | undefined
}
export interface NativeRecoveryResult {
  readonly status: 'recovered' | 'already-present' | 'skipped' | 'failed'
  readonly reason: string
  readonly childSessionId?: string
  readonly usageId?: string
  readonly mode?: 'canonical-observation' | 'restored-seed'
  /** Original event observation, not standard tokenUsage projection acceptance. */
  readonly nativeUsageAccepted?: boolean
  /** This operation's captured public handle append/flush barrier succeeded. */
  readonly nativeWriteFlushed?: boolean
}
interface Eligible {
  readonly record: CliUsageRecord
  readonly child: string
  readonly parent: string
  readonly usageId: string
  readonly source: string
  readonly provider: string
  readonly usage: CliRecordNativeUsage
}
interface Lifecycle { readonly turn: number; readonly step: number; readonly openTurn: boolean; readonly openStep: boolean }
interface Seed { readonly header: SessionHeader; readonly events: readonly SessionEvent[]; readonly cut: number; readonly state: CliRecordState; readonly lifecycle: Lifecycle | undefined }
interface Binding {
  readonly store: NativeRecoveryStore
  readonly query: NativeRecoveryQuery
  readonly persistence: NativeRecoveryPersistence
  readonly identity: symbol
  readonly version: number
}
class RecoveryFailure extends Error { constructor(readonly reason: string) { super(reason) } }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim() !== '' }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) }
function eligibleOf(record: CliUsageRecord): Eligible | undefined {
  if (parseCliUsageRecord(record) === undefined || !text(record.sessionId) || record.parentSessionId !== record.sessionId
    || !text(record.childSessionId) || record.childSessionId !== `cli-${record.taskId}` || record.childSessionId === record.sessionId
    || !text(record.provider) || !text(record.model) || record.inputSemantics !== 'uncached') return undefined
  const usage = cliRecordNativeUsageOf({ inputTokens: record.inputTokens, outputTokens: record.outputTokens,
    ...(record.cachedInputTokens === null ? {} : { cacheReadTokens: record.cachedInputTokens }),
    ...(record.cacheWriteTokens === null ? {} : { cacheWriteTokens: record.cacheWriteTokens }) })
  if (usage === undefined) return undefined
  return { record, child: record.childSessionId, parent: record.sessionId, usageId: cliUsageIdentityOf(record),
    source: record.source ?? `cli:${record.cli}`, provider: record.provider, usage }
}
function sameHeader(session: NativeRecoverySession, row: Eligible): boolean {
  return session.id === row.child && session.header.id === row.child && session.header.parentSession === row.parent
    && session.header.origin === 'subagent' && count(session.inheritedEventCount)
}
function sameSample(sample: CliRecordAcceptedUsage, row: Eligible): boolean {
  return sample.usageId === row.usageId && sample.source === row.source && sample.provider === row.provider
    && sample.model === row.record.model && sample.inputTokens === row.usage.inputTokens && sample.outputTokens === row.usage.outputTokens
    && sample.cacheReadTokens === row.usage.cacheReadTokens && sample.cacheWriteTokens === row.usage.cacheWriteTokens
}
function onlySample(state: CliRecordState, row: Eligible): boolean {
  return state.usageEventCount === 1 && state.acceptedUsages.length === 1 && state.acceptedUsages.some(sample => sameSample(sample, row))
}
function lifecycleOf(events: readonly SessionEvent[]): Lifecycle | undefined {
  let turn = 0, step = 0, openTurn = false, openStep = false
  for (const event of events) {
    const data: unknown = event.data
    if (event.type === 'turn/start') {
      if (openTurn || !object(data) || !count(data.turn) || data.turn !== turn + 1) return undefined
      turn = data.turn; step = 0; openTurn = true
    } else if (event.type === 'step/start') {
      if (!openTurn || openStep || !object(data) || data.turn !== turn || data.step !== step + 1) return undefined
      step++; openStep = true
    } else if (event.type === 'step/end') {
      if (!openStep || !object(data) || data.turn !== turn || data.step !== step) return undefined
      openStep = false
    } else if (event.type === 'turn/end') {
      if (!openTurn || openStep || !object(data) || data.turn !== turn) return undefined
      openTurn = false
    } else if (event.type === 'request/context' || event.type === 'request/header') {
      if (!openTurn) return undefined
    } else if (event.type === 'assistant/attempt' || event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result') {
      if (!openStep || !object(data) || data.turn !== turn || data.step !== step) return undefined
    }
  }
  return { turn, step, openTurn, openStep }
}
function storedFormatFailure(error: unknown): boolean {
  // Public query implementations may retain the decoder error as a cause.
  const seen = new Set<unknown>()
  for (let value = error; object(value) && !seen.has(value); value = value.cause) {
    seen.add(value)
    if (value.name === 'SessionFormatError' || value.code === 'SESSION_FORMAT_ERROR') return true
  }
  return false
}
function seedOf(value: unknown, row: Eligible): Seed | undefined {
  if (!object(value) || !object(value.session) || !Array.isArray(value.events) || !count(value.inheritedEventCount)) return undefined
  const header = value.session
  if (header.version !== 4 || header.id !== row.child || header.parentSession !== row.parent || header.origin !== 'subagent'
    || !count(header.createdAt) || typeof header.isSeeded !== 'boolean' || value.inheritedEventCount > value.events.length
    || (!header.isSeeded && value.inheritedEventCount !== 0)) return undefined
  if (header.isSeeded && value.inheritedEventCount < value.events.length) {
    // Public Session seed contract: only the SDK constructor/fork builder owns
    // this existing marker. Never manufacture it or change an old prefix.
    const boundary: unknown = value.events[value.inheritedEventCount]
    if (!object(boundary) || boundary.type !== 'session/end-seed' || !object(boundary.data) || boundary.data.inherited !== true) return undefined
  }
  let state = initCliRecordState(header, value.inheritedEventCount)
  for (let index = 0; index < value.events.length; index++) {
    const event: unknown = value.events[index]
    if (!object(event) || event.seq !== index || !count(event.time) || !text(event.type) || !Object.prototype.hasOwnProperty.call(event, 'data')) return undefined
    state = applyCliRecordEvent(state, { seq: index, type: event.type, data: event.data })
  }
  if (state.marker === null || state.marker.taskId !== row.record.taskId || state.marker.usageId !== row.usageId || state.marker.source !== row.source) return undefined
  return { header: header as unknown as SessionHeader, events: value.events as readonly SessionEvent[], cut: value.inheritedEventCount, state,
    lifecycle: lifecycleOf(value.events as readonly SessionEvent[]) }
}
function metaOf(header: SessionHeader): NonNullable<CreateSessionOptions['meta']> {
  return { parentSession: header.parentSession, createdAt: header.createdAt, isSeeded: header.isSeeded, origin: header.origin,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }) } as NonNullable<CreateSessionOptions['meta']>
}
function observationOf(row: Eligible, startSeq = 0, turn = 1): { header: SessionHeader; events: readonly SessionEvent[] } {
  const header: SessionHeader = { version: 4, id: SessionId(row.child), parentSession: SessionId(row.parent),
    origin: 'subagent', isSeeded: false, createdAt: row.record.startedAt, delegationDepth: 0 }
  const time = row.record.endedAt
  const marker = { version: 1, kind: 'cli-record', executor: 'external-cli', taskId: row.record.taskId,
    parentSessionId: row.parent, childSessionId: row.child, source: row.source, usageId: row.usageId,
    accounting: 'native-mirror-of-parent-cli-ledger', inputSemantics: 'uncached', nativeInputSemantics: 'uncached',
    recoveredFrom: 'canonical', transcriptRecovered: false, parentAndNativeSameSpend: true } satisfies CliChildRecordEventData
  const events: readonly SessionEvent[] = [
    { seq: SessionSeq(startSeq + 0), time, type: 'turn/start', data: { turn } },
    { seq: SessionSeq(startSeq + 1), time, type: 'request/context', data: { provider: row.provider, model: row.record.model } },
    { seq: SessionSeq(startSeq + 2), time, type: CLI_CHILD_RECORD_EVENT, data: marker, ignorable: true },
    { seq: SessionSeq(startSeq + 3), time, type: 'step/start', data: { turn, step: 1 } },
    { seq: SessionSeq(startSeq + 4), time, type: 'assistant/attempt', data: { turn, step: 1, stream: [{ type: 'chunk', time, chunk: { type: 'usage', usage: row.usage } }] } },
    { seq: SessionSeq(startSeq + 5), time, type: 'step/end', data: { turn, step: 1 } },
    { seq: SessionSeq(startSeq + 6), time, type: 'turn/end', data: { turn, reason: cliChildTurnEndReason(row.record.phase === 'done', row.record.phase) } },
  ]
  return { header, events }
}
function supplementOf(row: Eligible, prior: Seed): readonly SessionEvent[] {
  const lifecycle = prior.lifecycle
  if (lifecycle === undefined) throw new RecoveryFailure('stored-session-lifecycle-invalid-migration-required')
  const events: SessionEvent[] = []
  const time = row.record.endedAt
  const push = (type: 'step/end' | 'turn/end', data: unknown): void => {
    events.push({ seq: SessionSeq(prior.events.length + events.length), time, type, data } as SessionEvent)
  }
  // A flushed but interrupted suffix can already contain the one native charge.
  // Close it in place; never publish that cumulative sample a second time.
  if (lifecycle.openStep) push('step/end', { turn: lifecycle.turn, step: lifecycle.step })
  if (lifecycle.openTurn) push('turn/end', { turn: lifecycle.turn,
    reason: onlySample(prior.state, row) ? cliChildTurnEndReason(row.record.phase === 'done', row.record.phase) : { kind: 'interrupted' } })
  if (!onlySample(prior.state, row)) events.push(...observationOf(row, prior.events.length + events.length, lifecycle.turn + 1).events)
  return events
}
function persistenceOf(value: unknown): NativeRecoveryPersistence | undefined {
  if (!object(value) || typeof value.identity !== 'symbol' || typeof value.create !== 'function' || typeof value.open !== 'function') return undefined
  return value as unknown as NativeRecoveryPersistence
}
function writableHandle(value: unknown, expected: SessionHeader, cut = 0): value is NativeRecoveryHandle {
  return object(value) && value.id === expected.id && value.access === 'write' && value.inheritedEventCount === cut
    && isDeepStrictEqual(value.header, expected) && ['read', 'append', 'flush', 'close'].every(key => typeof value[key] === 'function')
}

export class NativeRecovery {
  private readonly running = new Map<string, Promise<NativeRecoveryResult>>()
  constructor(private readonly parts: NativeRecoveryParts) {}
  recover(record: CliUsageRecord): Promise<NativeRecoveryResult> {
    const row = eligibleOf(record)
    if (row === undefined) return Promise.resolve({ status: 'skipped', reason: 'ineligible-canonical-record' })
    const previous = this.running.get(row.child) ?? Promise.resolve(undefined)
    const job = previous.catch(() => undefined).then(() => this.recoverOne(row))
    this.running.set(row.child, job)
    void job.finally(() => { if (this.running.get(row.child) === job) this.running.delete(row.child) }).catch(() => {})
    return job
  }
  private inspectLive(session: NativeRecoverySession, row: Eligible): NativeRecoveryResult {
    const identity = { childSessionId: row.child, usageId: row.usageId }
    if (!sameHeader(session, row)) return { ...identity, status: 'skipped', reason: 'live-identity-mismatch' }
    const state = cliRecordStateOf(this.parts.projections(), session)
    if (state === undefined || !state.headerValid || state.marker === null || state.marker.taskId !== row.record.taskId)
      return { ...identity, status: 'skipped', reason: 'live-projection-unknown' }
    if (onlySample(state, row)) return { ...identity, status: 'already-present', reason: 'actual-native-usage-observed', nativeUsageAccepted: true }
    return { ...identity, status: 'skipped', reason: 'live-native-usage-unknown-or-conflicting' }
  }
  private checkBinding(binding: Binding): void {
    if (this.parts.store() !== binding.store || this.parts.query?.() !== binding.query
      || this.parts.persistence?.() !== binding.persistence || binding.persistence.identity !== binding.identity
      || this.parts.bindingVersion?.() !== binding.version) throw new RecoveryFailure('public-bindings-changed')
  }
  private async persistObservation(binding: Binding, row: Eligible): Promise<Seed> {
    const expected = observationOf(row)
    let handle: NativeRecoveryHandle | undefined
    try {
      // create is the public physical-generation/no-overwrite arbiter. No stat.
      const created = await binding.persistence.create(expected.header, { inheritedEventCount: SessionLogOffset(0) })
      if (object(created) && typeof created.close === 'function') handle = created as unknown as NativeRecoveryHandle
      this.checkBinding(binding)
      if (!writableHandle(created, expected.header)) throw new RecoveryFailure('public-writer-identity-invalid')
      handle = created
      await handle.append(expected.events)
      this.checkBinding(binding)
      await handle.flush()
      this.checkBinding(binding)
      // Release ownership before make-live's host writer can open this id.
      await handle.close()
      handle = undefined
      this.checkBinding(binding)
      const value = await binding.query.readSession(expected.header.id)
      this.checkBinding(binding)
      const seed = seedOf(value, row)
      if (seed === undefined || seed.cut !== 0 || !isDeepStrictEqual(seed.header, expected.header)
        || !isDeepStrictEqual(seed.events, expected.events) || !onlySample(seed.state, row))
        throw new RecoveryFailure('flushed-observation-query-mismatch')
      return seed
    } finally {
      // Public close is idempotent; always release a captured owned handle.
      if (handle !== undefined) await handle.close()
    }
  }
  private async appendExistingObservation(binding: Binding, row: Eligible, prior: Seed): Promise<Seed> {
    const suffix = supplementOf(row, prior)
    const expectedEvents = [...prior.events, ...suffix]
    let handle: NativeRecoveryHandle | undefined
    try {
      const opened = await binding.persistence.open(SessionId(row.child), 'write')
      if (object(opened) && typeof opened.close === 'function') handle = opened as unknown as NativeRecoveryHandle
      this.checkBinding(binding)
      if (!writableHandle(opened, prior.header, prior.cut)) throw new RecoveryFailure('public-writer-identity-invalid')
      handle = opened
      // Bounded public window detects even one unobserved trailing event.
      // The backend remains the atomic next-seq/ownership arbiter after read.
      const read = await handle.read(0, prior.events.length + 1)
      this.checkBinding(binding)
      if (!object(read) || !Array.isArray(read.events) || !isDeepStrictEqual(read.events, prior.events))
        throw new RecoveryFailure('cold-prefix-changed-or-incomplete')
      if (binding.store.get(SessionId(row.child)) !== undefined)
        throw new RecoveryFailure('live-session-appeared-before-cold-append')
      await handle.append(suffix)
      this.checkBinding(binding)
      await handle.flush()
      this.checkBinding(binding)
      await handle.close()
      handle = undefined
      this.checkBinding(binding)
      const value = await binding.query.readSession(SessionId(row.child))
      this.checkBinding(binding)
      const seed = seedOf(value, row)
      if (seed === undefined || seed.cut !== prior.cut || !isDeepStrictEqual(seed.header, prior.header)
        || !isDeepStrictEqual(seed.events, expectedEvents) || !onlySample(seed.state, row))
        throw new RecoveryFailure('flushed-existing-observation-query-mismatch')
      return seed
    } finally {
      if (handle !== undefined) await handle.close()
    }
  }
  private makeLive(binding: Binding, row: Eligible, seed: Seed, written: boolean): NativeRecoveryResult {
    this.checkBinding(binding)
    const identity = { childSessionId: row.child, usageId: row.usageId }
    const current = binding.store.get(SessionId(row.child))
    if (current !== undefined) return this.inspectLive(current, row)
    const session = binding.store.create(SessionId(row.child), { seed: seed.events, inheritedEventCount: SessionLogOffset(seed.cut), meta: metaOf(seed.header) })
    if (!sameHeader(session, row) || session.inheritedEventCount !== seed.cut || session.header.createdAt !== seed.header.createdAt
      || session.header.isSeeded !== seed.header.isSeeded) return { ...identity, status: 'failed', reason: 'created-session-identity-mismatch' }
    return { ...identity, status: 'recovered', mode: written ? 'canonical-observation' : 'restored-seed',
      reason: written ? 'public-writer-flushed-query-verified' : 'preserved-old-seed-no-recharge', nativeUsageAccepted: true,
      ...(written ? { nativeWriteFlushed: true } : {}) }
  }
  private async recoverOne(row: Eligible): Promise<NativeRecoveryResult> {
    const identity = { childSessionId: row.child, usageId: row.usageId }
    try {
      const store = this.parts.store()
      if (store === undefined) return { ...identity, status: 'skipped', reason: 'session-store-unavailable' }
      const live = store.get(SessionId(row.child))
      if (live !== undefined) return this.inspectLive(live, row)
      const query = this.parts.query?.()
      if (query === undefined) return { ...identity, status: 'skipped', reason: 'public-query-unavailable-cold-history-unknown' }
      const persistence = persistenceOf(this.parts.persistence?.())
      if (persistence === undefined) return { ...identity, status: 'skipped', reason: 'public-persistence-unavailable' }
      const version = this.parts.bindingVersion?.()
      if (!count(version)) return { ...identity, status: 'skipped', reason: 'public-binding-version-unavailable' }
      const binding: Binding = { store, query, persistence, identity: persistence.identity, version }
      let value: unknown, candidate = false
      try { value = await query.readSession(SessionId(row.child)) }
      catch (error) {
        this.checkBinding(binding)
        if (storedFormatFailure(error)) return { ...identity, status: 'failed', reason: 'stored-session-format-invalid-migration-required' }
        if (this.parts.isNotFound?.(error) !== true) return { ...identity, status: 'failed', reason: 'public-query-read-failed' }
        candidate = true
      }
      this.checkBinding(binding)
      const current = store.get(SessionId(row.child))
      if (current !== undefined) return this.inspectLive(current, row)
      if (!candidate) {
        const seed = seedOf(value, row)
        if (seed === undefined) return { ...identity, status: 'skipped', reason: 'cold-identity-or-seed-invalid' }
        if (seed.lifecycle === undefined) return { ...identity, status: 'failed', reason: 'stored-session-lifecycle-invalid-migration-required' }
        if (onlySample(seed.state, row) && !seed.lifecycle.openTurn) return this.makeLive(binding, row, seed, false)
        if (!onlySample(seed.state, row) && (seed.state.usageObserved !== false || seed.state.usageEventCount !== 0 || seed.state.acceptedUsages.length !== 0))
          return { ...identity, status: 'skipped', reason: 'cold-native-usage-unknown-or-conflicting' }
        const supplemented = await this.appendExistingObservation(binding, row, seed)
        this.checkBinding(binding)
        return this.makeLive(binding, row, supplemented, true)
      }
      const seed = await this.persistObservation(binding, row)
      this.checkBinding(binding)
      return this.makeLive(binding, row, seed, true)
    } catch (error) { return { ...identity, status: 'failed', reason: error instanceof RecoveryFailure ? error.reason : 'public-persistence-or-session-operation-failed' } }
  }
}
