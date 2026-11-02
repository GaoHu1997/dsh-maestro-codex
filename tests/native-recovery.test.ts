import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionLogOffset, type CreateSessionOptions, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { applyCliRecordEvent, initCliRecordState, installCliRecordProjection, type CliRecordState } from '../src/cli-record-projection.js'
import { NativeRecovery, type NativeRecoveryHandle, type NativeRecoveryParts, type NativeRecoveryPersistence, type NativeRecoveryQuery, type NativeRecoverySession, type NativeRecoveryStore } from '../src/native-recovery.js'
import type { CliUsageRecord } from '../src/usage.js'

const RECORD: CliUsageRecord = { taskId: 'task-1', cli: 'codex', model: 'm', phase: 'done', sessionId: 'parent-A', parentSessionId: 'parent-A', childSessionId: 'cli-task-1', startedAt: 1000, endedAt: 2000, durationMs: 1000, inputTokens: 10, outputTokens: 3, cachedInputTokens: 2, cacheWriteTokens: null, usageId: 'usage-1', source: 'cli:codex', provider: 'p', inputSemantics: 'uncached' }
const MARKER = { version: 1, kind: 'cli-record', executor: 'external-cli', taskId: 'task-1', parentSessionId: 'parent-A', childSessionId: 'cli-task-1', usageId: 'usage-1', source: 'cli:codex', nativeInputSemantics: 'uncached', nativeUsageAvailable: true }
const HEADER: SessionHeader = { version: 4, id: SessionId('cli-task-1'), parentSession: SessionId('parent-A'), origin: 'subagent', isSeeded: false, createdAt: 888 }
const USAGE = { inputTokens: 10, outputTokens: 3, cacheReadTokens: 2 }
const event = (seq: number, type: string, data: unknown, surface = false): SessionEvent => ({ seq, time: 1000 + seq, type, data, ...(surface ? { surfaceOp: 'append' } : {}) }) as SessionEvent
interface Snapshot { session: SessionHeader; inheritedEventCount: number; events: SessionEvent[] }
function cold(withUsage = true): Snapshot {
  return { session: HEADER, inheritedEventCount: 0, events: [event(0, 'user/message', { id: 'original-task', role: 'user', content: [{ type: 'text', text: 'real historical task' }], source: { kind: 'user' } }, true), event(1, 'request/context', { provider: 'p', model: 'm' }), event(2, 'maestro/cli-child', MARKER), ...(withUsage ? [event(3, 'step/start', { turn: 1, step: 1 }), event(4, 'assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk', time: 1004, chunk: { type: 'usage', usage: USAGE } }] })] : [])] }
}
/** M public faces plus real Session schema; NOT an actual backend/host R test.
 * The fake no-overwrite/flush barrier is explicit and cannot certify the SDK. */
function harness() {
  const live = new Map<string, NativeRecoverySession>(), logs = new Map<string, SessionEvent[]>(), states = new Map<string, CliRecordState>()
  const physical = new Map<string, Snapshot | 'corrupt'>(), owned = new Set<string>(), trace: string[] = [], creations: CreateSessionOptions[] = []
  let projectionReady = true, identity = Symbol('M-generation'), version = 0, failure = '', hook: (stage: string) => void = () => {}
  let released = 0, writerCreates = 0, opens = 0, queryReads = 0
  const stage = (name: string) => { trace.push(name); hook(name); if (failure === name) throw new Error(`M fault: ${name}`) }
  const host = { sessionProjections: { register() { return () => {} }, stateOf(session: unknown) { return projectionReady ? states.get((session as { id: string }).id) : undefined } } }
  installCliRecordProjection(host)
  const store: NativeRecoveryStore = {
    get: id => live.get(id),
    create(id = SessionId('unexpected'), options = {}) {
      stage('store:create')
      if (live.has(id) || owned.has(id)) throw new Error('M duplicate/owned id')
      creations.push(options)
      const header: SessionHeader = { version: 4, id, createdAt: options.meta?.createdAt ?? 500, isSeeded: options.meta?.isSeeded ?? false,
        ...(options.meta?.parentSession === undefined ? {} : { parentSession: options.meta.parentSession }),
        ...(options.meta?.origin === undefined ? {} : { origin: options.meta.origin }),
        ...(options.meta?.cwd === undefined ? {} : { cwd: options.meta.cwd }),
        ...(options.meta?.delegationDepth === undefined ? {} : { delegationDepth: options.meta.delegationDepth }),
        ...(options.meta?.agentPreset === undefined ? {} : { agentPreset: options.meta.agentPreset }) }
      const cut = options.inheritedEventCount ?? SessionLogOffset(0)
      let real: Session
      try { real = Session.create(id, options.seed, header, cut) }
      catch (error) { schemaErrors.push(error instanceof Error ? error.stack ?? error.message : String(error)); throw error }
      const events = [...(options.seed ?? [])]
      let state = initCliRecordState(real.header, cut)
      for (const event of events) state = applyCliRecordEvent(state, event)
      states.set(id, state); logs.set(id, events)
      const face: NativeRecoverySession = { id, header: real.header, inheritedEventCount: real.inheritedEventCount,
        append: ((type: string, data: unknown, ...args: unknown[]) => {
          const append = real.append as unknown as (type: string, data: unknown, ...args: unknown[]) => SessionEvent
          const committed = append.call(real, type, data, ...args)
          events.push(committed); state = applyCliRecordEvent(state, committed); states.set(id, state)
          return committed
        }) as NativeRecoverySession['append'] }
      live.set(id, face); return face
    },
  }
  const query: NativeRecoveryQuery = { async readSession(id) {
    queryReads++; stage(queryReads === 1 ? 'query' : 'verify')
    const snapshot = physical.get(id)
    // Intentional real-contract ambiguity: corrupt and missing use same M error.
    if (snapshot === undefined || snapshot === 'corrupt') throw { code: 'M_QUERY_NOT_FOUND' }
    return structuredClone(snapshot)
  } }
  const schemaErrors: string[] = []
  const readWindows: Array<{ offset: number; length: number | undefined }> = []
  function handleFor(snapshot: Snapshot): NativeRecoveryHandle {
    const id = snapshot.session.id
    let pending: readonly SessionEvent[] = [], closed = false
    return { id, header: snapshot.session, inheritedEventCount: SessionLogOffset(snapshot.inheritedEventCount), access: 'write',
      async read(offset = 0, length) {
        stage('read'); readWindows.push({ offset, length })
        const end = length === undefined ? snapshot.events.length : offset + length
        return { eventState: { nextSeq: snapshot.events.length }, events: structuredClone(snapshot.events.slice(offset, end)) }
      },
      async append(events) {
        stage('append'); if (closed) throw new Error('M closed')
        for (let i = 0; i < events.length; i++) if (events[i]?.seq !== snapshot.events.length + i) throw new Error('M prefix/seq conflict')
        pending = structuredClone(events)
      },
      async flush() { stage('flush'); if (closed) throw new Error('M closed'); if (physical.get(id) !== snapshot) throw new Error('M no-replace publish conflict'); snapshot.events.push(...pending); pending = [] },
      async close() {
        if (!closed) { closed = true; owned.delete(id); released++ }
        stage('close')
      },
    }
  }
  const persistence: NativeRecoveryPersistence = {
    get identity() { return identity },
    async create(header, options = {}) {
      stage('create'); writerCreates++
      if (physical.has(header.id) || owned.has(header.id)) throw new Error('M physical generation exists or owned')
      const snapshot: Snapshot = { session: structuredClone(header), inheritedEventCount: options.inheritedEventCount ?? 0, events: [] }
      physical.set(header.id, snapshot); owned.add(header.id)
      return handleFor(snapshot)
    },
    async open(id, access) {
      stage('open'); opens++
      if (owned.has(id)) throw new Error('M native writer already owned')
      const snapshot = physical.get(id)
      if (snapshot === undefined || snapshot === 'corrupt' || access !== 'write') throw new Error('M unreadable/invalid open')
      owned.add(id); return handleFor(snapshot)
    },
  }
  let currentStore: NativeRecoveryStore | undefined = store, currentQuery: NativeRecoveryQuery | undefined = query, currentPersistence: NativeRecoveryPersistence | undefined = persistence
  const parts: NativeRecoveryParts = { store: () => currentStore, projections: () => host,
    query: () => currentQuery, persistence: () => currentPersistence, bindingVersion: () => version,
    isNotFound: error => (error as { code?: unknown }).code === 'M_QUERY_NOT_FOUND' }
  return { store, query, persistence, host, parts, live, logs, states, physical, owned, trace, creations, readWindows, schemaErrors,
    counts: () => ({ released, writerCreates, opens, queryReads }),
    setProjectionReady(value: boolean) { projectionReady = value }, failAt(name: string) { failure = name },
    onStage(fn: (stage: string) => void) { hook = fn }, bumpVersion() { version++ }, changeIdentity() { identity = Symbol('M-new-generation') },
    changeStore() { currentStore = { ...store } }, changeQuery() { currentQuery = { readSession: query.readSession } },
    changePersistence() { currentPersistence = { ...persistence, identity: Symbol('M-new-service') } }, dropPersistence() { currentPersistence = undefined },
  }
}
function withRead(h: ReturnType<typeof harness>, readSession: NativeRecoveryQuery['readSession']): NativeRecoveryParts {
  const query: NativeRecoveryQuery = { readSession }
  return { ...h.parts, query: () => query }
}

describe('M: plugin-only recovery with explicit public writer barrier (not deployed host R)', () => {
  it('writes only four real count observations, flushes, closes, verifies query, then makes live', async () => {
    const h = harness(), result = await new NativeRecovery(h.parts).recover(RECORD)
    expect(result).toMatchObject({ status: 'recovered', mode: 'canonical-observation', nativeUsageAccepted: true, nativeWriteFlushed: true })
    expect(h.trace).toEqual(['query', 'create', 'append', 'flush', 'close', 'verify', 'store:create'])
    const events = h.logs.get('cli-task-1') ?? []
    expect(events.map(e => e.type)).toEqual(['request/context', 'maestro/cli-child', 'step/start', 'assistant/attempt'])
    expect(events[1]?.ignorable).toBe(true)
    expect(events.filter(e => e.ignorable === true).map(e => e.type)).toEqual(['maestro/cli-child'])
    expect(events[1]?.data).toMatchObject({ recoveredFrom: 'canonical', transcriptRecovered: false, parentAndNativeSameSpend: true, usageId: 'usage-1' })
    expect(h.states.get('cli-task-1')?.acceptedUsages).toHaveLength(1)
    expect(events.find(e => e.type === 'assistant/message' || e.type === 'user/message')).toBeUndefined()
    expect(h.counts()).toMatchObject({ released: 1, writerCreates: 1, opens: 0 }); expect(h.owned.size).toBe(0)
  })
  it.each([false, true])('writes the required actual settlement chunk time for cold-existing=%s', async existing => {
    const h = harness()
    if (existing) h.physical.set(HEADER.id, cold(false))
    expect((await new NativeRecovery(h.parts).recover(RECORD)).status).toBe('recovered')
    const attempt = h.logs.get(HEADER.id)?.find(event => event.type === 'assistant/attempt')
    const chunk = attempt?.data.stream[0]
    if (chunk?.type !== 'chunk') throw new Error('missing typed recovery usage chunk')
    const timestamp: number = chunk.time
    expect(timestamp).toBe(RECORD.endedAt)
    expect(timestamp).toBe(attempt?.time)
    expect(chunk.chunk).toMatchObject({ type: 'usage', usage: USAGE })
  })
  it('serialises repeated/concurrent child recovery without extra native charge or writer', async () => {
    const h = harness(), r = new NativeRecovery(h.parts)
    expect((await Promise.all([r.recover(RECORD), r.recover(RECORD), r.recover(RECORD)])).map(x => x.status)).toEqual(['recovered', 'already-present', 'already-present'])
    expect(h.creations).toHaveLength(1); expect(h.logs.get('cli-task-1')).toHaveLength(4); expect(h.counts().writerCreates).toBe(1)
  })
  it.each([{ inputTokens: null }, { outputTokens: null }, { inputSemantics: 'unknown' }, { provider: '' }, { parentSessionId: 'other' }, { childSessionId: 'cli-other' }, { inputTokens: 1.5 }])('skips partial/invalid canonical fields %j', async fields => {
    const h = harness()
    expect((await new NativeRecovery(h.parts).recover({ ...RECORD, ...fields } as CliUsageRecord)).status).toBe('skipped')
    expect(h.creations).toHaveLength(0); expect(h.counts().writerCreates).toBe(0)
  })
  it('restores complete old seed unchanged, without writer or synthetic transcript', async () => {
    const h = harness(), prior = cold(); h.physical.set(HEADER.id, prior)
    expect(await new NativeRecovery(h.parts).recover(RECORD)).toMatchObject({ status: 'recovered', mode: 'restored-seed', reason: 'preserved-old-seed-no-recharge' })
    expect(h.creations[0]?.seed).toEqual(prior.events); expect(h.creations[0]?.meta?.createdAt).toBe(888)
    expect(h.counts()).toMatchObject({ writerCreates: 0, opens: 0 })
  })
  it('supplements a complete zero-usage cold seed without rewriting prefix/header/cut or inventing transcript', async () => {
    const h = harness(), prior = cold(false), before = structuredClone(prior); h.physical.set(HEADER.id, prior)
    const result = await new NativeRecovery(h.parts).recover(RECORD)
    expect(result).toMatchObject({ status: 'recovered', nativeUsageAccepted: true, nativeWriteFlushed: true })
    expect(h.trace).toEqual(['query', 'open', 'read', 'append', 'flush', 'close', 'verify', 'store:create'])
    expect(h.readWindows).toEqual([{ offset: 0, length: before.events.length + 1 }])
    const now = h.physical.get(HEADER.id) as Snapshot
    expect(now.session).toEqual(before.session); expect(now.inheritedEventCount).toBe(before.inheritedEventCount)
    expect(now.events.slice(0, before.events.length)).toEqual(before.events)
    expect(now.events.slice(before.events.length).map(e => e.seq)).toEqual([3, 4, 5, 6])
    expect(now.events.slice(before.events.length).map(e => e.type)).toEqual(['request/context', 'maestro/cli-child', 'step/start', 'assistant/attempt'])
    expect(h.creations[0]?.seed).toEqual(now.events); expect(h.states.get(HEADER.id)?.acceptedUsages).toHaveLength(1)
    expect(h.counts()).toMatchObject({ released: 1, opens: 1, writerCreates: 0 })
  })
  it.each([{ ...HEADER, id: SessionId('other') }, { ...HEADER, parentSession: SessionId('other') }, { ...HEADER, origin: undefined }])('refuses wrong cold header %j', async header => {
    const h = harness(), parts = withRead(h, async () => ({ ...cold(), session: header }))
    expect((await new NativeRecovery(parts).recover(RECORD)).status).toBe('skipped'); expect(h.creations).toHaveLength(0)
  })
  it('refuses inherited marker as own cold identity', async () => {
    const h = harness(), prior = cold()
    const parts = withRead(h, async () => ({ ...prior, session: { ...HEADER, isSeeded: true }, inheritedEventCount: prior.events.length }))
    expect((await new NativeRecovery(parts).recover(RECORD)).status).toBe('skipped')
  })
  it('skips live declaration-only and unavailable own projection, never requiring a disk writer', async () => {
    const h = harness(); h.store.create(HEADER.id, { seed: cold(false).events, meta: { parentSession: HEADER.parentSession!, origin: 'subagent' } })
    expect((await new NativeRecovery(h.parts).recover(RECORD)).reason).toBe('live-native-usage-unknown-or-conflicting')
    h.setProjectionReady(false); expect((await new NativeRecovery(h.parts).recover(RECORD)).reason).toBe('live-projection-unknown')
    expect(h.counts().queryReads).toBe(0)
  })
  it('one matching cold sample cannot mask duplicate or unknown extra usage', async () => {
    for (const usage of [USAGE, { inputTokens: null, outputTokens: 3 }]) {
      const h = harness(), prior = cold(); prior.events.push(event(5, 'assistant/attempt', { stream: [{ type: 'chunk', time: 1004, chunk: { type: 'usage', usage } }] })); h.physical.set(HEADER.id, prior)
      expect((await new NativeRecovery(h.parts).recover(RECORD)).reason).toBe('cold-native-usage-unknown-or-conflicting')
      expect(h.creations).toHaveLength(0)
    }
  })
  it('one matching live sample cannot mask another unknown event', async () => {
    const h = harness(); h.store.create(HEADER.id, { seed: cold().events, meta: { parentSession: HEADER.parentSession!, origin: 'subagent' } })
    h.live.get(HEADER.id)!.append('assistant/attempt', { stream: [{ type: 'chunk', time: 1004, chunk: { type: 'usage', usage: { inputTokens: null, outputTokens: 3 } } }] } as never)
    expect((await new NativeRecovery(h.parts).recover(RECORD)).reason).toBe('live-native-usage-unknown-or-conflicting')
  })
  it('query error/undefined/bad shape is not automatically physical absence', async () => {
    for (const readSession of [async () => { throw new Error('permission denied') }, async () => undefined, async () => ({})]) {
      const h = harness()
      expect((await new NativeRecovery(withRead(h, readSession)).recover(RECORD)).status).not.toBe('recovered')
      expect(h.counts().writerCreates).toBe(0); expect(h.creations).toHaveLength(0)
    }
  })
  it('weak NotFound on a corrupt physical generation refuses create and preserves it', async () => {
    const h = harness(); h.physical.set(HEADER.id, 'corrupt')
    expect((await new NativeRecovery(h.parts).recover(RECORD)).status).toBe('failed')
    expect(h.physical.get(HEADER.id)).toBe('corrupt'); expect(h.creations).toHaveLength(0)
  })
  it('a false-negative query cannot overwrite an existing complete physical log', async () => {
    const h = harness(), prior = cold(); h.physical.set(HEADER.id, prior)
    const parts = withRead(h, async () => { throw { code: 'M_QUERY_NOT_FOUND' } })
    expect((await new NativeRecovery(parts).recover(RECORD)).status).toBe('failed')
    expect(h.physical.get(HEADER.id)).toEqual(prior); expect(h.creations).toHaveLength(0)
  })
  it('independent recovery instances respect public create ownership/no-overwrite competition', async () => {
    const h = harness()
    const results = await Promise.all([new NativeRecovery(h.parts).recover(RECORD), new NativeRecovery(h.parts).recover(RECORD)])
    expect(results.map(x => x.status).sort()).toEqual(['failed', 'recovered'])
    expect(h.creations).toHaveLength(1); expect((h.physical.get(HEADER.id) as Snapshot).events).toHaveLength(4)
    expect(h.counts().released).toBe(1); expect(h.owned.size).toBe(0)
  })
  it('a final publish competitor after create is not overwritten', async () => {
    const h = harness(), foreign = cold()
    h.onStage(name => { if (name === 'flush') h.physical.set(HEADER.id, foreign) })
    expect((await new NativeRecovery(h.parts).recover(RECORD)).status).toBe('failed')
    expect(h.physical.get(HEADER.id)).toEqual(foreign); expect(h.creations).toHaveLength(0); expect(h.owned.size).toBe(0)
  })
  it.each([{ id: SessionId('foreign') }, { access: 'read' as const }, { inheritedEventCount: SessionLogOffset(1) }, { header: { ...HEADER, parentSession: SessionId('foreign') } }])('rejects and closes wrong public writer identity %j', async fields => {
    const h = harness()
    const persistence: NativeRecoveryPersistence = { ...h.persistence,
      async create(header, options) { return { ...await h.persistence.create(header, options), ...fields } } }
    const result = await new NativeRecovery({ ...h.parts, persistence: () => persistence }).recover(RECORD)
    expect(result.reason).toBe('public-writer-identity-invalid'); expect(h.counts().released).toBe(1)
    expect(h.creations).toHaveLength(0); expect(h.owned.size).toBe(0)
  })
  it('backend-owned generation rejects create without fallback/open', async () => {
    const h = harness(); h.owned.add(HEADER.id)
    expect((await new NativeRecovery(h.parts).recover(RECORD)).status).toBe('failed')
    expect(h.counts().opens).toBe(0); expect(h.creations).toHaveLength(0)
  })
  it('missing public query/persistence/epoch each fails closed before create', async () => {
    for (const fields of [{ query: () => undefined }, { persistence: () => undefined }, { bindingVersion: undefined }, { bindingVersion: () => NaN }]) {
      const h = harness()
      expect((await new NativeRecovery({ ...h.parts, ...fields }).recover(RECORD)).status).toBe('skipped')
      expect(h.counts().writerCreates).toBe(0); expect(h.creations).toHaveLength(0)
    }
  })
  it.each(['create', 'append', 'flush', 'close', 'verify'])('writer/read failure at %s never makes live and closes any acquired handle', async stage => {
    const h = harness(); h.failAt(stage)
    expect((await new NativeRecovery(h.parts).recover(RECORD)).status).toBe('failed')
    expect(h.creations).toHaveLength(0); expect(h.owned.size).toBe(0)
    if (stage !== 'create') expect(h.counts().released).toBe(1)
  })
  it('does not blind-retry an append/flush-failed reserved prefix as missing', async () => {
    const h = harness(), r = new NativeRecovery(h.parts); h.failAt('flush')
    expect((await r.recover(RECORD)).status).toBe('failed'); h.failAt('')
    expect((await r.recover(RECORD)).status).toBe('skipped')
    expect(h.counts().writerCreates).toBe(1); expect(h.creations).toHaveLength(0)
  })
  it('post-flush query mismatch retains durable observations but does not make live', async () => {
    const h = harness(); let reads = 0
    const parts = withRead(h, async id => {
      reads++; const value = await h.query.readSession(id)
      if (reads > 1 && typeof value === 'object' && value !== null) (value as Snapshot).events[0]!.time++
      return value
    })
    expect((await new NativeRecovery(parts).recover(RECORD)).reason).toBe('flushed-observation-query-mismatch')
    expect((h.physical.get(HEADER.id) as Snapshot).events).toHaveLength(4); expect(h.creations).toHaveLength(0)
  })
  it.each(['query', 'create', 'append', 'flush', 'close', 'verify'])('checks monotonic binding epoch after await at %s', async stage => {
    const h = harness(); h.onStage(name => { if (name === stage) h.bumpVersion() })
    expect((await new NativeRecovery(h.parts).recover(RECORD)).reason).toBe('public-bindings-changed')
    expect(h.creations).toHaveLength(0); expect(h.owned.size).toBe(0)
  })
  it.each(['store', 'query', 'persistence', 'identity'])('checks stable public %s across awaited operations', async what => {
    const h = harness(); h.onStage(name => { if (name === 'append') {
      if (what === 'store') h.changeStore(); if (what === 'query') h.changeQuery(); if (what === 'persistence') h.changePersistence(); if (what === 'identity') h.changeIdentity()
    } })
    expect((await new NativeRecovery(h.parts).recover(RECORD)).reason).toBe('public-bindings-changed')
    expect(h.creations).toHaveLength(0); expect(h.owned.size).toBe(0)
  })
  it('persistence disappearance behind an ambiguous NotFound does not create', async () => {
    const h = harness(); h.onStage(name => { if (name === 'query') h.dropPersistence() })
    expect((await new NativeRecovery(h.parts).recover(RECORD)).reason).toBe('public-bindings-changed'); expect(h.counts().writerCreates).toBe(0)
  })
  it('rechecks live after initial query and refuses foreign identity collision', async () => {
    const h = harness(), parts = withRead(h, async () => { h.store.create(HEADER.id, { meta: { parentSession: SessionId('foreign'), origin: 'subagent' } }); return cold() })
    expect((await new NativeRecovery(parts).recover(RECORD)).reason).toBe('live-identity-mismatch'); expect(h.counts().writerCreates).toBe(0)
  })
  it('preserves seeded inherited cut and header metadata while supplementing only own zero usage', async () => {
    const h = harness(), prior = cold(false)
    prior.session = { ...HEADER, isSeeded: true, cwd: '/safe-audit-work', delegationDepth: 2 }
    prior.inheritedEventCount = 2
    prior.events = [...prior.events.slice(0, 2), event(2, 'session/end-seed', { inherited: true }), event(3, 'maestro/cli-child', MARKER)]
    const before = structuredClone(prior); h.physical.set(HEADER.id, prior)
    const result = await new NativeRecovery(h.parts).recover(RECORD)
    expect(result, `${h.schemaErrors.join('\n')}\n${h.trace.join(',')}`).toMatchObject({ status: 'recovered' })
    expect(h.creations[0]?.inheritedEventCount).toBe(2); expect(h.creations[0]?.meta).toMatchObject({ isSeeded: true, cwd: '/safe-audit-work', delegationDepth: 2, createdAt: 888 })
    expect((h.physical.get(HEADER.id) as Snapshot).events.slice(0, before.events.length)).toEqual(before.events)
    expect(h.live.get(HEADER.id)?.inheritedEventCount).toBe(2); expect(h.states.get(HEADER.id)?.usageEventCount).toBe(1)
  })
  it('refuses a seeded cut without the existing SDK-owned boundary before any writer open/append', async () => {
    const h = harness(), prior = cold(false)
    prior.session = { ...HEADER, isSeeded: true }; prior.inheritedEventCount = 2
    const before = structuredClone(prior); h.physical.set(HEADER.id, prior)
    expect((await new NativeRecovery(h.parts).recover(RECORD)).reason).toBe('cold-identity-or-seed-invalid')
    expect(h.trace).not.toContain('open'); expect(h.trace).not.toContain('append'); expect(h.creations).toHaveLength(0)
    expect(h.physical.get(HEADER.id)).toEqual(before)
  })
  it('preserves existing final text and never invents a task/final response in the suffix', async () => {
    const h = harness(), prior = cold(false)
    prior.events.push(event(3, 'assistant/message', { message: { id: 'kept-final', role: 'assistant', content: [{ type: 'text', text: 'existing final text' }], source: { kind: 'model', provider: 'p', model: 'm' } }, turn: 1, step: 1, stream: [] }, true))
    const before = structuredClone(prior); h.physical.set(HEADER.id, prior)
    const result = await new NativeRecovery(h.parts).recover(RECORD)
    expect(result, `${h.schemaErrors.join('\n')}\n${h.trace.join(',')}`).toMatchObject({ status: 'recovered' })
    const now = h.physical.get(HEADER.id) as Snapshot
    expect(now.events.slice(0, before.events.length)).toEqual(before.events)
    expect(now.events.slice(before.events.length).every(e => e.type !== 'user/message' && e.type !== 'assistant/message')).toBe(true)
  })
  it('warm repeats and a later cold restore never duplicate an existing supplemented spend', async () => {
    const h = harness(); h.physical.set(HEADER.id, cold(false)); const r = new NativeRecovery(h.parts)
    expect((await Promise.all([r.recover(RECORD), r.recover(RECORD), r.recover(RECORD)])).map(x => x.status)).toEqual(['recovered', 'already-present', 'already-present'])
    const saved = structuredClone(h.physical.get(HEADER.id)); h.live.delete(HEADER.id)
    expect((await new NativeRecovery(h.parts).recover(RECORD)).reason).toBe('preserved-old-seed-no-recharge')
    expect(h.physical.get(HEADER.id)).toEqual(saved); expect(h.counts().opens).toBe(1)
  })
  it('independent cold-existing recoveries compete for one public write ownership', async () => {
    const h = harness(); h.physical.set(HEADER.id, cold(false))
    const results = await Promise.all([new NativeRecovery(h.parts).recover(RECORD), new NativeRecovery(h.parts).recover(RECORD)])
    expect(results.map(x => x.status).sort()).toEqual(['failed', 'recovered'])
    expect((h.physical.get(HEADER.id) as Snapshot).events).toHaveLength(7); expect(h.counts().released).toBe(1)
  })
  it('native writer busy respects foreign ownership without appending or claiming success', async () => {
    const h = harness(), prior = cold(false), before = structuredClone(prior); h.physical.set(HEADER.id, prior); h.owned.add(HEADER.id)
    expect((await new NativeRecovery(h.parts).recover(RECORD)).status).toBe('failed')
    expect(h.physical.get(HEADER.id)).toEqual(before); expect(h.trace).not.toContain('append')
    expect(h.owned.has(HEADER.id)).toBe(true); expect(h.counts().released).toBe(0)
  })
  it.each(['extra', 'changed', 'short', 'reordered'])('rejects cold prefix %s race observed by bounded public read', async change => {
    const h = harness(), prior = cold(false); h.physical.set(HEADER.id, prior)
    h.onStage(stage => { if (stage === 'read') {
      if (change === 'extra') prior.events.push(event(3, 'request/context', { provider: 'other', model: 'm' }))
      if (change === 'changed') prior.events[0]!.time++
      if (change === 'short') prior.events.pop()
      if (change === 'reordered') prior.events.reverse()
    } })
    expect((await new NativeRecovery(h.parts).recover(RECORD)).reason).toBe('cold-prefix-changed-or-incomplete')
    expect(h.readWindows).toEqual([{ offset: 0, length: 4 }]); expect(h.trace).not.toContain('append'); expect(h.owned.size).toBe(0)
  })
  it('unknown trailing usage appearing before bounded read is never supplemented', async () => {
    const h = harness(), prior = cold(false); h.physical.set(HEADER.id, prior)
    h.onStage(stage => { if (stage === 'read') prior.events.push(event(3, 'assistant/attempt', { stream: [{ type: 'chunk', time: 1004, chunk: { type: 'usage', usage: { inputTokens: null, outputTokens: 3 } } }] })) })
    expect((await new NativeRecovery(h.parts).recover(RECORD)).reason).toBe('cold-prefix-changed-or-incomplete'); expect(h.trace).not.toContain('append')
  })
  it('nextseq race after successful read is rejected by backend rather than rewriting prefix', async () => {
    const h = harness(), prior = cold(false); h.physical.set(HEADER.id, prior)
    h.onStage(stage => { if (stage === 'append') prior.events.push(event(3, 'request/context', { provider: 'other', model: 'm' })) })
    expect((await new NativeRecovery(h.parts).recover(RECORD)).status).toBe('failed')
    expect(prior.events).toHaveLength(4); expect(h.trace).not.toContain('flush'); expect(h.creations).toHaveLength(0); expect(h.owned.size).toBe(0)
  })
  it('a live session appearing during bounded read closes cold writer without appending', async () => {
    const h = harness(); h.physical.set(HEADER.id, cold(false))
    h.onStage(stage => { if (stage === 'read') h.live.set(HEADER.id, { id: HEADER.id, header: { ...HEADER, parentSession: SessionId('foreign') }, inheritedEventCount: SessionLogOffset(0), append: (() => { throw new Error('unused') }) as NativeRecoverySession['append'] }) })
    expect((await new NativeRecovery(h.parts).recover(RECORD)).reason).toBe('live-session-appeared-before-cold-append'); expect(h.trace).not.toContain('append'); expect(h.owned.size).toBe(0)
  })
  it.each(['open', 'read', 'append', 'flush', 'close', 'verify'])('checks cold-existing epoch after every await at %s', async stage => {
    const h = harness(); h.physical.set(HEADER.id, cold(false)); h.onStage(name => { if (name === stage) h.bumpVersion() })
    expect((await new NativeRecovery(h.parts).recover(RECORD)).reason).toBe('public-bindings-changed'); expect(h.creations).toHaveLength(0); expect(h.owned.size).toBe(0)
  })
  it.each(['store', 'query', 'persistence', 'identity'])('checks stable cold-existing %s facade during read', async what => {
    const h = harness(); h.physical.set(HEADER.id, cold(false)); h.onStage(name => { if (name === 'read') {
      if (what === 'store') h.changeStore(); if (what === 'query') h.changeQuery(); if (what === 'persistence') h.changePersistence(); if (what === 'identity') h.changeIdentity()
    } })
    expect((await new NativeRecovery(h.parts).recover(RECORD)).reason).toBe('public-bindings-changed'); expect(h.trace).not.toContain('append'); expect(h.owned.size).toBe(0)
  })
  it.each(['open', 'read', 'append', 'flush', 'close', 'verify'])('cold-existing public operation failure at %s never makes live', async stage => {
    const h = harness(); h.physical.set(HEADER.id, cold(false)); h.failAt(stage)
    expect((await new NativeRecovery(h.parts).recover(RECORD)).status).toBe('failed'); expect(h.creations).toHaveLength(0); expect(h.owned.size).toBe(0)
    if (stage !== 'open') expect(h.counts().released).toBe(1)
  })
  it.each([{ id: SessionId('foreign') }, { access: 'read' as const }, { inheritedEventCount: SessionLogOffset(1) }, { header: { ...HEADER, createdAt: 999 } }])('rejects wrong cold open handle %j before read/append', async fields => {
    const h = harness(); h.physical.set(HEADER.id, cold(false))
    const persistence: NativeRecoveryPersistence = { ...h.persistence, async open(id, access, options) { return { ...await h.persistence.open(id, access, options), ...fields } } }
    expect((await new NativeRecovery({ ...h.parts, persistence: () => persistence }).recover(RECORD)).reason).toBe('public-writer-identity-invalid')
    expect(h.trace).not.toContain('read'); expect(h.trace).not.toContain('append'); expect(h.owned.size).toBe(0)
  })
  it.each(['prefix', 'suffix', 'cut', 'header', 'extra'])('post-flush cold query mismatch in %s prevents make-live', async change => {
    const h = harness(); h.physical.set(HEADER.id, cold(false)); let reads = 0
    const parts = withRead(h, async id => {
      reads++; const value = await h.query.readSession(id) as Snapshot
      if (reads > 1) {
        if (change === 'prefix') value.events[0]!.time++
        if (change === 'suffix') value.events[3]!.time++
        if (change === 'cut') value.inheritedEventCount = 1
        if (change === 'header') value.session = { ...value.session, createdAt: value.session.createdAt + 1 }
        if (change === 'extra') value.events.push(event(value.events.length, 'request/context', { provider: 'p', model: 'm' }))
      }
      return value
    })
    expect((await new NativeRecovery(parts).recover(RECORD)).reason).toBe('flushed-existing-observation-query-mismatch')
    expect((h.physical.get(HEADER.id) as Snapshot).events).toHaveLength(7); expect(h.creations).toHaveLength(0)
  })
  it('rechecks live after durable write/query and refuses foreign replacement', async () => {
    const h = harness(); h.onStage(name => { if (name === 'verify') h.store.create(HEADER.id, { meta: { parentSession: SessionId('foreign'), origin: 'subagent' } }) })
    expect((await new NativeRecovery(h.parts).recover(RECORD)).reason).toBe('live-identity-mismatch'); expect(h.creations).toHaveLength(1)
  })
})
