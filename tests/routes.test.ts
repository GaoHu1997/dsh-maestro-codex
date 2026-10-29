import { describe, expect, it } from 'vitest'
import { effectiveOf, type EffectiveConfig } from '../src/config.js'
import { CliPathCache } from '../src/dispatch.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { StatusStore, handleCliNpmJob, handleCliVersions, handleHint, handleOverview, handleTaskCancel, handleTaskDetail, handleTasks } from '../src/routes.js'
import { scriptedSpawn } from './fake-child.js'

function makeDeps(
  config: EffectiveConfig = effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath }),
  options: { viewFails?: boolean; viewJson?: string } = {},
) {
  const registry = new TaskRegistry()
  const controllers = new Map<string, AbortController>()
  const spawn = scriptedSpawn(child => {
    if (child.spawnArgs.includes('view')) {
      if (options.viewFails === true) {
        child.finish('', 1, 'npm ERR! 404 Not Found')
        return
      }
      child.finish(options.viewJson ?? JSON.stringify({
        versions: ['0.150.0', '0.151.0-alpha.1', '0.152.1'],
        'dist-tags': { latest: '0.152.1' },
      }))
      return
    }
    if (child.spawnArgs[0] === '--version') child.finish('claude version 1.0')
    else child.finish('', 0)
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
    launches: spawn.launches,
  }
}

describe('handleOverview / handleTasks', () => {
  it('answers with statuses, config view and tasks', () => {
    const { deps } = makeDeps()
    const outcome = handleOverview(deps)
    expect(outcome.status).toBe(200)
    const body = outcome.body as { enabled: boolean; clis: Record<string, unknown>; tasks: unknown[] }
    expect(body.enabled).toBe(true)
    expect(outcome.body).toMatchObject({ minTaskDifficulties: { claude: 'medium', codex: 'medium' } })
    expect(handleOverview(makeDeps(effectiveOf({ minTaskDifficulty: 'extreme' })).deps).body)
      .toMatchObject({ minTaskDifficulties: { claude: 'extreme', codex: 'extreme' } })
    expect(handleOverview(makeDeps(effectiveOf({ claudeMinTaskDifficulty: 'low', codexMinTaskDifficulty: 'high' })).deps).body)
      .toMatchObject({ minTaskDifficulties: { claude: 'low', codex: 'high' } })
    expect(outcome.body).not.toHaveProperty('minTaskDifficulty')
    expect(Object.keys(body.clis)).toEqual(['claude', 'codex'])
    expect(handleTasks(deps).status).toBe(200)
  })

  it('scopes task summaries to the requested session tree', () => {
    const { deps, registry } = makeDeps()
    registry.create({ id: 'own', cli: 'claude', title: '本会话', model: '', sessionId: 's1' })
    registry.create({ id: 'sibling', cli: 'codex', title: '子会话', model: '', sessionId: 's2' })
    registry.create({ id: 'other', cli: 'codex', title: '别的会话', model: '', sessionId: 's3' })
    // owner-less（配置页安装的 npm 任务）不属于任何会话，任何视图都看得到。
    registry.create({ id: 'npm-1', cli: 'claude', title: 'npm', model: '' })
    const ids = (query?: string): string[] => {
      const outcome = handleTasks(deps, query === undefined ? undefined : new URLSearchParams(query))
      return (outcome.body as { tasks: Array<{ id: string }> }).tasks.map(task => task.id).sort()
    }
    expect(ids()).toEqual(['npm-1', 'other', 'own', 'sibling'])
    expect(ids('sessions=s1,s2')).toEqual(['npm-1', 'own', 'sibling'])
    expect(ids('sessions=s3')).toEqual(['npm-1', 'other'])
    // 空 sessions 参数 = 不过滤（运维视角）。
    expect(ids('sessions=')).toEqual(['npm-1', 'other', 'own', 'sibling'])
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

  it('hides a task owned by another session', () => {
    const { deps, registry } = makeDeps()
    const task = registry.create({ id: 'task-2', cli: 'claude', title: 't', model: '', sessionId: 's2' })
    registry.push(task, 'text', 'hello')
    expect(handleTaskDetail(deps, new URLSearchParams('id=task-2&sessions=s1')).status).toBe(404)
    expect(handleTaskDetail(deps, new URLSearchParams('id=task-2&sessions=s2')).status).toBe(200)
    expect(handleTaskDetail(deps, new URLSearchParams('id=task-2&sessions=s1,s2')).status).toBe(200)
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

  it('refuses to cancel a task from another session', () => {
    const { deps, registry, controllers } = makeDeps()
    const task = registry.create({ id: 'task-2', cli: 'claude', title: 't', model: '', sessionId: 's2' })
    registry.setPhase(task, 'running', '开始')
    const controller = new AbortController()
    controllers.set('task-2', controller)
    expect(handleTaskCancel(deps, { id: 'task-2', sessions: ['s1'] }).status).toBe(404)
    expect(controller.signal.aborted).toBe(false)
    expect(handleTaskCancel(deps, { id: 'task-2', sessions: ['s2'] }).status).toBe(200)
    expect(controller.signal.aborted).toBe(true)
  })
})

describe('handleCliVersions', () => {
  it('reads stable versions and the latest dist-tag from npm view', async () => {
    const { deps } = makeDeps()
    const outcome = await handleCliVersions(deps, new URLSearchParams('cli=codex'))
    expect(outcome.status).toBe(200)
    const body = outcome.body as { cli: string; latest: string; versions: string[]; platform: string }
    expect(body.cli).toBe('codex')
    expect(body.latest).toBe('0.152.1')
    // Prereleases are filtered out: only stable, installable versions ship.
    expect(body.versions).toEqual(['0.150.0', '0.152.1'])
    expect(body.platform).toBe(`${process.platform}-${process.arch}`)
  })

  it('falls back to the newest stable version when latest is a prerelease', async () => {
    const { deps } = makeDeps(undefined, {
      viewJson: JSON.stringify({ versions: ['0.1.0', '0.2.0'], 'dist-tags': { latest: '0.3.0-beta.1' } }),
    })
    const outcome = await handleCliVersions(deps, new URLSearchParams('cli=claude'))
    const body = outcome.body as { latest: string; versions: string[] }
    expect(body.latest).toBe('0.2.0')
    expect(body.versions).toEqual(['0.1.0', '0.2.0'])
  })

  it('rejects an unknown or missing cli', async () => {
    const { deps } = makeDeps()
    expect((await handleCliVersions(deps, new URLSearchParams())).status).toBe(400)
    expect((await handleCliVersions(deps, new URLSearchParams('cli=other'))).status).toBe(400)
  })

  it('answers 502 when the registry cannot be read', async () => {
    const { deps } = makeDeps(undefined, { viewFails: true })
    const outcome = await handleCliVersions(deps, new URLSearchParams('cli=claude'))
    expect(outcome.status).toBe(502)
  })
})

describe('handleCliNpmJob', () => {
  it('pins the requested version in the npm argv', async () => {
    const { deps, registry, launches } = makeDeps()
    const outcome = handleCliNpmJob(deps, 'install', { cli: 'codex', version: '0.152.1' })
    expect(outcome.status).toBe(200)
    const ref = outcome.body as { id: string }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    expect(registry.get(ref.id)?.phase).toBe('done')
    const install = launches.find(child => child.spawnArgs.includes('install'))
    expect(install?.spawnArgs).toContain('@openai/codex@0.152.1')
  })

  it('rejects a malformed version and an unknown cli', () => {
    const { deps } = makeDeps()
    expect(handleCliNpmJob(deps, 'install', { cli: 'codex', version: 'latest; rm -rf /' }).status).toBe(400)
    expect(handleCliNpmJob(deps, 'install', { cli: 'nope' }).status).toBe(400)
  })

  it('uninstall ignores a version and spells the bare package', async () => {
    const { deps, launches } = makeDeps()
    expect(handleCliNpmJob(deps, 'uninstall', { cli: 'claude', version: '0.3.312' }).status).toBe(200)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    const uninstall = launches.find(child => child.spawnArgs.includes('uninstall'))
    expect(uninstall?.spawnArgs).toContain('@anthropic-ai/claude-code')
    expect(uninstall?.spawnArgs).not.toContain('@anthropic-ai/claude-code@0.3.312')
  })
})

describe('handleHint', () => {
  it('returns the routing hint and a redacted config', () => {
    const config = effectiveOf({
      claudeAuthToken: 'sk-secret', codexApiKey: 'sk-codex-secret', claudeCliPath: process.execPath,
      minTaskDifficulty: 'extreme', claudeMinTaskDifficulty: 'low', codexMinTaskDifficulty: 'high',
    })
    const { deps } = makeDeps(config)
    const outcome = handleHint(deps)
    const body = outcome.body as { hint: string; redacted: EffectiveConfig }
    expect(body.hint).toContain('dispatch_cli_task')
    expect(body.redacted.claude.authToken).toBe('••••')
    expect(body.redacted.codex.apiKey).toBe('••••')
    expect(body.redacted.claude.minTaskDifficulty).toBe('low')
    expect(body.redacted.codex.minTaskDifficulty).toBe('high')
    expect(body.redacted).not.toHaveProperty('minTaskDifficulty')
    expect(JSON.stringify(body)).not.toContain('sk-secret')
    expect(JSON.stringify(body)).not.toContain('sk-codex-secret')
  })
})
