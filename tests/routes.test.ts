import { describe, expect, it } from 'vitest'
import { effectiveOf, type EffectiveConfig } from '../src/config.js'
import { CliPathCache } from '../src/dispatch.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { StatusStore, handleOverview, handleTaskCancel, handleTaskDetail, handleTasks, handleDispatch, handleHint } from '../src/routes.js'
import { scriptedSpawn } from './fake-child.js'

function makeDeps(config: EffectiveConfig = effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath })) {
  const registry = new TaskRegistry()
  const controllers = new Map<string, AbortController>()
  const spawn = scriptedSpawn(child => {
    if (child.spawnArgs[0] === '--version') child.finish('claude version 1.0')
    else child.finish(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', is_error: false }), 0)
  })
  const store = new StatusStore(() => config)
  return {
    deps: {
      readConfig: () => config,
      registry,
      limiter: new Limiter(() => config.maxConcurrentTasks),
      controllers,
      pathCache: new CliPathCache(() => config, spawn.spawnFn),
      statusStore: store,
      spawnFn: spawn.spawnFn,
      toolName: () => 'dispatch_cli_task',
    },
    registry,
    controllers,
  }
}

describe('handleOverview / handleTasks', () => {
  it('answers with statuses, config view and tasks', () => {
    const { deps } = makeDeps()
    const outcome = handleOverview(deps)
    expect(outcome.status).toBe(200)
    const body = outcome.body as { enabled: boolean; clis: Record<string, unknown>; tasks: unknown[] }
    expect(body.enabled).toBe(true)
    expect(Object.keys(body.clis)).toEqual(['claude', 'codex'])
    expect(handleTasks(deps).status).toBe(200)
  })
})

describe('handleTaskDetail', () => {
  it('requires an id and 404s unknown tasks', () => {
    const { deps } = makeDeps()
    expect(handleTaskDetail(deps, new URLSearchParams()).status).toBe(400)
    expect(handleTaskDetail(deps, new URLSearchParams('id=nope')).status).toBe(404)
  })

  it('returns events after the cursor', () => {
    const { deps, registry } = makeDeps()
    const task = registry.create({ id: 'task-1', cli: 'claude', title: 't', model: '' })
    registry.push(task, 'text', 'hello')
    const outcome = handleTaskDetail(deps, new URLSearchParams('id=task-1&cursor=0'))
    expect(outcome.status).toBe(200)
    const body = outcome.body as { events: Array<{ text: string }>; nextCursor: number }
    expect(body.events.length).toBe(2)
    expect(body.nextCursor).toBe(2)
  })
})

describe('handleTaskCancel', () => {
  it('aborts the task through the controllers map', async () => {
    const { deps, registry, controllers } = makeDeps()
    const task = registry.create({ id: 'task-1', cli: 'claude', title: 't', model: '' })
    registry.setPhase(task, 'running', '开始')
    const controller = new AbortController()
    controllers.set('task-1', controller)
    const outcome = handleTaskCancel(deps, { id: 'task-1' })
    expect(outcome.status).toBe(200)
    expect(controller.signal.aborted).toBe(true)
    expect(handleTaskCancel(deps, { id: 'missing' }).status).toBe(404)
    registry.setPhase(task, 'done', 'ok')
    expect(handleTaskCancel(deps, { id: 'task-1' }).status).toBe(409)
  })
})

describe('handleDispatch', () => {
  it('creates a background task and answers the ref', async () => {
    const { deps, registry } = makeDeps()
    const outcome = await handleDispatch(deps, { cli: 'claude', task: '冒烟任务' })
    expect(outcome.status).toBe(200)
    const ref = outcome.body as { id: string }
    expect(ref.id).toMatch(/^task-/)
    // The background run settles on its own.
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    expect(registry.get(ref.id)?.phase).toBe('done')
  })

  it('answers 400 for a bad body', async () => {
    const { deps } = makeDeps()
    expect((await handleDispatch(deps, {})).status).toBe(400)
  })
})

describe('handleHint', () => {
  it('returns the routing hint and a redacted config', () => {
    const config = effectiveOf({ claudeAuthToken: 'sk-secret', claudeCliPath: process.execPath })
    const { deps } = makeDeps(config)
    const outcome = handleHint(deps)
    const body = outcome.body as { hint: string; redacted: EffectiveConfig }
    expect(body.hint).toContain('dispatch_cli_task')
    expect(body.redacted.claude.authToken).toBe('••••')
  })
})
