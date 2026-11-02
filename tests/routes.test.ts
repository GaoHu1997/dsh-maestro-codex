import { describe, expect, it } from 'vitest'
import { effectiveOf, type EffectiveConfig } from '../src/config.js'
import { CliPathCache } from '../src/dispatch.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { StatusStore, crossSitePost, handleBridgeCall, handleBridgeCatalog, handleCliNpmJob, handleCliVersions, handleHint, handleModels, handleOverview, handleTaskCancel, handleTaskDetail, handleTasks } from '../src/routes.js'
import { createBridgeHandle } from '../src/bridge.js'
import { detectCli } from '../src/cli-manager.js'
import { scriptedSpawn } from './fake-child.js'

/** npm.cmd keeps its verb in a cmd.exe command line, not a standalone argv item. */
function npmOperationOf(args: readonly string[]): string | undefined {
  if (args[2]?.toLowerCase() === '/c') {
    return args[3]?.match(/^""[^"]+"\s+"?(view|install|uninstall)"?(?=\s|"$)/)?.[1]
  }
  return args.find(arg => ['view', 'install', 'uninstall'].includes(arg))
}

function makeDeps(
  config: EffectiveConfig = effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath }),
  options: { viewFails?: boolean; viewJson?: string } = {},
) {
  const registry = new TaskRegistry()
  const controllers = new Map<string, AbortController>()
  const spawn = scriptedSpawn(child => {
    if (npmOperationOf(child.spawnArgs) === 'view') {
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
  const store = new StatusStore(() => config, options => detectCli({ ...options, spawnFn: spawn.spawnFn }))
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

describe('npm fixture command recognition', () => {
  it.each(['view', 'install', 'uninstall'])('recognizes direct and Windows-wrapped %s operations', operation => {
    expect(npmOperationOf(['npm-cli.js', operation, '@example/package'])).toBe(operation)
    const line = `""C:/Program Files/install tools/npm.CMD" ${operation} "@example/package""`
    expect(npmOperationOf(['/d', '/s', '/c', line])).toBe(operation)
  })

  it('does not confuse uninstall with install or a verb in the executable path', () => {
    expect(npmOperationOf(['/d', '/s', '/c', '""C:/install tools/npm.CMD" uninstall "@example/package""'])).toBe('uninstall')
    expect(npmOperationOf(['/d', '/s', '/c', '""C:/install tools/npm.CMD" --version"'])).toBeUndefined()
  })

  it('does not treat command words inside a package name as npm operations', () => {
    expect(npmOperationOf(['--version', '@example/install'])).toBeUndefined()
  })
})

describe('handleOverview / handleTasks', () => {
  it('answers with statuses, config view and tasks', () => {
    const { deps } = makeDeps()
    const outcome = handleOverview(deps)
    expect(outcome.status).toBe(200)
    const body = outcome.body as { enabled: boolean; clis: Record<string, unknown>; tasks: unknown[] }
    expect(body.enabled).toBe(true)
    expect(outcome.body).toMatchObject({ minTaskDifficulties: { claude: 'medium', codex: 'medium' } })
    expect(outcome.body).toMatchObject({
      dsh: { minTaskDifficulty: 'low', taskTypes: ['代码定位', '资料检索', '方案核验'] },
    })
    const dshVersion = (outcome.body as { dsh: { version: string | null } }).dsh.version
    expect(dshVersion === null || typeof dshVersion === 'string').toBe(true)
    expect(handleOverview(makeDeps(effectiveOf({ dshMinTaskDifficulty: 'high' })).deps).body)
      .toMatchObject({ dsh: { minTaskDifficulty: 'high' } })
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
    registry.create({ id: 'npm-1', kind: 'npm', cli: 'claude', title: 'npm', model: '' })
    const ids = (query?: string, sessionId?: string): string[] => {
      const outcome = handleTasks(deps, query === undefined ? undefined : new URLSearchParams(query), sessionId === undefined ? undefined : { sessionId })
      return (outcome.body as { tasks: Array<{ id: string }> }).tasks.map(task => task.id).sort()
    }
    expect(ids()).toEqual(['npm-1'])
    expect(ids('sessions=s1,s2')).toEqual(['npm-1'])
    expect(ids(undefined, 's1')).toEqual(['npm-1', 'own'])
    expect(ids('sessions=s1,s2', 's1')).toEqual(['npm-1', 'own'])
    expect(ids('sessions=s3', 's1')).toEqual(['npm-1'])
    expect(ids('sessions=', 's1')).toEqual(['npm-1', 'own'])
    expect(ids('sessions=s3', 's3')).toEqual(['npm-1', 'other'])
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
    const task = registry.create({ id: 'task-1', cli: 'claude', title: 't', model: '', sessionId: 's1' })
    registry.push(task, 'text', 'hello')
    const outcome = handleTaskDetail(deps, new URLSearchParams('id=task-1&cursor=0'), { sessionId: 's1' })
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
    expect(handleTaskDetail(deps, new URLSearchParams('id=task-2&sessions=s2'), { sessionId: 's2' }).status).toBe(200)
    expect(handleTaskDetail(deps, new URLSearchParams('id=task-2&sessions=s1,s2'), { sessionId: 's1' }).status).toBe(404)
    expect(handleTaskDetail(deps, new URLSearchParams('id=task-2'), { sessionId: 's2' }).status).toBe(200)
  })
})

describe('handleTaskCancel', () => {
  it('aborts the task through the controllers map', async () => {
    const { deps, registry, controllers } = makeDeps()
    const task = registry.create({ id: 'task-1', cli: 'claude', title: 't', model: '', sessionId: 's1' })
    registry.setPhase(task, 'running', '开始')
    const controller = new AbortController()
    controllers.set('task-1', controller)
    const outcome = handleTaskCancel(deps, { id: 'task-1' }, { sessionId: 's1' })
    expect(outcome.status).toBe(200)
    expect(controller.signal.aborted).toBe(true)
    expect(handleTaskCancel(deps, { id: 'missing' }).status).toBe(404)
    registry.setPhase(task, 'done', 'ok')
    expect(handleTaskCancel(deps, { id: 'task-1' }, { sessionId: 's1' }).status).toBe(409)
  })

  it('refuses to cancel a task from another session', () => {
    const { deps, registry, controllers } = makeDeps()
    const task = registry.create({ id: 'task-2', cli: 'claude', title: 't', model: '', sessionId: 's2' })
    registry.setPhase(task, 'running', '开始')
    const controller = new AbortController()
    controllers.set('task-2', controller)
    expect(handleTaskCancel(deps, { id: 'task-2', sessions: ['s1'] }).status).toBe(404)
    expect(controller.signal.aborted).toBe(false)
    expect(handleTaskCancel(deps, { id: 'task-2', sessions: ['s2'] }, { sessionId: 's2' }).status).toBe(200)
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
    const install = launches.find(child => npmOperationOf(child.spawnArgs) === 'install')
    expect(install?.spawnArgs.join(' ')).toContain('@openai/codex@0.152.1')
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
    const uninstall = launches.find(child => npmOperationOf(child.spawnArgs) === 'uninstall')
    expect(uninstall?.spawnArgs.join(' ')).toContain('@anthropic-ai/claude-code')
    expect(uninstall?.spawnArgs.join(' ')).not.toContain('@anthropic-ai/claude-code@0.3.312')
  })

  it('refuses a second npm job for the same CLI while one is in flight', async () => {
    const { deps, registry } = makeDeps()
    const first = handleCliNpmJob(deps, 'install', { cli: 'claude' })
    expect(first.status).toBe(200)
    const duplicate = handleCliNpmJob(deps, 'install', { cli: 'claude', version: '9.9.9' })
    expect(duplicate.status).toBe(409)
    expect((duplicate.body as { error: string }).error).toContain('已有 npm 任务进行中')
    // 卸载与安装共用同一把「每 CLI 一把」的锁。
    expect(handleCliNpmJob(deps, 'uninstall', { cli: 'claude' }).status).toBe(409)
    // 另一个 CLI 不受影响。
    expect(handleCliNpmJob(deps, 'install', { cli: 'codex' }).status).toBe(200)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    // 结束后放行（再等它跑完）。
    expect(handleCliNpmJob(deps, 'install', { cli: 'claude', version: '9.9.9' }).status).toBe(200)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    expect(registry.list().filter(task => task.id.startsWith('npm-') && task.phase !== 'done')).toHaveLength(0)
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

describe('crossSitePost', () => {
  it('allows same-origin, origin-less and host-less requests', () => {
    expect(crossSitePost({ origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' })).toBe(false)
    expect(crossSitePost({ origin: 'http://localhost:3000', host: 'localhost:3000' })).toBe(false)
    expect(crossSitePost({ host: '127.0.0.1:3000' })).toBe(false)
    expect(crossSitePost({ origin: 'https://evil.example' })).toBe(false)
    expect(crossSitePost({})).toBe(false)
  })

  it('rejects a cross-site origin (CSRF against the unauthenticated routes)', () => {
    expect(crossSitePost({ origin: 'https://evil.example', host: '127.0.0.1:3000' })).toBe(true)
    expect(crossSitePost({ origin: 'http://127.0.0.1:9999', host: '127.0.0.1:3000' })).toBe(true)
    // Sandboxed iframes send the literal string "null" — not a URL, reject.
    expect(crossSitePost({ origin: 'null', host: '127.0.0.1:3000' })).toBe(true)
  })
})

describe('handleBridgeCatalog / handleBridgeCall', () => {
  it('answers 404 when the bridge handle is absent and 401 for unknown tokens', async () => {
    const { deps } = makeDeps()
    const missing = await handleBridgeCatalog(deps, new URLSearchParams('token=x'))
    expect(missing.status).toBe(404)
    const missingCall = await handleBridgeCall(deps, { token: 'x', kind: 'skill', name: 'a' })
    expect(missingCall.status).toBe(404)

    const bridge = createBridgeHandle({
      skills: () => ({ list: async () => [], get: async () => undefined }),
      tools: () => undefined,
      portOf: () => 8765,
      readConfig: () => effectiveOf({}),
    })
    const bad = await handleBridgeCatalog({ ...deps, bridge }, new URLSearchParams('token=nope'))
    expect(bad.status).toBe(401)
    const badCall = await handleBridgeCall({ ...deps, bridge }, { token: 'nope', kind: 'skill', name: 'a' })
    expect(badCall.status).toBe(401)
  })

  it('serves the catalog and skill bodies through a real token', async () => {
    const bridge = createBridgeHandle({
      skills: () => ({
        list: async () => [{ name: 'good-one', description: '可用技能', invocation: { modelInvocable: true, userInvocable: true }, source: 's', provider: 'p', rank: 1 }],
        get: async (name: string) => name === 'good-one' ? { name: 'good-one', description: '可用技能', content: '正文', invocation: { modelInvocable: true, userInvocable: true }, source: 's', provider: 'p' } : undefined,
      }),
      tools: () => undefined,
      portOf: () => 8765,
      readConfig: () => effectiveOf({}),
    })
    const run = bridge.runServerEntry()
    if (run === undefined) throw new Error('bridge should be active')
    const { deps } = makeDeps()
    const catalog = await handleBridgeCatalog({ ...deps, bridge }, new URLSearchParams(`token=${run.token}&cwd=/cwd`))
    expect(catalog.status).toBe(200)
    expect(catalog.body).toMatchObject({ serverName: 'dsh_bridge', skills: [{ name: 'good-one', tool: 'skill_good-one' }] })

    const loaded = await handleBridgeCall({ ...deps, bridge }, { token: run.token, kind: 'skill', name: 'good-one', cwd: '/cwd' })
    expect(loaded.status).toBe(200)
    expect((loaded.body as { text: string }).text).toContain('正文')

    const missing = await handleBridgeCall({ ...deps, bridge }, { token: run.token, kind: 'skill', name: 'gone' })
    expect(missing.status).toBe(404)
    const badKind = await handleBridgeCall({ ...deps, bridge }, { token: run.token, kind: 'wat', name: 'x' })
    expect(badKind.status).toBe(400)
    bridge.revoke(run.token)
  })

  it('reports bridge diagnostics through the models route', async () => {
    const bridge = createBridgeHandle({
      skills: () => ({ list: async () => [{ name: 'a', description: 'x', invocation: { modelInvocable: true, userInvocable: true }, source: 's', provider: 'p', rank: 1 }], get: async () => undefined }),
      tools: () => ({ schemas: () => [{ name: 'web_search', description: 'd', parameters: { type: 'object', properties: {} } }], execute: async () => ({ content: [], isError: false }) }),
      portOf: () => 8765,
      readConfig: () => effectiveOf({}),
    })
    const { deps } = makeDeps()
    deps.listDshModels = async () => ({ providers: [] })
    deps.listMcpServers = () => []
    const outcome = await handleModels({ ...deps, bridge })
    expect(outcome.status).toBe(200)
    expect((outcome.body as { bridge: object }).bridge).toMatchObject({ skillsEnabled: true, toolsMode: 'auto', skills: 1, tools: 0, httpReady: true })
  })
})
