import { describe, expect, it, vi } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { CLI_CHILD_RECORD_EVENT, createChildSessionRecorder, type ChildSessionAppend, type ChildSessionStoreFace } from '../src/child-session.js'

interface RecordedEvent { readonly type: string; readonly data: Record<string, unknown>; readonly opts: { surfaceOp?: 'append' } | undefined; readonly ignorable?: true }
interface FakeSession { readonly id: string; readonly meta: { cwd?: string; parentSession?: string; origin?: string } | undefined; readonly events: RecordedEvent[]; readonly appended: RecordedEvent[] }
function fakeStore(beforeAppend: (type: string, data: unknown) => void = () => {}): { store: ChildSessionStoreFace; sessions: Map<string, FakeSession>; parent: ChildSessionAppend & { events: RecordedEvent[] }; setParentOnline(value: boolean): void } {
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
      })) as RecordedEvent[], appended: [] as RecordedEvent[] }
      sessions.set(id, record)
      return { header: { createdAt: 1234 }, append(type, data, opts) {
        beforeAppend(type, data)
        const event = { type, data: data as Record<string, unknown>, opts }
        record.events.push(event)
        record.appended.push(event)
      } }
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
const nativeEvents = (events: RecordedEvent[]) => events.filter(e => e.type !== CLI_CHILD_RECORD_EVENT && e.type !== 'request/context' && e.type !== 'session/title')

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
    expect(session?.events[2]).toEqual({ type: 'session/title', ignorable: true,
      data: { title: START.label, messageSeqs: [], source: { kind: 'user' } }, opts: undefined })
  })
  it.each([['  真实任务名  ', '真实任务名'], [' \n\t ', 'cli-task-1']])('publishes a standalone title for label=%j', (label, title) => {
    const fake = fakeStore()
    recorder(fake.store).start({ ...START, label })
    expect(fake.sessions.get('cli-task-1')?.events.filter(e => e.type === 'session/title').map(e => e.data)).toEqual([
      { title, messageSeqs: [], source: { kind: 'user' } },
    ])
  })
  it('keeps the standalone title as an ignorable record so the persisted log retains it', () => {
    const fake = fakeStore()
    recorder(fake.store).start({ ...START })
    const titles = fake.sessions.get('cli-task-1')?.events.filter(event => event.type === 'session/title') ?? []
    expect(titles).toHaveLength(1)
    expect(titles[0]?.ignorable).toBe(true)
    expect(titles[0]?.data).toEqual({ title: START.label, messageSeqs: [], source: { kind: 'user' } })
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
    expect(events.map(e => e.type)).toEqual(['user/message', 'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
    expect(events[1]?.data).toEqual({ turn: 1 })
    expect(events[2]?.data).toEqual({ turn: 1, step: 1 })
    expect(events[3]?.opts).toEqual({ surfaceOp: 'append' })
    expect(events[3]?.data).toMatchObject({ turn: 1, step: 1, stream: [], message: { role: 'assistant', source: { kind: 'model', ...ROUTE } },
      usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 56, cacheWriteTokens: 7 } })
    expect(events[4]?.data).toEqual({ turn: 1, step: 1 })
    expect(events[5]?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
    expect(all.find(e => e.type === 'request/context')?.data).toEqual(ROUTE)
    expect(fake.parent.events.map(e => e.type)).toEqual(['subagent/catalog'])
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
    const events = fake.sessions.get('cli-task-1')?.events ?? []
    expect(events.find(e => e.type === 'assistant/attempt')?.data).toMatchObject({ stream: [] })
    expect(events.map(e => e.type).slice(-2)).toEqual(['step/end', 'turn/end'])
  })
})

describe('CLI terminal lifecycle retries', () => {
  it.each([
    ['done', true, { kind: 'completed' }],
    ['failed', false, { kind: 'error', error: { code: 'CLI_FAILED', message: 'CLI task did not complete' } }],
    ['timeout', false, { kind: 'error', error: { code: 'CLI_TIMEOUT', message: 'CLI task timed out' } }],
    ['cancelled', false, { kind: 'aborted', reason: { kind: 'legacy' } }],
    ['interrupted', false, { kind: 'interrupted' }],
  ] as const)('closes phase=%s with its actual terminal reason', (phase, ok, reason) => {
    const fake = fakeStore(), child = recorder(fake.store)
    child.start(START)
    child.settle({ taskId: START.taskId, ok, phase, stats: USAGE, route: ROUTE, finalText: 'result' })
    expect(fake.sessions.get('cli-task-1')?.events.at(-1)).toMatchObject({ type: 'turn/end', data: { turn: 1, reason } })
  })
  it.each(['turn/start', 'request/context', 'step/start', 'assistant/message', 'step/end', 'turn/end'])('retries only the unaccepted suffix after a failure at %s', refusedType => {
    let refuse = true
    const fake = fakeStore(type => { if (type === refusedType && refuse) { refuse = false; throw new Error(`refused ${type}`) } })
    const child = recorder(fake.store)
    child.start(START)
    child.settle({ taskId: START.taskId, ok: true, stats: USAGE, route: ROUTE, finalText: 'original result' })
    // A later cumulative snapshot may differ. It must not create a second spend
    // or replace the frozen settlement after any event has been accepted.
    child.settle({ taskId: START.taskId, ok: false, phase: 'cancelled', stats: { inputTokens: 9999, outputTokens: 999 }, route: ROUTE, finalText: 'changed result' })
    expect(child.flushPending?.()).toBe(0)
    const events = fake.sessions.get('cli-task-1')?.events ?? []
    expect(events.map(e => e.type)).toEqual(['user/message', CLI_CHILD_RECORD_EVENT, 'session/title', 'turn/start', 'request/context', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
    expect(events.find(e => e.type === 'assistant/message')?.data).toMatchObject({ usage: { inputTokens: 1200, outputTokens: 340 }, message: { content: [{ type: 'text', text: 'original result' }] } })
    expect(events.at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
  })
  it('flushes a failed terminal closer without recharging its accepted usage', () => {
    let refuse = true
    const fake = fakeStore(type => { if (type === 'turn/end' && refuse) throw new Error('temporary closer refusal') })
    const child = recorder(fake.store)
    child.start(START)
    child.settle({ taskId: START.taskId, ok: false, stats: USAGE, route: ROUTE })
    expect(child.flushPending?.()).toBe(0)
    refuse = false
    expect(child.flushPending?.()).toBe(1)
    expect(child.flushPending?.()).toBe(0)
    expect(fake.sessions.get('cli-task-1')?.events.filter(e => e.type === 'assistant/attempt')).toHaveLength(1)
    expect(fake.sessions.get('cli-task-1')?.events.at(-1)?.type).toBe('turn/end')
  })
  it('does not publish native counters if the immutable usage identity changes', () => {
    const fake = fakeStore(), child = recorder(fake.store)
    child.start(START)
    child.settle({ taskId: START.taskId, ok: false, stats: { ...USAGE, usageAttemptId: 'other-spend' }, route: ROUTE })
    expect(fake.sessions.get('cli-task-1')?.events.find(e => e.type === 'assistant/attempt')?.data).toMatchObject({ stream: [] })
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
    expect(sessions.get('cli-task-1')?.seq).toBe(10)
    expect(sessions.get('cli-task-1')?.snapshotEvents().filter(event => event.type === 'session/title')).toMatchObject([
      { data: { title: START.label, messageSeqs: [], source: { kind: 'user' } } },
    ])
    const markers = (committed as Array<{ type: string; ignorable?: true }>).filter(event => event.type === CLI_CHILD_RECORD_EVENT)
    expect(markers).toHaveLength(1)
    expect(markers[0]?.ignorable).toBe(true)
    expect(parent.seq).toBe(1)
    expect(() => Session.create('cli-task-1', committed as Parameters<typeof Session.create>[1])).not.toThrow()
  })
})

describe('session logs stay loadable without a private append', () => {
  it('writes no private event type into the child or the parent session log', () => {
    const fake = fakeStore()
    const child = recorder(fake.store)
    child.start({ ...START, parentSession: fake.parent })
    child.settle({ taskId: 'task-1', ok: true, stats: USAGE, route: ROUTE, finalText: 'done' })
    const childEvents = fake.sessions.get('cli-task-1')?.events ?? []
    // The only private marker travels through the create() seed, whose public
    // contract preserves the explicit ignore marker. Everything appended must
    // stay a host-known type, or the parent log becomes unloadable.
    expect(childEvents.filter(e => e.type.startsWith('maestro/')).map(e => e.type)).toEqual([CLI_CHILD_RECORD_EVENT])
    expect(childEvents.find(e => e.type === CLI_CHILD_RECORD_EVENT)?.ignorable).toBe(true)
    expect(childEvents.every(e => e.type === CLI_CHILD_RECORD_EVENT || !e.type.startsWith('maestro/'))).toBe(true)
    expect(fake.parent.events.map(e => e.type)).toEqual(['subagent/catalog'])
  })
  it('settles without a live parent and appends nothing to it', () => {
    const fake = fakeStore()
    const child = recorder(fake.store)
    child.start({ ...START, parentSession: fake.parent })
    fake.setParentOnline(false)
    expect(() => child.settle({ taskId: 'task-1', ok: false, stats: { inputTokens: 50, outputTokens: 2 }, route: ROUTE })).not.toThrow()
    expect(fake.parent.events.map(e => e.type)).toEqual(['subagent/catalog'])
  })
})
