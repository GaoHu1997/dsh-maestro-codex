import { describe, expect, it, vi } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { CLI_CHILD_RECORD_EVENT, CLI_USAGE_LIVE_EVENT, createChildSessionRecorder, type ChildSessionAppend, type ChildSessionStoreFace } from '../src/child-session.js'

interface RecordedEvent { readonly type: string; readonly data: Record<string, unknown>; readonly opts: { surfaceOp?: 'append' } | undefined; readonly ignorable?: true }
interface FakeSession { readonly id: string; readonly meta: { cwd?: string; parentSession?: string; origin?: string } | undefined; readonly events: RecordedEvent[] }
function fakeStore(): { store: ChildSessionStoreFace; sessions: Map<string, FakeSession>; parent: ChildSessionAppend & { events: RecordedEvent[] }; setParentOnline(value: boolean): void } {
  const sessions = new Map<string, FakeSession>()
  const parentEvents: RecordedEvent[] = []
  const parent = { events: parentEvents, append(type: string, data: unknown, opts?: { surfaceOp?: 'append' }) { parentEvents.push({ type, data: data as Record<string, unknown>, opts }) } }
  let parentOnline = true
  const store: ChildSessionStoreFace = {
    get: id => parentOnline && id === 'session-parent' ? parent : undefined,
    create(id, options) {
      if (sessions.has(id)) throw new Error(`session "${id}" already exists`)
      const record = { id, meta: options?.meta, events: (options?.seed ?? []).map(event => ({
        type: event.type, data: event.data as unknown as Record<string, unknown>,
        opts: event.surfaceOp === 'append' ? { surfaceOp: 'append' as const } : undefined,
        ...(event.ignorable === true ? { ignorable: true as const } : {}),
      })) as RecordedEvent[] }
      sessions.set(id, record)
      return { header: { createdAt: 1234 }, append(type, data, opts) { record.events.push({ type, data: data as Record<string, unknown>, opts }) } }
    },
  }
  return { store, sessions, parent, setParentOnline(value) { parentOnline = value } }
}
function recorder(store: ChildSessionStoreFace | undefined, recordChildSessions = true) {
  return createChildSessionRecorder({ store: () => store, readConfig: () => ({ recordChildSessions }), logger: { warn: vi.fn() } })
}
const START = { taskId: 'task-1', cli: 'claude', startedAt: 1000, label: 'cli · 数据任务', taskText: '整理数据并输出报表', cwd: 'D:/work', parentSessionId: 'session-parent' } as const
const USAGE = { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 56, cacheWriteTokens: 7, usageInputSemantics: 'uncached' } as const
const ROUTE = { provider: 'ofox', model: 'gpt-6.1-sol' }
const nativeEvents = (events: RecordedEvent[]) => events.filter(e => e.type !== CLI_CHILD_RECORD_EVENT && e.type !== CLI_USAGE_LIVE_EVENT && e.type !== 'request/context')

describe('CLI record session start', () => {
  it('creates native parent lineage and a one-shot catalog without pretending DSH continuation', () => {
    const fake = fakeStore()
    recorder(fake.store).start({ ...START, parentSession: fake.parent })
    const session = fake.sessions.get('cli-task-1')
    expect(session?.meta).toEqual({ cwd: 'D:/work', parentSession: 'session-parent', origin: 'subagent' })
    expect(session?.meta).not.toHaveProperty('readonly')
    const seed = session?.events[0]
    expect(seed?.type).toBe('user/message')
    expect(seed?.opts).toEqual({ surfaceOp: 'append' })
    expect(seed?.data).toMatchObject({ id: 'task-1-task', role: 'user', content: [{ type: 'text', text: '整理数据并输出报表' }], source: { kind: 'user' } })
    const row = fake.parent.events[0]
    expect(row?.type).toBe('subagent/catalog')
    expect(Object.keys(row?.data ?? {}).sort()).toEqual(['childCreatedAt', 'childId', 'label', 'mode', 'version'])
    expect(row?.data).toEqual({ version: 0, childId: 'cli-task-1', childCreatedAt: 1234, mode: 'one-shot', label: 'cli · 数据任务' })
    expect(session?.events[1]?.data).toMatchObject({ kind: 'cli-record', executor: 'external-cli', parentSessionId: 'session-parent',
      childSessionId: 'cli-task-1', usageId: '["cli:claude","task-1",1000]', source: 'cli:claude', accounting: 'native-mirror-of-parent-cli-ledger' })
  })
  it('does nothing without a parent identity, a store, or when switched off', () => {
    const fake = fakeStore()
    recorder(undefined).start({ ...START, parentSession: fake.parent })
    recorder(fake.store).start({ ...START, parentSessionId: undefined })
    recorder(fake.store, false).start({ ...START, parentSession: fake.parent })
    expect(fake.parent.events).toEqual([])
    expect(fake.sessions.size).toBe(0)
  })
  it('records an offline parent child and retries catalog through the real live get seam', () => {
    const fake = fakeStore()
    fake.setParentOnline(false)
    const child = recorder(fake.store)
    child.start(START)
    expect(fake.sessions.has('cli-task-1')).toBe(true)
    expect(fake.parent.events).toEqual([])
    expect(child.flushPending?.()).toBe(0)
    fake.setParentOnline(true)
    expect(child.flushPending?.()).toBe(1)
    expect(child.flushPending?.()).toBe(0)
    expect(fake.parent.events).toHaveLength(1)
  })
  it('survives a refusing store and leaves the parent untouched', () => {
    const fake = fakeStore()
    expect(() => recorder({ create() { throw new Error('refused') } }).start({ ...START, parentSession: fake.parent })).not.toThrow()
    expect(fake.parent.events).toEqual([])
  })
  it('ignores a repeated start while the original task is live', () => {
    const fake = fakeStore()
    const child = recorder(fake.store)
    child.start({ ...START, parentSession: fake.parent })
    child.start({ ...START, parentSession: fake.parent })
    expect(fake.sessions.size).toBe(1)
    expect(fake.parent.events).toHaveLength(1)
  })
})

describe('CLI native settlement', () => {
  it('appends one source-attributed assistant message, with explicit route for public attribution', () => {
    const fake = fakeStore()
    const child = recorder(fake.store)
    child.start({ ...START, parentSession: fake.parent })
    child.settle({ taskId: 'task-1', ok: true, stats: USAGE, route: ROUTE, finalText: '完成了' })
    child.settle({ taskId: 'task-1', ok: true, stats: USAGE, route: ROUTE, finalText: '重复' })
    const all = fake.sessions.get('cli-task-1')?.events ?? []
    const events = nativeEvents(all)
    expect(events.map(e => e.type)).toEqual(['user/message', 'step/start', 'assistant/message'])
    expect(events[1]?.data).toEqual({ turn: 1, step: 1 })
    expect(events[2]?.opts).toEqual({ surfaceOp: 'append' })
    expect(events[2]?.data).toMatchObject({ turn: 1, step: 1, stream: [], message: { role: 'assistant', source: { kind: 'model', ...ROUTE } },
      usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 56, cacheWriteTokens: 7 } })
    expect(all.find(e => e.type === 'request/context')?.data).toEqual(ROUTE)
    expect(fake.parent.events.map(e => e.type)).toEqual(['subagent/catalog', CLI_USAGE_LIVE_EVENT])
  })
  it('attributes a failed attempt through request/context without fake optional zeros', () => {
    const fake = fakeStore()
    const child = recorder(fake.store)
    child.start({ ...START, parentSession: fake.parent })
    child.settle({ taskId: 'task-1', ok: false, stats: { inputTokens: 50, outputTokens: 2 }, route: ROUTE })
    const all = fake.sessions.get('cli-task-1')?.events ?? []
    const attempt = all.find(e => e.type === 'assistant/attempt')
    expect(attempt?.opts).toBeUndefined()
    expect(attempt?.data).toEqual({ turn: 1, step: 1, stream: [{ type: 'chunk', time: expect.any(Number), chunk: { type: 'usage', usage: { inputTokens: 50, outputTokens: 2 } } }] })
    expect(all.find(e => e.type === 'request/context')?.data).toEqual(ROUTE)
  })
  it('preserves measured all-zero usage rather than calling it unavailable', () => {
    const fake = fakeStore()
    const child = recorder(fake.store)
    child.start(START)
    child.settle({ taskId: 'task-1', ok: true, stats: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 }, route: ROUTE, finalText: 'ok' })
    expect(fake.sessions.get('cli-task-1')?.events.find(e => e.type === 'assistant/message')?.data['usage']).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })
  it.each([undefined, { outputTokens: 9 }, { inputTokens: NaN, outputTokens: 1 }, { inputTokens: 10, outputTokens: 1, usageInputSemantics: 'unknown' }, { inputTokens: 10, outputTokens: 1, usageInputSemantics: 'includes-cache' }, { inputTokens: 10, outputTokens: 1, usageInputSemantics: 'guessed' }])('keeps unrepresentable native counters usage-free: %s', stats => {
    const fake = fakeStore()
    const child = recorder(fake.store)
    child.start(START)
    child.settle({ taskId: 'task-1', ok: true, stats, route: ROUTE, finalText: '好了' })
    const all = fake.sessions.get('cli-task-1')?.events ?? []
    expect(all.find(e => e.type === 'assistant/message')?.data).not.toHaveProperty('usage')
    expect(all.filter(e => e.type === CLI_CHILD_RECORD_EVENT)).toHaveLength(1)
    expect(all.find(e => e.type === CLI_CHILD_RECORD_EVENT)?.ignorable).toBe(true)
  })
  it('does not derive a native total by summing CLI buckets', () => {
    const fake = fakeStore()
    const child = recorder(fake.store)
    child.start(START)
    child.settle({ taskId: 'task-1', ok: true, stats: USAGE, route: ROUTE, finalText: 'ok' })
    expect(fake.sessions.get('cli-task-1')?.events.find(e => e.type === 'assistant/message')?.data['usage']).not.toHaveProperty('totalTokens')
  })
  it.each([1540, 1603])('preserves only an explicit total covering all known disjoint buckets: %s', totalTokens => {
    const fake = fakeStore()
    const child = recorder(fake.store)
    child.start(START)
    child.settle({ taskId: 'task-1', ok: true, stats: { ...USAGE, totalTokens }, route: ROUTE, finalText: 'ok' })
    const usage = fake.sessions.get('cli-task-1')?.events.find(e => e.type === 'assistant/message')?.data['usage']
    if (totalTokens === 1603) expect(usage).toHaveProperty('totalTokens', 1603)
    else expect(usage).not.toHaveProperty('totalTokens')
  })
  it('records a success without route as an attempt and ignores an unknown task', () => {
    const fake = fakeStore()
    const child = recorder(fake.store)
    child.settle({ taskId: 'missing', ok: true, stats: USAGE })
    child.start(START)
    child.settle({ taskId: 'task-1', ok: true, stats: USAGE, route: { provider: 'claude', model: '' }, finalText: 'ok' })
    expect(fake.sessions.get('cli-task-1')?.events.some(e => e.type === 'assistant/attempt')).toBe(true)
  })
})

describe('real installed Session append contract (not cross-plugin R acceptance)', () => {
  it.each([true, false])('accepts and replays the native events for ok=%s', ok => {
    const sessions = new Map<string, Session>()
    const committed: unknown[] = []
    const parent = Session.create('real-parent')
    const wrap = (session: Session): ChildSessionAppend => ({ header: session.header,
      append(type, data, opts) {
        // Runtime validation comes from the installed host, not this structural
        // adapter. Captured return events are replayed by Session.create below.
        const append = session.append.bind(session) as unknown as ChildSessionAppend['append']
        const result = opts === undefined ? append(type, data) : append(type, data, opts)
        if (session.id !== 'real-parent') committed.push(result)
        return result
      },
    })
    const store: ChildSessionStoreFace = { create(id, options) {
      const session = Session.create(id, options?.seed, undefined, options?.inheritedEventCount)
      // Tests may inspect the complete constructor snapshot, including the
      // core session/end-seed event generated by the real host.
      committed.push(...session.snapshotEvents())
      sessions.set(id, session); return wrap(session)
    }, get(id) { return id === 'real-parent' ? wrap(parent) : undefined } }
    const warn = vi.fn()
    const child = createChildSessionRecorder({ store: () => store, readConfig: () => ({ recordChildSessions: true }), logger: { warn } })
    child.start({ ...START, parentSessionId: 'real-parent', parentSession: wrap(parent) })
    child.settle({ taskId: 'task-1', ok, stats: USAGE, route: ROUTE, finalText: 'ok' })
    expect(warn).not.toHaveBeenCalled()
    expect(sessions.get('cli-task-1')?.seq).toBe(7)
    const markers = (committed as Array<{ type: string; ignorable?: true }>).filter(event => event.type === CLI_CHILD_RECORD_EVENT)
    expect(markers).toHaveLength(1)
    expect(markers[0]?.ignorable).toBe(true)
    expect(parent.seq).toBe(2)
    expect(() => Session.create('cli-task-1', committed as Parameters<typeof Session.create>[1])).not.toThrow()
  })
})

describe('CLI live usage snapshots', () => {
  it('throttles running snapshots and leaves one durable settlement on the parent', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(10_000)
      const fake = fakeStore()
      const child = recorder(fake.store)
      child.start({ ...START, parentSession: fake.parent })
      const liveOf = () => (fake.sessions.get('cli-task-1')?.events ?? []).filter(e => e.type === CLI_USAGE_LIVE_EVENT)
      child.reportLive({ taskId: 'task-1', stats: USAGE, route: ROUTE })
      expect(liveOf()).toHaveLength(1)
      expect(liveOf()[0]?.data).toMatchObject({
        version: 1, kind: 'live', phase: 'running',
        taskId: 'task-1', childSessionId: 'cli-task-1', parentSessionId: 'session-parent',
        provider: 'ofox', model: 'gpt-6.1-sol', turn: 1, step: 1,
        usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 56, cacheWriteTokens: 7 },
      })
      // Identical counters inside the window: no duplicate snapshot.
      child.reportLive({ taskId: 'task-1', stats: USAGE, route: ROUTE })
      expect(liveOf()).toHaveLength(1)
      // New counters still wait for the throttle window.
      child.reportLive({ taskId: 'task-1', stats: { ...USAGE, inputTokens: 1500 }, route: ROUTE })
      expect(liveOf()).toHaveLength(1)
      vi.setSystemTime(12_500)
      child.reportLive({ taskId: 'task-1', stats: { ...USAGE, inputTokens: 1500 }, route: ROUTE })
      expect(liveOf()).toHaveLength(2)
      expect(liveOf()[1]?.data['usage']).toMatchObject({ inputTokens: 1500 })
      // Settlement closes the child row and writes the parent's durable copy.
      vi.setSystemTime(20_000)
      child.settle({ taskId: 'task-1', ok: true, stats: { ...USAGE, inputTokens: 1600 }, route: ROUTE, finalText: 'done' })
      const settledChild = liveOf().filter(e => e.data['kind'] === 'settled')
      expect(settledChild).toHaveLength(1)
      expect(settledChild[0]?.data).toMatchObject({ phase: 'done', usage: { inputTokens: 1600, outputTokens: 340 } })
      const parentRow = fake.parent.events.find(e => e.type === CLI_USAGE_LIVE_EVENT)
      expect(parentRow?.data).toMatchObject({
        kind: 'settled', phase: 'done', childSessionId: 'cli-task-1', parentSessionId: 'session-parent',
        usage: { inputTokens: 1600, outputTokens: 340 },
      })
      // A snapshot after settlement has no live record to write.
      vi.setSystemTime(30_000)
      child.reportLive({ taskId: 'task-1', stats: USAGE, route: ROUTE })
      expect(liveOf()).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })
  it('skips incomplete samples and tolerates an offline parent at settlement', () => {
    const fake = fakeStore()
    const child = recorder(fake.store)
    child.start({ ...START, parentSession: fake.parent })
    // No input/output pair: nothing representable can be reported.
    child.reportLive({ taskId: 'task-1', stats: { outputTokens: 9 } })
    expect((fake.sessions.get('cli-task-1')?.events ?? []).filter(e => e.type === CLI_USAGE_LIVE_EVENT)).toHaveLength(0)
    fake.setParentOnline(false)
    expect(() => child.settle({ taskId: 'task-1', ok: false, stats: { inputTokens: 50, outputTokens: 2 }, route: ROUTE })).not.toThrow()
    expect(fake.parent.events.filter(e => e.type === CLI_USAGE_LIVE_EVENT)).toHaveLength(0)
  })
})
