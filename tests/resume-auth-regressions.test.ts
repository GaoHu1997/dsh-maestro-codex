import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { effectiveOf } from '../src/config.js'
import { CliPathCache, runDispatch, type DispatchDeps, type DispatchParams, type DispatchValue } from '../src/dispatch.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { StatusStore, handleOverview, handleTasks, handleTaskDetail, handleTaskCancel, handleTaskReply, type RouteDeps } from '../src/routes.js'
import { SessionAccessRegistry, installSessionAccessProjection } from '../src/session-access.js'
import { cliUsageProjectionDefinition } from '../src/usage.js'
import { persistedOf } from '../src/persist.js'
import { registerDispatchTool, type ToolExec } from '../src/tool.js'
import { scriptedSpawn, type FakeChild } from './fake-child.js'

// M-layer tests: real authorization/runner/registry with scripted child processes.
// No real CLI, host HTTP transport or cross-plugin acceptance is claimed.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(hold = false) {
  const config = effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath })
  config.claude.dshModel = 'test-provider::test-model'
  const launched = deferred<FakeChild>()
  const settled = deferred<void>()
  const spawn = scriptedSpawn(child => {
    if (child.spawnArgs[0] === '--version') child.finish('claude version 9.9.9')
    else if (!child.spawnArgs.includes('-p')) child.finish('')
    else if (hold) launched.resolve(child)
    else child.finish(JSON.stringify({ type: 'result', subtype: 'success', result: 'finished', session_id: 'thread-1' }))
  })
  const registry = new TaskRegistry(), controllers = new Map<string, AbortController>()
  const limiter = new Limiter(() => 1)
  const childSessions = { start: vi.fn(), settle: vi.fn() }
  const deps: RouteDeps = { readConfig: () => config, registry, controllers, limiter, childSessions,
    pathCache: new CliPathCache(() => config, spawn.spawnFn), spawnFn: spawn.spawnFn,
    resolveDshModel: async () => ({ provider: 'test-provider', model: 'test-model', api: 'anthropic-messages', baseURL: 'https://example.invalid', apiKey: 'not-a-real-key' }),
    statusStore: new StatusStore(() => config), toolName: () => 'dispatch_cli_task', listDshModels: async () => ({ providers: [] }),
    listMcpServers: () => [], persist: () => settled.resolve() }
  function anchor(id: string, owner = 'owner-A', reference = 'thread-1') {
    const task = registry.create({ id, cli: 'claude', title: id, model: 'test-model', cwd: process.cwd(), sessionId: owner })
    task.stats = { sessionRef: reference, dshModel: 'test-provider::test-model' }
    task.prompt = 'private owner prompt'
    task.finalText = 'private owner result'
    registry.setPhase(task, 'done')
    return task
  }
  return { config, registry, controllers, limiter, childSessions, deps, spawn, launched, settled, anchor }
}
function trustedPrincipal(owner: string) {
  const access = new SessionAccessRegistry()
  type Projection = { init(header: unknown, inheritedEventCount: number): unknown; wire: { view(state: unknown): { token: string } | null } }
  let projection: Projection | undefined
  installSessionAccessProjection({ sessionProjections: { register(value: unknown) { projection = value as Projection } } }, access)
  const append = vi.fn()
  access.publish(owner, { id: owner, append })
  // The host has already authorized this header; no caller-supplied HTTP ID mints access.
  const delivered = projection?.wire.view(projection.init({ id: owner }, 0))
  const principal = access.authorize(delivered?.token)
  expect(append).not.toHaveBeenCalled()
  if (principal === undefined) throw new Error('test trusted capability was not admitted')
  return principal
}
const assessment = { taskDifficulty: 'medium', difficultyReason: 'scoped implementation and verification of multiple steps' } as const
const newParams = (extra: Partial<DispatchParams> = {}): DispatchParams => ({ ...assessment, cli: 'claude', task: 'continue', sessionId: 'owner-A', ...extra })

describe('server-admitted B capability cannot be widened by supplied sessions or a known A id', () => {
  it.each([
    { label: 'omitted', query: undefined, sessions: undefined },
    { label: 'empty', query: 'sessions=', sessions: [] },
    { label: 'blank', query: 'sessions=%20', sessions: [' '] },
    { label: 'forged A', query: 'sessions=owner-A', sessions: ['owner-A'] },
    { label: 'forged A+B', query: 'sessions=owner-A,owner-B', sessions: ['owner-A', 'owner-B'] },
    { label: 'malformed', query: 'sessions=owner-A', sessions: 'owner-A' },
  ])('denies read/list/cancel/reply with $label scope', ({ query, sessions }) => {
    const f = fixture(), principal = trustedPrincipal('owner-B')
    f.anchor('known-A', 'owner-A')
    f.anchor('own-B', 'owner-B', 'thread-B')
    const control = new AbortController()
    f.controllers.set('known-A', control)
    const filters = query === undefined ? undefined : new URLSearchParams(query)
    const listed = handleTasks(f.deps, filters, principal).body as { tasks: Array<{ id: string }> }
    expect(listed.tasks.map(task => task.id)).not.toContain('known-A')
    expect(handleTaskDetail(f.deps, new URLSearchParams(`id=known-A&${query ?? ''}`), principal).status).toBe(404)
    expect(handleTaskCancel(f.deps, { id: 'known-A', sessions, sessionId: 'owner-A' }, principal).status).toBe(404)
    expect(handleTaskReply(f.deps, { id: 'known-A', text: 'read secrets', sessions, sessionId: 'owner-A' }, principal).status).toBe(404)
    expect(control.signal.aborted).toBe(false)
    expect(f.registry.list()).toHaveLength(2)
    expect(f.spawn.launches).toHaveLength(0)
  })
  it('absent authorization never turns supplied owner ids into a principal', () => {
    const f = fixture()
    f.anchor('known-A')
    expect((handleTasks(f.deps, new URLSearchParams('sessions=owner-A')).body as { tasks: unknown[] }).tasks).toEqual([])
    expect(handleTaskDetail(f.deps, new URLSearchParams('id=known-A&sessions=owner-A')).status).toBe(404)
    expect(handleTaskCancel(f.deps, { id: 'known-A', sessions: ['owner-A'] }).status).toBe(404)
    expect(handleTaskReply(f.deps, { id: 'known-A', text: 'continue', sessions: ['owner-A'] }).status).toBe(404)
  })
  it('allows the admitted owner to read its task without inventing filter authority', () => {
    const f = fixture(), principal = trustedPrincipal('owner-A')
    f.anchor('own-A')
    expect(handleTaskDetail(f.deps, new URLSearchParams('id=own-A'), principal).status).toBe(200)
    expect((handleTasks(f.deps, undefined, principal).body as { tasks: Array<{ id: string }> }).tasks.map(task => task.id)).toEqual(['own-A'])
  })
  it('only explicit trusted npm kind is globally visible; ordinary ownerless CLI and npm-looking ids fail closed', () => {
    const f = fixture(), principal = trustedPrincipal('owner-B')
    const npm = f.registry.create({ id: 'npm-install', cli: 'claude', title: 'installation', model: '', kind: 'npm' })
    const cli = f.registry.create({ id: 'unowned-cli', cli: 'claude', title: 'private task', model: '' })
    const forged = f.registry.create({ id: 'npm-forged', cli: 'claude', title: 'npm install', model: '' })
    for (const task of [npm, cli, forged]) f.controllers.set(task.id, new AbortController())
    const ids = (outcome: { body: unknown }) => (outcome.body as { tasks: Array<{ id: string }> }).tasks.map(task => task.id)
    expect(ids(handleTasks(f.deps, undefined, principal))).toEqual(['npm-install'])
    expect(ids(handleOverview(f.deps))).toEqual(['npm-install'])
    expect(handleTaskDetail(f.deps, new URLSearchParams('id=npm-install')).status).toBe(200)
    expect(handleTaskCancel(f.deps, { id: 'npm-install' }).status).toBe(200)
    for (const id of ['unowned-cli', 'npm-forged']) {
      expect(handleTaskDetail(f.deps, new URLSearchParams(`id=${id}`), principal).status).toBe(404)
      expect(handleTaskCancel(f.deps, { id }, principal).status).toBe(404)
      expect(handleTaskReply(f.deps, { id, text: 'continue' }, principal).status).toBe(404)
      expect(f.controllers.get(id)?.signal.aborted).toBe(false)
    }
  })
  it('restored legacy ownerless records without trusted kind do not gain global npm authority', () => {
    const f = fixture()
    f.registry.restore({ id: 'npm-legacy-cli', cli: 'claude', title: 'npm-looking legacy', phase: 'done', startedAt: 1 })
    expect((handleTasks(f.deps).body as { tasks: unknown[] }).tasks).toEqual([])
    expect(handleTaskDetail(f.deps, new URLSearchParams('id=npm-legacy-cli')).status).toBe(404)
  })
})

describe('tool resume ownership, reference, executor and cwd are all bound before task creation', () => {
  it('observer and child-record failures never leak a resume lock or suppress parent settlement', async () => {
    const f = fixture()
    f.anchor('anchor-A')
    const append = vi.fn()
    const persist = vi.fn()
    f.deps.persist = persist
    const fail = () => { throw new Error('synthetic observer failure') }
    f.childSessions.start.mockImplementation(fail)
    f.childSessions.settle.mockImplementation(fail)
    const value = await runDispatch(f.deps, newParams({ resume: 'thread-1', usageSession: { append } }), new AbortController().signal,
      { onTaskId: fail, onEvent: fail, onPhase: fail })
    expect(value.ok).toBe(true)
    expect(f.registry.resumeBusy('claude', 'thread-1')).toBe(false)
    expect(f.controllers.size).toBe(0)
    expect(append).not.toHaveBeenCalled()
    expect(persist).toHaveBeenCalledTimes(1)
    const reply = f.registry.list().find(task => task.replyTo === 'anchor-A')
    expect(reply?.phase).toBe('done')
    const definition = cliUsageProjectionDefinition()
    const projected = definition.wire.view(definition.init({ id: 'owner-A' }, 0))
    expect(projected.recent.filter(record => record.taskId === reply?.id)).toEqual([
      expect.objectContaining({ taskId: reply?.id, sessionId: 'owner-A', phase: 'done' }),
    ])
    const other = definition.wire.view(definition.init({ id: 'owner-B' }, 0))
    expect(other.recent.some(record => record.taskId === reply?.id)).toBe(false)
  })
  it.each([false, true])('inherits persisted thinking unless explicitly overridden: override=%s', async override => {
    const f = fixture()
    const anchor = f.anchor('anchor-A')
    anchor.stats = { ...anchor.stats, dshThinking: 'high' }
    f.config.claude.thinking = 'low'
    await runDispatch(f.deps, newParams({ resume: 'thread-1', ...(override ? { thinking: 'low' } : {}) }), new AbortController().signal)
    const resumed = f.registry.list().find(task => task.replyTo === anchor.id)
    expect(resumed).toBeDefined()
    expect(f.registry.get(resumed!.id)?.stats?.['dshThinking']).toBe(override ? 'low' : 'high')
  })
  it.each([
    { extra: { sessionId: 'owner-B' }, error: /不属于/ },
    { extra: { sessionId: undefined }, error: /可信父会话/ },
    { extra: { resume: 'unknown-thread' }, error: /不存在/ },
    { extra: { replyTo: 'unknown-anchor' }, error: /锚点/ },
    { extra: { cli: 'codex' }, error: /执行器/ },
    { extra: { cwd: `${process.cwd()}/not-the-anchor` }, error: /cwd/ },
  ])('rejects $extra without creating a task, controller or child', async ({ extra, error }) => {
    const f = fixture()
    f.anchor('anchor-A')
    await expect(runDispatch(f.deps, newParams({ resume: 'thread-1', ...extra }), new AbortController().signal)).rejects.toThrow(error)
    expect(f.registry.list()).toHaveLength(1)
    expect(f.controllers.size).toBe(0)
    expect(f.childSessions.start).not.toHaveBeenCalled()
    expect(f.spawn.launches).toHaveLength(0)
    expect(f.registry.resumeBusy('claude', 'thread-1')).toBe(false)
  })
  it('a model-supplied sessionId cannot override exec.agent owner in the registered tool', async () => {
    const f = fixture()
    f.anchor('anchor-A')
    let execute!: (args: unknown, exec: ToolExec) => Promise<DispatchValue>
    registerDispatchTool({ tools: { register(value: unknown) { execute = (value as { execute: typeof execute }).execute; return () => {} } } } as unknown as Context, f.deps)
    await expect(execute({ task: 'continue', cli: 'claude', resume: 'thread-1', sessionId: 'owner-A',
      task_difficulty: 'medium', difficulty_reason: 'implementation and tests' }, { signal: new AbortController().signal, agent: { id: 'owner-B' } })).rejects.toThrow(/不属于/)
    expect(f.registry.list()).toHaveLength(1)
    expect(f.controllers.size).toBe(0)
  })
  it('correct owner/ref/executor inherits the exact anchor cwd and releases its terminal claim', async () => {
    const f = fixture(), anchor = f.anchor('anchor-A')
    const value = await runDispatch(f.deps, newParams({ resume: 'thread-1', cli: 'auto' }), new AbortController().signal)
    expect(value.ok).toBe(true)
    expect(value.cli).toBe(anchor.cli)
    expect(value.cwd).toBe(anchor.cwd)
    const reply = f.registry.list().find(task => task.replyTo === anchor.id)
    expect(reply?.phase).toBe('done')
    expect(reply?.sessionId).toBe('owner-A')
    expect(f.controllers.size).toBe(0)
    expect(f.registry.resumeBusy('claude', 'thread-1')).toBe(false)
  })
})

describe('synchronous same-thread reservation crosses historical anchors and releases on settlement', () => {
  it('a second UI resume on another anchor returns 409 before any duplicate child starts', async () => {
    const f = fixture(true), principal = trustedPrincipal('owner-A')
    f.anchor('anchor-1')
    f.anchor('anchor-2')
    const first = handleTaskReply(f.deps, { id: 'anchor-1', text: 'continue one' }, principal)
    expect(first.status).toBe(200)
    expect(f.registry.resumeBusy('claude', 'thread-1')).toBe(true)
    const second = handleTaskReply(f.deps, { id: 'anchor-2', text: 'continue two' }, principal)
    expect(second.status).toBe(409)
    expect(f.registry.list()).toHaveLength(3)
    await vi.waitFor(() => expect(f.spawn.launches.map(launch => launch.spawnArgs)).toContainEqual(expect.arrayContaining(['-p'])))
    const child = f.spawn.launches.find(launch => launch.spawnArgs.includes('-p'))
    expect(child).toBeDefined()
    child?.finish(JSON.stringify({ type: 'result', subtype: 'success', result: 'finished', session_id: 'thread-1' }))
    await vi.waitFor(() => expect({ phase: f.registry.get((first.body as { id: string }).id)?.phase,
      controllers: f.controllers.size, claim: f.registry.resumeBusy('claude', 'thread-1') }).toEqual({ phase: 'done', controllers: 0, claim: false }))
    expect(f.registry.resumeBusy('claude', 'thread-1')).toBe(false)
    expect(f.controllers.size).toBe(0)
    // A later continuation must be admitted rather than retaining the old claim.
    const next = handleTaskReply(f.deps, { id: 'anchor-2', text: 'after terminal' }, principal)
    expect(next.status).toBe(200)
    const taskId = (next.body as { id: string }).id
    await vi.waitFor(() => expect(f.spawn.launches.filter(launch => launch.spawnArgs.includes('-p'))).toHaveLength(2))
    f.spawn.launches.filter(launch => launch.spawnArgs.includes('-p')).at(-1)?.finish(JSON.stringify({ type: 'result', subtype: 'success', result: 'next finished', session_id: 'thread-1' }))
    await vi.waitFor(() => expect(f.controllers.has(taskId)).toBe(false))
    expect(f.registry.resumeBusy('claude', 'thread-1')).toBe(false)
  })
  it('the registry refuses a duplicate synchronous claim and releasing is idempotent', () => {
    const registry = new TaskRegistry()
    const release = registry.claimResume('claude', 'same-thread')
    expect(() => registry.claimResume('claude', 'same-thread')).toThrow(/已有续接/)
    expect(registry.resumeBusy('codex', 'same-thread')).toBe(false)
    release(); release()
    expect(registry.resumeBusy('claude', 'same-thread')).toBe(false)
  })
})

describe('persistence/replay never misrepresents a truncated task history as complete', () => {
  it('marks a 300-event history truncated when persisting only its 200-event tail and preserves it on replay', () => {
    const f = fixture(), task = f.anchor('history-tail')
    while (task.events.length < 300) f.registry.push(task, 'note', `history-${task.events.length}`)
    expect(task.truncated).toBe(false)
    const payload = persistedOf(task, 1234)
    expect(payload.events).toHaveLength(200)
    expect(payload.events[0]?.seq).toBe(101)
    expect(payload.events.at(-1)?.seq).toBe(300)
    expect(payload.truncated).toBe(true)
    const replay = new TaskRegistry()
    const restored = replay.restore(JSON.parse(JSON.stringify(payload)))
    expect(restored?.truncated).toBe(true)
    expect(replay.summaryOf(restored!)).toMatchObject({ truncated: true })
    expect(replay.eventsSince('history-tail', 300)?.events).toEqual([])
  })
  it('marks replay of a 4001-character detail truncated even when its old file forgot the flag', () => {
    const registry = new TaskRegistry()
    const restored = registry.restore({ id: 'detail-replay', cli: 'claude', title: 'history', phase: 'done', startedAt: 1,
      sessionId: 'owner-A', events: [{ seq: 1, at: 1, kind: 'note', text: 'short text', detail: 'x'.repeat(4001) }] })
    expect(restored?.truncated).toBe(true)
    expect(restored?.events[0]?.detail).toBe(`${'x'.repeat(4000)}…`)
    const payload = persistedOf(restored!, 1234)
    expect(payload.truncated).toBe(true)
    const again = new TaskRegistry().restore(JSON.parse(JSON.stringify(payload)))
    expect(again?.truncated).toBe(true)
    expect(again?.events[0]?.detail).toBe(`${'x'.repeat(4000)}…`)
  })
})

describe('preflight rejection settles without ghost running task or resource/child leak', () => {
  it.each(['throw', 'mismatch'] as const)('cleans up an asynchronous %s preflight failure and permits another dispatch', async mode => {
    const f = fixture()
    const deps: DispatchDeps = { ...f.deps, preflightDshModel: async () => {
      if (mode === 'throw') throw new Error('preflight rejection')
      return { status: 'mismatch', detail: 'preflight rejection' }
    } }
    await expect(runDispatch(deps, newParams(), new AbortController().signal)).rejects.toThrow('preflight rejection')
    expect(f.registry.list()).toHaveLength(1)
    expect(f.registry.list()[0]?.phase).toBe('failed')
    expect(f.registry.list()[0]?.endedAt).toEqual(expect.any(Number))
    expect(f.controllers.size).toBe(0)
    expect(f.spawn.launches.filter(child => child.spawnArgs[0] !== '--version')).toHaveLength(0)
    expect(f.childSessions.start).toHaveBeenCalledOnce()
    expect(f.childSessions.settle).toHaveBeenCalledOnce()
    expect(f.childSessions.settle.mock.calls[0]?.[0]).toMatchObject({ ok: false, stats: undefined })
    const slot = f.limiter.acquire(new AbortController().signal)
    await slot.waited
    slot.release()
    const later = await runDispatch(f.deps, newParams({ task: 'after failure' }), new AbortController().signal)
    expect(later.ok).toBe(true)
    expect(f.controllers.size).toBe(0)
  })
})
