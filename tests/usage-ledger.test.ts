import { beforeEach, describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { createChildSessionRecorder, CLI_CHILD_RECORD_EVENT } from '../src/child-session.js'
import {
  CLI_USAGE_EVENT, CLI_USAGE_RECENT_CAP, CLI_USAGE_PENDING_CAP, EMPTY_CLI_USAGE, applyCliUsage,
  cliTokenCountOf, cliUsageRecordOf, cliUsageProjectionDefinition, cliUsageIdentityOf, cliUsageQueueStatus,
  reportCliUsage, flushPendingCliUsage, pendingCliUsageCount, clearCliUsageMirrors,
  type CliUsageTask, type CliUsageRecord,
} from '../src/usage.js'

function task(overrides: Partial<CliUsageTask> = {}): CliUsageTask {
  return { id: 'ledger-task', cli: 'claude', model: 'm', phase: 'done', sessionId: 'ledger-parent',
    startedAt: 1_000, endedAt: 2_000, exitCode: 0, error: undefined,
    stats: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, cacheWriteTokens: 1, usageInputSemantics: 'uncached', usageProvider: 'provider' },
    ...overrides }
}
const event = (data: unknown) => ({ type: CLI_USAGE_EVENT, data })
beforeEach(() => clearCliUsageMirrors())
const visibleUsage = (sessionId: string) => {
  const definition = cliUsageProjectionDefinition()
  return definition.wire.view(definition.init({ id: sessionId }, 0))
}

describe('MA-14 positive CLI ledger invariants', () => {
  it.each([NaN, Infinity, -Infinity, -1, -0, '10', true])('does not fabricate a token zero from %s', raw => {
    const record = cliUsageRecordOf(task({ stats: { inputTokens: raw } }))
    expect(record.inputTokens).toBeNull()
    expect(record.outputTokens).toBeNull()
  })
  it('distinguishes an authoritative zero from unavailable stats', () => {
    const record = cliUsageRecordOf(task({ stats: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 } }))
    expect(record.inputTokens).toBe(0)
    expect(record.cacheWriteTokens).toBe(0)
    expect(cliUsageRecordOf(task({ stats: undefined })).inputTokens).toBeNull()
  })
  it.each(['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'durationMs', 'startedAt', 'endedAt'])('rejects nonfinite event field %s', key => {
    for (const value of [NaN, Infinity, -1, '8']) {
      const data = { ...cliUsageRecordOf(task()), [key]: value }
      expect(applyCliUsage(EMPTY_CLI_USAGE, event(data))).toBe(EMPTY_CLI_USAGE)
    }
  })
  it('ignores taskId-only and unsupported metadata instead of producing NaN', () => {
    const valid = cliUsageRecordOf(task())
    for (const data of [{ taskId: 'only' }, { ...valid, cli: 'external' }, { ...valid, phase: 'running' }, { ...valid, provider: {} }, { ...valid, inputSemantics: 'guessed' }]) {
      expect(applyCliUsage(EMPTY_CLI_USAGE, event(data))).toBe(EMPTY_CLI_USAGE)
    }
  })
  it('deduplicates a settlement even after it leaves recent and after JSON checkpoint replay', () => {
    const first = cliUsageRecordOf(task())
    let state = applyCliUsage(EMPTY_CLI_USAGE, event(first))
    for (let i = 0; i < CLI_USAGE_RECENT_CAP + 7; i++) state = applyCliUsage(state, event(cliUsageRecordOf(task({ id: `later-${i}` }))))
    expect(state.recent).toHaveLength(CLI_USAGE_RECENT_CAP)
    expect(state.totals.requests).toBe(28)
    expect(state.totals.inputTokens).toBe(280)
    expect(state.settledIds).toHaveLength(28)
    const restored = cliUsageProjectionDefinition().stateSchema.parse(JSON.parse(JSON.stringify(state)))
    expect(applyCliUsage(restored, event(first))).toBe(restored)
  })
  it('counts genuinely distinct starts/explicit attempt IDs of the same task', () => {
    const first = cliUsageRecordOf(task())
    const second = cliUsageRecordOf(task({ startedAt: 1_001 }))
    const attemptA = cliUsageRecordOf(task({ stats: { ...task().stats, usageAttemptId: 'actual-attempt-a' } }))
    const attemptB = cliUsageRecordOf(task({ stats: { ...task().stats, usageAttemptId: 'actual-attempt-b' } }))
    let state = EMPTY_CLI_USAGE
    for (const record of [first, second, attemptA, attemptB, attemptA]) state = applyCliUsage(state, event(record))
    expect(state.totals.requests).toBe(4)
    expect(state.totals.inputTokens).toBe(40)
  })
  it('retains unknown totals and known subtotals without losing later measured usage', () => {
    const measured = cliUsageRecordOf(task())
    const unavailable = cliUsageRecordOf(task({ id: 'unknown', stats: { outputTokens: 9 } }))
    const state = applyCliUsage(applyCliUsage(EMPTY_CLI_USAGE, event(unavailable)), event(measured))
    expect(state.totals).toMatchObject({ requests: 2, inputTokens: null, outputTokens: 13, cachedInputTokens: null })
    expect(state.knownTotals).toMatchObject({ requests: 2, inputTokens: 10, outputTokens: 13, cachedInputTokens: 2 })
  })
  it('keeps source and native child linkage explicit without writing native parent events', () => {
    const appended: { type: string; data: unknown }[] = []
    reportCliUsage({ id: 'ledger-parent', append(type: string, data: unknown) { appended.push({ type, data }) } }, task())
    expect(appended).toEqual([])
    expect(visibleUsage('ledger-parent').recent[0]).toMatchObject({ usageId: '["cli:claude","ledger-task",1000]', source: 'cli:claude',
      provider: 'provider', childSessionId: 'cli-ledger-task', parentSessionId: 'ledger-parent', inputSemantics: 'uncached' })
  })
  it('supports the legacy full record shape and stable fallback identity', () => {
    const record = cliUsageRecordOf(task())
    const { usageId: _id, source: _source, provider: _provider, childSessionId: _child, parentSessionId: _parent, inputSemantics: _semantics, ...legacy } = record
    const state = applyCliUsage(EMPTY_CLI_USAGE, event(legacy))
    expect(state.totals.requests).toBe(1)
    expect(cliUsageIdentityOf(legacy)).toBe(cliUsageIdentityOf(record))
    expect(applyCliUsage(state, event(legacy))).toBe(state)
  })
  it('validates totals, recent elements and settlement identities on the wire', () => {
    const definition = cliUsageProjectionDefinition()
    const state = applyCliUsage(EMPTY_CLI_USAGE, event(cliUsageRecordOf(task())))
    for (const invalid of [
      { ...state, totals: { ...state.totals, inputTokens: NaN } },
      { ...state, totals: { ...state.totals, requests: '1' } },
      { ...state, recent: [{ taskId: 'only' }] },
      { ...state, knownTotals: { ...state.knownTotals, outputTokens: Infinity } },
      { ...state, settledIds: ['a', 'a'] }, { ...state, settledIds: [false] },
    ]) expect(() => definition.wire.viewSchema.parse(invalid)).toThrow('not a maestro CLI usage state')
    expect(definition.stateSchema.parse({ totals: state.totals, recent: state.recent })).toBeDefined()
  })
  it('does not overflow finite bucket totals into Infinity', () => {
    const a = cliUsageRecordOf(task({ stats: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 } }))
    const b = cliUsageRecordOf(task({ id: 'overflow', stats: { inputTokens: 1, outputTokens: 0 } }))
    const state = applyCliUsage(applyCliUsage(EMPTY_CLI_USAGE, event(a)), event(b))
    expect(state.totals.inputTokens).toBeNull()
    expect(cliUsageProjectionDefinition().stateSchema.parse(state)).toBe(state)
  })
})

describe('partial actual attempts preserve known spend without inventing complete totals', () => {
  const keys = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens'] as const
  it.each(keys)('a known first attempt and missing second %s stays unknown with its observed subtotal', key => {
    const stats = { ...task().stats, usageAttempts: 2, [`usagePartial_${key}`]: true }
    const record = cliUsageRecordOf(task({ stats }))
    expect(cliTokenCountOf(stats, key)).toBeNull()
    expect(record[key]).toBeNull()
    expect(record.knownTokens?.[key]).toBe(task().stats?.[key])
    const state = applyCliUsage(EMPTY_CLI_USAGE, event(record))
    expect(state.totals[key]).toBeNull()
    expect(state.knownTotals?.[key]).toBe(task().stats?.[key])
  })
  it('two fully sampled attempts remain a complete total and need no partial metadata', () => {
    const record = cliUsageRecordOf(task({ stats: { inputTokens: 20, outputTokens: 8, cachedInputTokens: 4, cacheWriteTokens: 2, usageAttempts: 2 } }))
    expect(record).toMatchObject({ inputTokens: 20, outputTokens: 8, cachedInputTokens: 4, cacheWriteTokens: 2 })
    expect(record.knownTokens).toBeUndefined()
    const state = applyCliUsage(EMPTY_CLI_USAGE, event(record))
    expect(state.knownTotals).toEqual(state.totals)
  })
  it('counts the aggregate settlement once, preserves all partial subtotals and later known usage after JSON replay', () => {
    const partial = cliUsageRecordOf(task({ stats: { ...task().stats, usageAttempts: 2,
      usagePartial_inputTokens: true, usagePartial_outputTokens: true, usagePartial_cachedInputTokens: true, usagePartial_cacheWriteTokens: true } }))
    expect(partial).toMatchObject({ inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteTokens: null,
      knownTokens: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, cacheWriteTokens: 1 } })
    const once = applyCliUsage(EMPTY_CLI_USAGE, event(partial))
    expect(applyCliUsage(once, event(partial))).toBe(once)
    const restored = cliUsageProjectionDefinition().stateSchema.parse(JSON.parse(JSON.stringify(once)))
    expect(applyCliUsage(restored, event(partial))).toBe(restored)
    const state = applyCliUsage(restored, event(cliUsageRecordOf(task({ id: 'later-complete' }))))
    expect(state.totals).toMatchObject({ requests: 2, inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteTokens: null })
    expect(state.knownTotals).toMatchObject({ requests: 2, inputTokens: 20, outputTokens: 8, cachedInputTokens: 4, cacheWriteTokens: 2 })
  })
  it('preserves a measured zero subtotal as zero without calling the incomplete total zero', () => {
    const record = cliUsageRecordOf(task({ stats: { inputTokens: 0, usageAttempts: 2, usagePartial_inputTokens: true } }))
    expect(record.inputTokens).toBeNull()
    expect(record.knownTokens).toEqual({ inputTokens: 0 })
    const state = applyCliUsage(EMPTY_CLI_USAGE, event(record))
    expect(state.totals.inputTokens).toBeNull()
    expect(state.knownTotals?.inputTokens).toBe(0)
  })
  it('does not preserve an invalid subtotal or fabricate knownTokens for entirely unknown attempts', () => {
    const record = cliUsageRecordOf(task({ stats: { inputTokens: NaN, outputTokens: -1, usageAttempts: 2,
      usagePartial_inputTokens: true, usagePartial_outputTokens: true } }))
    expect(record.knownTokens).toBeUndefined()
    expect(record.inputTokens).toBeNull()
    expect(applyCliUsage(EMPTY_CLI_USAGE, event(record)).knownTotals?.inputTokens).toBe(0)
  })
  it.each([NaN, Infinity, -1, -0, null, '10', true])('rejects invalid optional knownTokens value %s in event and schema', value => {
    const base = cliUsageRecordOf(task({ stats: { inputTokens: 10, usagePartial_inputTokens: true } }))
    const data = { ...base, knownTokens: { inputTokens: value } }
    expect(applyCliUsage(EMPTY_CLI_USAGE, event(data))).toBe(EMPTY_CLI_USAGE)
    expect(() => cliUsageProjectionDefinition().stateSchema.parse({ ...EMPTY_CLI_USAGE, recent: [data] })).toThrow('not a maestro CLI usage state')
  })
  it('rejects unknown subtotal keys, inherited values and contradictory complete totals', () => {
    const base = cliUsageRecordOf(task())
    for (const knownTokens of [{ fakeTokens: 10 }, { inputTokens: 11 }, { inputTokens: undefined }, Object.create({ inputTokens: 10 })]) {
      expect(applyCliUsage(EMPTY_CLI_USAGE, event({ ...base, knownTokens }))).toBe(EMPTY_CLI_USAGE)
    }
  })
  it('mirrors lossless partial knownTokens without changing the installed Session', () => {
    const session = Session.create('partial-native-parent')
    reportCliUsage(session, task({ sessionId: 'partial-native-parent', stats: { inputTokens: 10, usagePartial_inputTokens: true, usageAttempts: 2 } }))
    expect(session.seq).toBe(0)
    const record = visibleUsage(session.id).recent[0]
    expect(record?.inputTokens).toBeNull()
    expect(record?.knownTokens?.inputTokens).toBe(10)
  })
  function childEvents(stats: CliUsageTask['stats']) {
    const events: Array<{ type: string; data: Record<string, unknown>; ignorable?: true }> = []
    const recorder = createChildSessionRecorder({ store: () => ({ create: (_id, options) => {
      for (const seed of options?.seed ?? []) events.push({ type: seed.type, data: seed.data as Record<string, unknown>, ...(seed.ignorable === true ? { ignorable: true as const } : {}) })
      return { append(type, data) { events.push({ type, data: data as Record<string, unknown> }) } }
    } }), readConfig: () => ({ recordChildSessions: true }) })
    recorder.start({ taskId: 'partial-child', cli: 'claude', startedAt: 1000, label: 'partial', taskText: 'task', cwd: 'D:/work',
      parentSessionId: 'partial-parent', parentSession: { append() {} } })
    recorder.settle({ taskId: 'partial-child', ok: true, stats, route: { provider: 'provider', model: 'model' }, finalText: 'finished' })
    return events
  }
  it.each(['inputTokens', 'outputTokens'])('does not write a misleading native sample when required %s is partial', key => {
    const events = childEvents({ ...task().stats, usageAttempts: 2, [`usagePartial_${key}`]: true })
    expect(events.find(e => e.type === 'assistant/message')?.data).not.toHaveProperty('usage')
    expect(events.filter(e => e.type === CLI_CHILD_RECORD_EVENT)).toHaveLength(1)
    expect(events.find(e => e.type === CLI_CHILD_RECORD_EVENT)?.ignorable).toBe(true)
  })
  it('omits a partial native optional cache bucket and potentially stale provider total', () => {
    const events = childEvents({ ...task().stats, totalTokens: 17, usageAttempts: 2, usagePartial_cachedInputTokens: true })
    const usage = events.find(e => e.type === 'assistant/message')?.data['usage']
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 4, cacheWriteTokens: 1 })
  })
  it('still writes fully observed aggregate native buckets', () => {
    const events = childEvents({ inputTokens: 20, outputTokens: 8, cachedInputTokens: 4, cacheWriteTokens: 2, totalTokens: 34,
      usageAttempts: 2, usageInputSemantics: 'uncached' })
    expect(events.find(e => e.type === 'assistant/message')?.data['usage']).toEqual({ inputTokens: 20, outputTokens: 8, cacheReadTokens: 4, cacheWriteTokens: 2, totalTokens: 34 })
  })
})

describe('real installed host safety and live-only queue', () => {
  it('leaves native parent history untouched while preserving unavailable usage', () => {
    const session = Session.create('native-usage-parent')
    const before = session.seq
    reportCliUsage(session, task({ sessionId: 'native-usage-parent', exitCode: undefined, error: undefined, stats: undefined }))
    expect(session.seq).toBe(before)
    expect(visibleUsage(session.id).totals.requests).toBe(1)
    expect(visibleUsage(session.id).recent[0]?.inputTokens).toBeNull()
  })
  it('does not report an unsettled preflight task', () => {
    const session = Session.create('preflight-parent')
    reportCliUsage(session, task({ sessionId: 'preflight-parent', phase: 'running' }))
    expect(session.seq).toBe(0)
  })
  it('queues an offline known parent and explicitly retries only the matching live parent', () => {
    const before = pendingCliUsageCount()
    const run = task({ sessionId: 'offline-ledger-parent' })
    reportCliUsage(undefined, run)
    reportCliUsage(undefined, run)
    expect(pendingCliUsageCount()).toBe(before + 1)
    expect(flushPendingCliUsage(Session.create('unrelated'), 'unrelated')).toBe(0)
    expect(flushPendingCliUsage(Session.create('wrong-target'), 'offline-ledger-parent')).toBe(0)
    const live = Session.create('offline-ledger-parent')
    expect(flushPendingCliUsage(live, 'offline-ledger-parent')).toBe(1)
    expect(live.seq).toBe(0)
    expect(visibleUsage(live.id).totals.requests).toBe(1)
    expect(flushPendingCliUsage(live, 'offline-ledger-parent')).toBe(0)
    expect(pendingCliUsageCount()).toBe(before)
  })
  it('bounds the live-only queue and exposes overflow instead of claiming durability', () => {
    const before = cliUsageQueueStatus()
    for (let i = 0; i <= CLI_USAGE_PENDING_CAP; i++) reportCliUsage(undefined, task({ id: `bounded-${i}`, sessionId: 'bounded-parent' }))
    expect(cliUsageQueueStatus().pending).toBe(CLI_USAGE_PENDING_CAP)
    expect(cliUsageQueueStatus().dropped).toBeGreaterThan(before.dropped)
    expect(flushPendingCliUsage(Session.create('bounded-parent'), 'bounded-parent')).toBe(CLI_USAGE_PENDING_CAP)
    expect(pendingCliUsageCount()).toBe(0)
  })
  it('does not create parentless records in the pending queue', () => {
    const before = pendingCliUsageCount()
    reportCliUsage(undefined, task({ sessionId: undefined }))
    expect(pendingCliUsageCount()).toBe(before)
  })
})
