// Execute using the installed host's Electron Node mode. The Vitest wrapper
// supplies an in-memory source bundle whose SDK imports resolve inside app.asar.
// Storage faces below are explicit test doubles; the SDK append, v4 catalog,
// released-v4 relationship validation and Session.fromRestore are real host code.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const traceStarted = performance.now()
const trace = (phase, details = {}) => {
  if (process.env.DSH_HOST_TEST_TRACE !== '1') return
  const entry = { phase, at: Date.now(), ms: Math.round(performance.now() - traceStarted), pid: process.pid,
    resources: process.getActiveResourcesInfo(), cpu: process.cpuUsage(), ...details }
  const line = `${JSON.stringify(entry)}\n`
  process.stderr.write(line)
  if (process.env.DSH_HOST_TEST_TRACE_DIR) {
    fs.mkdirSync(process.env.DSH_HOST_TEST_TRACE_DIR, { recursive: true })
    fs.appendFileSync(path.join(process.env.DSH_HOST_TEST_TRACE_DIR, `format-${process.pid}.jsonl`), line)
  }
}
// Opt-in evidence: DSH_HOST_TEST_TRACE=1; DSH_HOST_TEST_TRACE_DIR can retain JSONL in repo .tmp.
trace('entry', { execPath: process.execPath, node: process.versions.node, electron: process.versions.electron,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE, connected: process.connected })
if (process.env.DSH_HOST_TEST_TRACE === '1') {
  process.on('beforeExit', code => trace('beforeExit', { code }))
  process.once('exit', code => trace('exit', { code }))
  setInterval(() => trace('still-active'), 5000).unref()
}
const root = process.env.DSH_SESSION_FORMAT_HOST_ROOT ?? 'D:/devlop/DeepSeek Harness/resources/app.asar/dsh'
const packageRoot = path.join(root, 'node_modules/@deepseek-ai')
const load = name => import(pathToFileURL(path.join(packageRoot, name, 'lib/index.js')).href)
trace('host-imports-start')
const [{ Session, SessionId, SessionLogOffset }, { sessionFormatCatalog }] = await Promise.all([
  load('dsh-session'), load('dsh-session-format-catalog'),
])
trace('host-imports-end')
trace('stdin-read-start')
const request = JSON.parse(fs.readFileSync(0, 'utf8'))
trace('stdin-read', { suite: request.suite, codeBytes: Buffer.byteLength(request.code) })
const plugin = await import(`data:text/javascript;base64,${Buffer.from(request.code).toString('base64')}`)
trace('plugin-import-end')
const versions = Object.fromEntries(['dsh-session', 'dsh-session-format-catalog', 'dsh-session-format-v3-to-v4'].map(name => [
  name, JSON.parse(fs.readFileSync(path.join(packageRoot, name, 'package.json'), 'utf8')).version,
]))
const completed = []
function complete(phase) { completed.push(phase); trace(phase) }
function snapshot(session) {
  return { session: session.header, inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents() }
}
function restore(value) {
  const physicalHeader = sessionFormatCatalog.encodeCurrentHeader(value.session, value.inheritedEventCount)
  const decoder = sessionFormatCatalog.createRestore(physicalHeader, { recovery: 'strict', validation: 'current' })
  for (const event of value.events) decoder.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
  const artifact = decoder.finish()
  assert.deepEqual(artifact.events, value.events)
  const restored = Session.fromRestore(artifact.header.id, artifact.events, artifact.header,
    artifact.inheritedEventCount, artifact.eventState)
  assert.equal(restored.id, value.session.id)
  return restored
}
function fold(value) {
  let state = plugin.initCliRecordState(value.session, value.inheritedEventCount)
  for (const event of value.events) state = plugin.applyCliRecordEvent(state, event)
  return state
}
const route = { provider: 'p', model: 'm' }
const usage = { inputTokens: 10, outputTokens: 3, cacheReadTokens: 2 }
const stats = { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2, usageInputSemantics: 'uncached' }
const start = { taskId: 'task-1', cli: 'codex', startedAt: 1000, label: 'cli task', taskText: 'historical task', cwd: 'D:/work', parentSessionId: 'parent-A' }
const marker = { version: 1, kind: 'cli-record', executor: 'external-cli', taskId: start.taskId,
  parentSessionId: start.parentSessionId, childSessionId: 'cli-task-1', usageId: 'usage-1', source: 'cli:codex',
  accounting: 'native-mirror-of-parent-cli-ledger', nativeInputSemantics: 'uncached' }
const record = { taskId: 'task-1', cli: 'codex', model: 'm', phase: 'done', sessionId: 'parent-A', parentSessionId: 'parent-A',
  childSessionId: 'cli-task-1', startedAt: 1000, endedAt: 2000, durationMs: 1000, inputTokens: 10, outputTokens: 3,
  cachedInputTokens: 2, cacheWriteTokens: null, usageId: 'usage-1', source: 'cli:codex', provider: 'p', inputSemantics: 'uncached' }
function header(meta = {}) {
  return { version: 4, id: SessionId('cli-task-1'), createdAt: 888, isSeeded: false,
    delegationDepth: 0, parentSession: SessionId('parent-A'), origin: 'subagent', ...meta }
}
function producer(beforeAppend = () => {}) {
  const sessions = new Map()
  const parent = Session.create(SessionId('parent-A'), undefined, { version: 4, id: SessionId('parent-A'), createdAt: 1, isSeeded: false, delegationDepth: 0 })
  const warnings = []
  const wrap = session => ({ header: session.header, append(type, data, opts) {
    if (session.id !== parent.id) beforeAppend(type)
    return opts === undefined ? session.append(type, data) : session.append(type, data, opts)
  } })
  const store = { get: id => id === parent.id ? wrap(parent) : sessions.get(id) && wrap(sessions.get(id)),
    create(id, options = {}) {
      assert(!sessions.has(id), 'producer must not recreate an existing child')
      const session = Session.create(SessionId(id), options.seed, header(options.meta), options.inheritedEventCount)
      sessions.set(id, session)
      return wrap(session)
    } }
  return { sessions, parent, warnings, recorder: plugin.createChildSessionRecorder({ store: () => store,
    readConfig: () => ({ recordChildSessions: true }), logger: { warn: message => warnings.push(message) } }) }
}
function inspectProducer(h, expectedCount = 1) {
  const child = h.sessions.get('cli-task-1')
  assert(child)
  const value = snapshot(child)
  restore(value)
  restore(snapshot(h.parent))
  assert.equal(fold(value).usageEventCount, expectedCount)
  assert.equal(fold(value).acceptedUsages.length, expectedCount)
  assert.equal(h.parent.snapshotEvents().filter(event => event.type === 'subagent/catalog').length, 1)
  assert.equal(value.events.filter(event => event.type === 'session/end-seed').length, 1)
  assert.equal(value.events.filter(event => event.type === plugin.CLI_CHILD_RECORD_EVENT).length, 1)
  assert(value.events.find(event => event.type === plugin.CLI_CHILD_RECORD_EVENT)?.ignorable)
  assert.deepEqual(value.events.filter(event => event.type === 'session/title').map(event => event.data), [
    { title: start.label, messageSeqs: [], source: { kind: 'user' } },
  ])
  return value
}
if (request.suite === 'producer') {
  for (const [phase, ok, kind, code] of [
    ['done', true, 'completed'], ['failed', false, 'error', 'CLI_FAILED'], ['timeout', false, 'error', 'CLI_TIMEOUT'],
    ['cancelled', false, 'aborted'], ['interrupted', false, 'interrupted'],
  ]) {
    const h = producer()
    h.recorder.start(start)
    restore(snapshot(h.sessions.get('cli-task-1')))
    h.recorder.settle({ taskId: start.taskId, ok, phase, stats, route, finalText: 'original result' })
    h.recorder.settle({ taskId: start.taskId, ok, phase, stats: { inputTokens: 999, outputTokens: 999 }, route, finalText: 'changed result' })
    const value = inspectProducer(h)
    const reason = value.events.at(-1).data.reason
    assert.equal(reason.kind, kind)
    if (code) assert.equal(reason.error.code, code)
    if (phase === 'cancelled') assert.deepEqual(reason.reason, { kind: 'legacy' })
    assert.equal(h.warnings.length, 0)
    complete(`terminal:${phase}`)
  }
  for (const [name, input] of [
    ['empty-output', { ok: true, stats, route, finalText: '' }],
    ['partial-counters', { ok: true, stats: { outputTokens: 3 }, route, finalText: 'text' }],
    ['unknown-route', { ok: true, stats, finalText: 'text' }],
    ['changed-identity', { ok: false, stats: { ...stats, usageAttemptId: 'other-spend' }, route }],
  ]) {
    const h = producer(); h.recorder.start(start)
    h.recorder.settle({ taskId: start.taskId, ...input })
    inspectProducer(h, name === 'empty-output' ? 1 : 0)
    complete(name)
  }
} else if (request.suite === 'retry') {
  for (const refusedType of ['turn/start', 'request/context', 'step/start', 'assistant/message', 'step/end', 'turn/end', 'assistant/attempt']) {
    let refuse = true
    const h = producer(type => { if (type === refusedType && refuse) { refuse = false; throw new Error(`refused ${type}`) } })
    h.recorder.start(start)
    const ok = refusedType !== 'assistant/attempt'
    h.recorder.settle({ taskId: start.taskId, ok, stats, route, finalText: 'original result' })
    // Every accepted intermediate prefix itself must pass the real v4 codec.
    restore(snapshot(h.sessions.get('cli-task-1')))
    h.recorder.settle({ taskId: start.taskId, ok: false, phase: 'cancelled', stats: { inputTokens: 999, outputTokens: 999 }, route, finalText: 'changed result' })
    const value = inspectProducer(h)
    assert.deepEqual(fold(value).acceptedUsages[0], { ...usage, usageId: '["cli:codex","task-1",1000]', source: 'cli:codex', ...route })
    assert.equal(value.events.at(-1).data.reason.kind, ok ? 'completed' : 'error')
    assert.equal(h.recorder.flushPending(), 0)
    complete(`retry:${refusedType}`)
  }
} else if (request.suite === 'recovery') {
  function prior(stage) {
    const seed = [
      { seq: 0, time: 888, type: 'user/message', data: { id: 'kept-task', role: 'user', content: [{ type: 'text', text: 'historical task' }], source: { kind: 'user' } }, surfaceOp: 'append' },
      { seq: 1, time: 888, type: plugin.CLI_CHILD_RECORD_EVENT, data: marker, ignorable: true },
    ]
    const session = Session.create(SessionId('cli-task-1'), seed, header({ cwd: 'D:/work', delegationDepth: 2 }), SessionLogOffset(0))
    if (stage !== 'declaration') {
      session.append('turn/start', { turn: 1 }); session.append('request/context', route)
      if (stage !== 'open-turn') {
        session.append('step/start', { turn: 1, step: 1 })
        if (stage !== 'open-step') {
          session.append('assistant/attempt', { turn: 1, step: 1,
            stream: stage === 'closed-zero' ? [] : [{ type: 'chunk', time: 1500, chunk: { type: 'usage', usage } }] })
          if (stage !== 'open-usage') session.append('step/end', { turn: 1, step: 1 })
          if (stage === 'closed-zero' || stage === 'closed-usage') session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        }
      }
    }
    return snapshot(session)
  }
  function recoveryHarness(initial) {
    const physical = new Map(initial ? [[initial.session.id, structuredClone(initial)]] : [])
    const live = new Map(), states = new Map(), owned = new Set()
    let creates = 0, appends = 0
    const projections = { sessionProjections: { stateOf: session => states.get(session.id) } }
    const store = { get: id => live.get(id), create(id, options = {}) {
      assert(!owned.has(id), 'make-live must follow writer close')
      const session = Session.create(id, options.seed, header(options.meta), options.inheritedEventCount)
      live.set(id, session); states.set(id, fold(snapshot(session)))
      return session
    } }
    const query = { async readSession(id) {
      const value = physical.get(id)
      if (!value) throw { code: 'M_QUERY_NOT_FOUND' }
      restore(value)
      return structuredClone(value)
    } }
    function handle(value) {
      let pending = [], closed = false
      owned.add(value.session.id)
      return { id: value.session.id, header: value.session, inheritedEventCount: value.inheritedEventCount, access: 'write',
        async read(offset = 0, length) { return { eventState: { nextSeq: value.events.length }, events: structuredClone(value.events.slice(offset, length === undefined ? undefined : offset + length)) } },
        async append(events) { assert(!closed); events.forEach((event, index) => assert.equal(event.seq, value.events.length + index)); pending = structuredClone(events); appends++ },
        async flush() { assert(!closed); const candidate = { ...value, events: [...value.events, ...pending] }; restore(candidate); value.events = candidate.events; pending = [] },
        async close() { closed = true; owned.delete(value.session.id) },
      }
    }
    const persistence = { identity: Symbol('host-test'), async create(value, options = {}) {
      assert(!physical.has(value.id) && !owned.has(value.id), 'create is no-overwrite')
      creates++
      const physicalHeader = sessionFormatCatalog.encodeCurrentHeader(value, options.inheritedEventCount ?? 0)
      sessionFormatCatalog.createRestore(physicalHeader, { recovery: 'strict', validation: 'current' }).finish()
      const stored = { session: structuredClone(value), inheritedEventCount: options.inheritedEventCount ?? 0, events: [] }
      physical.set(value.id, stored); return handle(stored)
    }, async open(id, access) { assert.equal(access, 'write'); assert(!owned.has(id)); assert(physical.has(id)); return handle(physical.get(id)) } }
    const parts = { store: () => store, projections: () => projections, query: () => query, persistence: () => persistence,
      bindingVersion: () => 0, isNotFound: () => true }
    return { physical, live, parts, counts: () => ({ creates, appends }), clearLive() { live.clear(); states.clear() } }
  }
  for (const stage of ['missing', 'declaration', 'open-turn', 'open-step', 'closed-zero', 'open-usage', 'usage-step-closed', 'closed-usage']) {
    const initial = stage === 'missing' ? undefined : prior(stage)
    if (initial) restore(initial)
    const h = recoveryHarness(initial)
    const result = await new plugin.NativeRecovery(h.parts).recover(record)
    assert.equal(result.status, 'recovered', `${stage}: ${JSON.stringify(result)}`)
    const value = h.physical.get('cli-task-1')
    restore(value)
    const state = fold(value)
    assert.equal(state.usageEventCount, 1, stage)
    assert.equal(state.acceptedUsages.length, 1, stage)
    if (initial) {
      assert.deepEqual(value.session, initial.session)
      assert.deepEqual(value.events.slice(0, initial.events.length), initial.events)
      assert.equal(value.inheritedEventCount, initial.inheritedEventCount)
    }
    assert.equal(value.events.at(-1).type, 'turn/end')
    assert.equal(value.events.at(-1).data.reason.kind, 'completed')
    const before = structuredClone(value), counts = h.counts()
    h.clearLive()
    assert.equal((await new plugin.NativeRecovery(h.parts).recover(record)).reason, 'preserved-old-seed-no-recharge')
    assert.deepEqual(h.physical.get('cli-task-1'), before)
    assert.deepEqual(h.counts(), counts)
    complete(`recovery:${stage}`)
  }
  const legacy = { session: header(), inheritedEventCount: 0, events: [
    { seq: 0, time: 1000, type: 'request/context', data: route },
    { seq: 1, time: 1000, type: plugin.CLI_CHILD_RECORD_EVENT, data: marker, ignorable: true },
    { seq: 2, time: 1000, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 3, time: 1000, type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: 1000, chunk: { type: 'usage', usage } }] } },
  ] }
  assert.throws(() => restore(legacy), /request\/context is outside an open turn/)
  const h = recoveryHarness(legacy)
  assert.equal((await new plugin.NativeRecovery(h.parts).recover(record)).reason, 'stored-session-format-invalid-migration-required')
  assert.deepEqual(h.physical.get('cli-task-1'), legacy)
  assert.deepEqual(h.counts(), { creates: 0, appends: 0 })
  complete('legacy:explicit-migration-required-no-overwrite')
} else throw new Error(`unknown suite ${request.suite}`)
console.log(JSON.stringify({ versions, suite: request.suite, completed }))
trace('report-written')
