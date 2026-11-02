import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectiveOf } from '../src/config.js'
import { BridgeState, createBridgeHandle } from '../src/bridge.js'
import { CliPathCache, DispatchError, runDispatch, type DispatchDeps } from '../src/dispatch.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { scriptedSpawn } from './fake-child.js'
import { resolveTestDshModel, withTestDshRoutes } from './dsh-route-fixture.js'

const cleanup = vi.hoisted(() => ({ entered: false, release: undefined as (() => void) | undefined, configError: undefined as Error | undefined }))
vi.mock('../src/mcp.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/mcp.js')>(),
  writeClaudeMcpConfig: vi.fn(async () => { if (cleanup.configError !== undefined) throw cleanup.configError; return 'synthetic-lifecycle-mcp-config.json' }),
  unlinkQuiet: vi.fn(async () => {
    cleanup.entered = true
    await new Promise<void>(resolve => { cleanup.release = resolve })
  }),
}))
afterEach(() => { cleanup.release?.(); cleanup.configError = undefined; vi.restoreAllMocks() })

describe('bridge authority ends before terminal publication', () => {
  it.each(['done', 'failed', 'timeout', 'cancelled'] as const)('retires the token before observable %s even with delayed file cleanup', async ending => {
    cleanup.entered = false
    cleanup.release = undefined
    const config = withTestDshRoutes(effectiveOf({ claudeCliPath: process.execPath, injectGitContext: false, bridgeSkills: false, bridgeTools: 'custom', bridgeToolAllowlist: ['read'], failureRetries: 0 }))
    config.claude.timeoutMinutes = 0.001
    const controller = new AbortController()
    const state = new BridgeState()
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'synthetic tool result' }] }))
    const bridge = createBridgeHandle({
      state, readConfig: () => config, skills: () => undefined,
      tools: () => ({ schemas: () => [{ name: 'read' }], execute }),
      portOf: () => 12345, shimPath: () => 'synthetic-shim.js',
    })
    let token = ''
    const issue = bridge.runServerEntry.bind(bridge)
    bridge.runServerEntry = (overrides, context) => {
      const run = issue(overrides, context)
      token = run?.token ?? ''
      return run
    }
    const spawn = scriptedSpawn(child => {
      expect(child.pid).toBeUndefined()
      child.onStdin = () => {
        if (ending === 'done' || ending === 'failed') {
          child.finish([
            JSON.stringify({ type: 'system', subtype: 'init', session_id: 'synthetic-lifecycle-session' }),
            JSON.stringify({ type: 'result', subtype: ending === 'done' ? 'success' : 'error', result: 'synthetic completion', is_error: ending !== 'done' }),
          ].join('\n'), ending === 'done' ? 0 : 1)
        } else if (ending === 'cancelled') queueMicrotask(() => controller.abort(new Error('synthetic cancellation')))
        // timeout deliberately emits nothing; the in-memory child has no real PID.
      }
    })
    const registry = new TaskRegistry()
    const pathCache = new CliPathCache(() => config, spawn.spawnFn)
    vi.spyOn(pathCache, 'pathOf').mockResolvedValue(process.execPath)
    const deps: DispatchDeps = {
      readConfig: () => config, registry, pathCache, bridge, spawnFn: spawn.spawnFn,
      controllers: new Map(), limiter: new Limiter(() => 1), resolveDshModel: resolveTestDshModel,
    }
    let terminal!: () => void
    const reachedTerminal = new Promise<void>(resolve => { terminal = resolve })
    let settled = false
    const running = runDispatch(deps, {
      cli: 'claude', task: 'Run a synthetic multi-step lifecycle verification.',
      taskDifficulty: 'medium', difficultyReason: 'In-memory dispatch, terminal publication and delayed cleanup regression',
      executionAgent: { id: 'synthetic-agent' } as never,
    }, controller.signal, { onPhase: phase => { if (phase === ending) terminal() } })
    const observed = running.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error })).finally(() => { settled = true })
    try {
      await Promise.race([reachedTerminal, observed.then(() => { throw new Error('Dispatch settled without the expected terminal hook') })])
      await Promise.resolve()
      expect(token).not.toBe('')
      expect(registry.list()[0]?.phase).toBe(ending)
      expect(cleanup.entered).toBe(true)
      expect(cleanup.release).toBeTypeOf('function')
      expect(settled).toBe(false)
      expect(state.resolve(token)).toBeUndefined()
      expect(await bridge.callTool(token, 'read', {})).toMatchObject({ ok: false, status: 401 })
      expect(execute).not.toHaveBeenCalled()
    } finally { cleanup.release?.(); await observed }
    const result = await observed
    if (ending === 'done') expect(result.value).toMatchObject({ ok: true, phase: 'done' })
    else {
      expect(result.error).toBeInstanceOf(DispatchError)
      if (result.error instanceof DispatchError) expect(result.error.value?.phase).toBe(ending)
    }
    expect(await bridge.callTool(token, 'read', {})).toMatchObject({ ok: false, status: 401 })
    expect(deps.controllers.size).toBe(0)
  })

  it('revokes an issued token before publishing a configuration-write exception', async () => {
    cleanup.entered = false
    cleanup.release = undefined
    cleanup.configError = new Error('synthetic MCP configuration creation failed')
    const config = withTestDshRoutes(effectiveOf({ claudeCliPath: process.execPath, injectGitContext: false, bridgeSkills: false, bridgeTools: 'custom', bridgeToolAllowlist: ['read'], failureRetries: 0 }))
    const state = new BridgeState()
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'synthetic result' }] }))
    const bridge = createBridgeHandle({ state, readConfig: () => config, skills: () => undefined, tools: () => ({ schemas: () => [{ name: 'read' }], execute }), portOf: () => 12345, shimPath: () => 'synthetic-shim.js' })
    let token = ''
    const issue = bridge.runServerEntry.bind(bridge)
    bridge.runServerEntry = (overrides, context) => { const run = issue(overrides, context); token = run?.token ?? ''; return run }
    const registry = new TaskRegistry()
    const publish = registry.setPhase.bind(registry)
    let failedPublicationSeen = false
    vi.spyOn(registry, 'setPhase').mockImplementation((...args) => {
      if (args[1] === 'failed') {
        failedPublicationSeen = true
        expect(token).not.toBe('')
        expect(state.resolve(token)).toBeUndefined()
      }
      return publish(...args)
    })
    const spawn = scriptedSpawn(() => { throw new Error('No child should be launched') })
    const pathCache = new CliPathCache(() => config, spawn.spawnFn)
    vi.spyOn(pathCache, 'pathOf').mockResolvedValue(process.execPath)
    const deps: DispatchDeps = { readConfig: () => config, registry, pathCache, bridge, spawnFn: spawn.spawnFn, controllers: new Map(), limiter: new Limiter(() => 1), resolveDshModel: resolveTestDshModel }
    await expect(runDispatch(deps, { cli: 'claude', task: 'Synthetic configuration exception lifecycle regression.', taskDifficulty: 'medium', difficultyReason: 'Token issue, controlled configuration rejection and terminal publication.', executionAgent: { id: 'synthetic-agent' } as never }, new AbortController().signal)).rejects.toBeInstanceOf(DispatchError)
    expect(failedPublicationSeen).toBe(true)
    expect(cleanup.entered).toBe(false)
    expect(spawn.launches).toHaveLength(0)
    expect(await bridge.callTool(token, 'read', {})).toMatchObject({ ok: false, status: 401 })
    expect(execute).not.toHaveBeenCalled()
    expect(deps.controllers.size).toBe(0)
  })
})
