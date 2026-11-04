import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { effectiveOf } from '../src/config.js'
import { CliPathCache } from '../src/dispatch.js'
import { handleTaskCancel, handleTaskDetail, handleTaskReply, handleTasks, type RouteDeps } from '../src/routes.js'
import { Limiter, TaskRegistry, type MaestroTask } from '../src/task-registry.js'
import { loadPersistedTasks, persistTask } from '../src/persist.js'
import { restoreInterrupted } from '../src/recovery.js'
import type { EffectRow } from '../src/effects.js'
import { scriptedSpawn } from './fake-child.js'
import { resolveTestDshModel, withTestDshRoutes } from './dsh-route-fixture.js'

const forbidden = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('node:child_process', () => {
  const reject = (name: string) => (..._args: unknown[]) => { forbidden.calls.push(name); throw new Error(`Forbidden real process in reply authorization regression: ${name}`) }
  return { spawn: reject('spawn'), execFile: reject('execFile'), exec: reject('exec'), spawnSync: reject('spawnSync'), execSync: reject('execSync'), execFileSync: reject('execFileSync') }
})
const dirs: string[] = []
beforeEach(() => {
  forbidden.calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Real network forbidden in reply authorization regression') }))
})
afterEach(async () => {
  expect(forbidden.calls).toEqual([])
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function fixture(cli: 'claude' | 'codex' = 'claude') {
  const config = withTestDshRoutes(effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath, injectGitContext: false, failureRetries: 0 }))
  const registry = new TaskRegistry()
  const spawn = scriptedSpawn(child => {
    expect(child.pid).toBeUndefined()
    child.onStdin = () => child.finish((cli === 'codex' ? [
      { type: 'thread.started', thread_id: 'reply-auth-thread' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'isolated reply' } },
      { type: 'turn.completed', usage: { output_tokens: 2 } },
    ] : [
      { type: 'system', subtype: 'init', session_id: 'reply-auth-thread' },
      { type: 'result', subtype: 'success', result: 'isolated reply', is_error: false, usage: { input_tokens: 2, output_tokens: 2 } },
    ]).map(frame => JSON.stringify(frame)).join('\n') + '\n')
  })
  const pathCache = new CliPathCache(() => config, spawn.spawnFn)
  vi.spyOn(pathCache, 'pathOf').mockResolvedValue(process.execPath)
  const deps: RouteDeps = {
    readConfig: () => config, registry, pathCache, spawnFn: spawn.spawnFn,
    controllers: new Map(), limiter: new Limiter(() => 1),
    resolveDshModel: resolveTestDshModel,
    preflightDshModel: async () => ({ status: 'ok', detail: 'controlled preflight' }),
  }
  const root = registry.create({ id: 'reply-auth-root', cli, title: 'root', cwd: process.cwd(), model: 'm', sessionId: 'parent-a' })
  root.stats = { sessionRef: 'reply-auth-thread' }
  registry.setPhase(root, 'done')
  return { deps, registry, root, launches: spawn.launches }
}
function detail(deps: RouteDeps, id: string, principal: string, scope?: string) {
  return handleTaskDetail(deps, new URLSearchParams({ id, ...(scope === undefined ? {} : { sessions: scope }) }), { sessionId: principal })
}
async function reply(deps: RouteDeps, id: string, principal: string) {
  const outcome = handleTaskReply(deps, { id, text: 'continue this isolated branch', sessions: [principal] }, { sessionId: principal })
  expect(outcome.status).toBe(200)
  const nextId = (outcome.body as { id: string }).id
  await vi.waitFor(() => expect(deps.registry.get(nextId)?.phase).toBe('done'), { timeout: 4000, interval: 25 })
  return nextId
}
function terminal(registry: TaskRegistry, id: string, replyTo?: string, owner = 'parent-a', cli: 'claude' | 'codex' = 'claude') {
  const task = registry.create({ id, cli, title: id, cwd: process.cwd(), model: 'm', sessionId: owner, ...(replyTo === undefined ? {} : { replyTo }) })
  task.stats = { sessionRef: 'reply-auth-thread' }
  registry.setPhase(task, 'done')
  return task
}

describe('child view continuation authorization', () => {
  it.each(['claude', 'codex'] as const)('%s child reads its finished reply without borrowing parent authority', async cli => {
    const { deps, root, launches } = fixture(cli)
    const child = `cli-${root.id}`
    const nextId = await reply(deps, root.id, child)
    expect(detail(deps, nextId, child).status).toBe(200)
    expect(detail(deps, nextId, child, child).status).toBe(200)
    expect(detail(deps, nextId, 'parent-a').status).toBe(200)
    expect(detail(deps, nextId, 'parent-b').status).toBe(404)
    expect(detail(deps, nextId, child, 'parent-b').status).toBe(404)
    const tasks = handleTasks(deps, new URLSearchParams({ sessions: child }), { sessionId: child }).body as { tasks: { id: string }[] }
    expect(tasks.tasks.map(task => task.id)).toContain(nextId)
    expect(deps.registry.get(nextId)?.sessionId).toBe('parent-a')
    expect(deps.registry.get(nextId)?.replySessionIds).toEqual([child])
    expect(launches.length).toBe(1)
  })
  it('original and intermediate child views can continue the same branch repeatedly', async () => {
    const { deps, root } = fixture()
    const original = `cli-${root.id}`
    const second = await reply(deps, root.id, original)
    const third = await reply(deps, second, `cli-${second}`)
    expect(detail(deps, third, original, original).status).toBe(200)
    expect(detail(deps, third, `cli-${second}`).status).toBe(200)
    expect(deps.registry.get(third)?.replySessionIds).toEqual([original, `cli-${second}`])
  })
  it('rejects sibling roots and sibling reply branches despite a shared owner and thread', () => {
    const { deps, registry, root } = fixture()
    const sibling = terminal(registry, 'sibling-root')
    const left = terminal(registry, 'left', root.id)
    const right = terminal(registry, 'right', root.id)
    const later = terminal(registry, 'left-next', left.id)
    expect(detail(deps, later.id, `cli-${sibling.id}`).status).toBe(404)
    expect(detail(deps, later.id, `cli-${right.id}`).status).toBe(404)
    expect(detail(deps, right.id, `cli-${left.id}`).status).toBe(404)
    expect(detail(deps, later.id, `cli-${root.id}`).status).toBe(200)
  })
  it('admits cancellation only for an authorized continuation view', () => {
    const { deps, registry, root } = fixture()
    const next = terminal(registry, 'cancel-reply', root.id)
    registry.setPhase(next, 'running')
    const controller = new AbortController()
    deps.controllers.set(next.id, controller)
    expect(handleTaskCancel(deps, { id: next.id, sessions: [`cli-${root.id}`] }, { sessionId: `cli-${root.id}` }).status).toBe(200)
    expect(controller.signal.aborted).toBe(true)
    expect(handleTaskCancel(deps, { id: next.id }, { sessionId: 'parent-b' }).status).toBe(404)
  })
  it('retains original view access when task creation immediately prunes its root', () => {
    const { deps, registry, root } = fixture()
    root.endedAt = 0
    for (let index = 0; index < 59; index++) terminal(registry, `unrelated-${index}`)
    const next = terminal(registry, 'pruning-reply', root.id)
    expect(registry.get(root.id)).toBeUndefined()
    expect(detail(deps, next.id, `cli-${root.id}`, `cli-${root.id}`).status).toBe(200)
    expect(detail(deps, next.id, 'cli-unrelated-58').status).toBe(404)
  })
  it('bounds ancestor views while preserving the original and recent child', () => {
    const { deps, registry, root } = fixture()
    let previous = root
    for (let index = 0; index < 85; index++) previous = terminal(registry, `bounded-${index}`, previous.id)
    expect(previous.replySessionIds).toHaveLength(60)
    expect(previous.replySessionIds?.[0]).toBe(`cli-${root.id}`)
    expect(previous.replySessionIds?.at(-1)).toBe('cli-bounded-83')
    expect(Object.isFrozen(previous.replySessionIds)).toBe(true)
    expect(detail(deps, previous.id, `cli-${root.id}`).status).toBe(200)
  })
  it('does not accept forged ancestor fields from ordinary task creation', () => {
    const { deps, registry } = fixture()
    const forged = registry.create({ id: 'forged', cli: 'claude', title: 'x', cwd: process.cwd(), model: 'm', sessionId: 'parent-a', replyTo: 'missing', replySessionIds: ['cli-victim'] })
    expect(forged.replySessionIds).toBeUndefined()
    expect(detail(deps, forged.id, 'cli-victim').status).toBe(404)
  })
  it.each(['owner', 'cli', 'npm', 'cycle', 'sibling'] as const)('rejects invalid restored ancestry: %s', kind => {
    const { deps, registry, root } = fixture()
    const sibling = terminal(registry, 'stored-sibling')
    const badOwner = terminal(registry, 'foreign-parent', undefined, 'parent-b')
    const badCli = terminal(registry, 'other-cli', undefined, 'parent-a', 'codex')
    const npm = registry.create({ id: 'npm-parent', kind: 'npm', cli: 'claude', title: 'npm', cwd: process.cwd(), model: 'm', sessionId: 'parent-a' })
    registry.setPhase(npm, 'done')
    const parent = kind === 'owner' ? badOwner.id : kind === 'cli' ? badCli.id : kind === 'npm' ? npm.id : kind === 'cycle' ? 'bad-restored' : root.id
    const restored = registry.restore({ id: 'bad-restored', cli: 'claude', title: 'bad', cwd: process.cwd(), model: 'm', sessionId: 'parent-a', phase: 'done', startedAt: 1, replyTo: parent, replySessionIds: [`cli-${root.id}`, ...(kind === 'sibling' ? [`cli-${sibling.id}`] : [])] })
    expect(detail(deps, restored.id, `cli-${root.id}`).status).toBe(404)
    expect(detail(deps, restored.id, 'parent-a').status).toBe(200)
  })
  it('supports verified legacy chains without guessing absent legacy ancestors', () => {
    const { deps, registry, root } = fixture()
    const legacy = registry.restore({ id: 'legacy', cli: 'claude', title: 'old', cwd: process.cwd(), model: 'm', sessionId: 'parent-a', phase: 'done', startedAt: 1, replyTo: root.id })
    expect(detail(deps, legacy.id, `cli-${root.id}`).status).toBe(200)
    const missing = registry.restore({ id: 'legacy-missing', cli: 'claude', title: 'old', cwd: process.cwd(), model: 'm', sessionId: 'parent-a', phase: 'done', startedAt: 1, replyTo: 'missing-original' })
    expect(detail(deps, missing.id, 'cli-missing-original').status).toBe(404)
  })
  it('persists scoped ancestor views without persisting runtime capability tokens', async () => {
    const { registry, root } = fixture()
    const next = terminal(registry, 'task-persist-reply', root.id)
    const home = await mkdtemp(join(tmpdir(), 'maestro-reply-auth-'))
    dirs.push(home)
    await persistTask(home, next)
    const records = await loadPersistedTasks(home)
    expect(records).toHaveLength(1)
    const cold = new TaskRegistry()
    const restored = cold.restore(records[0]!)
    expect(cold.accessSessionIdsOf(restored).has(`cli-${root.id}`)).toBe(true)
    const text = await readFile(join(home, 'maestro', 'tasks', `${next.id}.json`), 'utf8')
    expect(text).toContain('replySessionIds')
    expect(text).not.toContain('token')
  })
  it('preserves server launch ancestry when an existing legacy anchor has lost its parent', () => {
    const registry = new TaskRegistry()
    registry.restore({ id: 'legacy-B', cli: 'claude', title: 'B', cwd: process.cwd(), model: 'm', sessionId: 'parent-a', phase: 'done', startedAt: 1, replyTo: 'pruned-A' })
    const row: EffectRow = { kind: 'launch', key: 'cold-C', value: { taskId: 'cold-C', cli: 'claude', taskName: 'C', cwd: process.cwd(), model: 'm', sessionId: 'parent-a', replyTo: 'legacy-B', replySessionIds: ['cli-pruned-A', 'cli-legacy-B'] }, seq: 1, generation: 1, attempts: 0, due: 0, since: 1 }
    expect(restoreInterrupted(registry, [row])).toEqual(['cold-C'])
    const task = registry.get('cold-C')!
    expect(task.phase).toBe('interrupted')
    expect(task.replySessionIds).toEqual(['cli-pruned-A', 'cli-legacy-B'])
    expect(registry.accessSessionIdsOf(task)).toEqual(new Set(['parent-a', 'cli-pruned-A', 'cli-legacy-B', 'cli-cold-C']))
    const ordinary = registry.create({ id: 'ordinary-C', cli: 'claude', title: 'C', cwd: process.cwd(), model: 'm', sessionId: 'parent-a', replyTo: 'legacy-B', replySessionIds: ['cli-pruned-A'] })
    expect(registry.accessSessionIdsOf(ordinary).has('cli-pruned-A')).toBe(false)
  })
  it('never admits known foreign owners from an interrupted server snapshot', () => {
    const registry = new TaskRegistry()
    registry.restore({ id: 'legacy-B', cli: 'claude', title: 'B', cwd: process.cwd(), model: 'm', sessionId: 'parent-a', phase: 'done', startedAt: 1, replyTo: 'pruned-A' })
    registry.create({ id: 'foreign', cli: 'claude', title: 'F', cwd: process.cwd(), model: 'm', sessionId: 'parent-b' })
    const row: EffectRow = { kind: 'launch', key: 'cold-bad', value: { taskId: 'cold-bad', cli: 'claude', taskName: 'C', cwd: process.cwd(), model: 'm', sessionId: 'parent-a', replyTo: 'legacy-B', replySessionIds: ['cli-foreign', 'cli-legacy-B'] }, seq: 1, generation: 1, attempts: 0, due: 0, since: 1 }
    restoreInterrupted(registry, [row])
    expect(registry.accessSessionIdsOf(registry.get('cold-bad')!)).toEqual(new Set(['parent-a', 'cli-cold-bad']))
  })
  it('restores interrupted launch aliases after old ancestors were pruned without restarting CLI', () => {
    const registry = new TaskRegistry()
    const row: EffectRow = { kind: 'launch', key: 'interrupted-reply', value: { taskId: 'interrupted-reply', cli: 'claude', taskName: 'pending', cwd: process.cwd(), model: 'm', sessionId: 'parent-a', replyTo: 'pruned-turn', replySessionIds: ['cli-original'] }, seq: 1, generation: 1, attempts: 0, due: 0, since: 1 }
    expect(restoreInterrupted(registry, [row])).toEqual(['interrupted-reply'])
    const task = registry.get('interrupted-reply')!
    expect(task.phase).toBe('interrupted')
    expect(registry.accessSessionIdsOf(task).has('cli-original')).toBe(true)
  })
})
