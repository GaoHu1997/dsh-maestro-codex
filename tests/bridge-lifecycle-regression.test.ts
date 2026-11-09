import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectiveOf } from '../src/config.js'
import { BridgeState, createBridgeHandle } from '../src/bridge.js'
import { CliPathCache, DispatchError, runDispatch, type DispatchDeps } from '../src/dispatch.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { scriptedSpawn } from './fake-child.js'
import { resolveTestDshModel, withTestDshRoutes } from './dsh-route-fixture.js'

interface LifecycleCleanup {
  path: string
  controller: AbortController
  pending: Set<Promise<unknown>>
  gate: Promise<void>
  release: () => void
  entered: boolean
  configError?: Error
}
const lifecycle = vi.hoisted(() => ({
  byEntry: new WeakMap<object, LifecycleCleanup>(),
  byPath: new Map<string, LifecycleCleanup>(),
  owners: new Set<LifecycleCleanup>(),
  sequence: 0,
}))

// The real Claude channel calls its own writeClaudeSettingsFile helper. Only
// that helper's per-run settings I/O is outside this authority lifecycle test.
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  const isSettings = (file: unknown): boolean => typeof file === 'string' && /(?:^|[\\/])dsh-maestro-claude-[a-f0-9]{8}\.json$/i.test(file)
  return {
    ...original,
    writeFile: vi.fn(async (...args: Parameters<typeof original.writeFile>) => {
      if (!isSettings(args[0])) await original.writeFile(...args)
    }),
    unlink: vi.fn(async (...args: Parameters<typeof original.unlink>) => {
      if (!isSettings(args[0])) await original.unlink(...args)
    }),
  }
})
vi.mock('../src/mcp.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/mcp.js')>()
  return {
    ...original,
    writeClaudeMcpConfig: vi.fn(async (servers: Parameters<typeof original.writeClaudeMcpConfig>[0]) => {
      const owner = servers.map(server => lifecycle.byEntry.get(server)).find(candidate => candidate !== undefined)
      if (owner === undefined) throw new Error('Lifecycle MCP configuration has no owning case')
      if (owner.configError !== undefined) throw owner.configError
      return owner.path
    }),
    unlinkQuiet: vi.fn(async (file: string) => {
      const owner = lifecycle.byPath.get(file)
      if (owner === undefined) throw new Error('Lifecycle MCP cleanup has no owning case')
      owner.entered = true
      await owner.gate
    }),
  }
})

function cleanupForCase(): LifecycleCleanup {
  let release!: () => void
  // Create the gate now: teardown can release it even before unlinkQuiet enters.
  const gate = new Promise<void>(resolve => { release = resolve })
  const owner: LifecycleCleanup = {
    path: `synthetic-lifecycle-mcp-config-${++lifecycle.sequence}.json`,
    controller: new AbortController(), pending: new Set(), gate, release, entered: false,
  }
  lifecycle.owners.add(owner)
  lifecycle.byPath.set(owner.path, owner)
  return owner
}
function track<T>(owner: LifecycleCleanup, pending: Promise<T>): Promise<T> {
  owner.pending.add(pending)
  void pending.then(() => owner.pending.delete(pending), () => owner.pending.delete(pending))
  return pending
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Lifecycle fixture forbids real network requests'))
})
afterEach(async () => {
  const owners = [...lifecycle.owners]
  try {
    // Cancel/release every owner before waiting, including runs with no child yet.
    // Keep path ownership until all runs settle so late cleanup cannot use a new case.
    for (const owner of owners) {
      owner.release()
      owner.controller.abort(new Error('Synthetic lifecycle teardown'))
    }
    await Promise.allSettled(owners.flatMap(owner => [...owner.pending]))
    for (const owner of owners) expect(owner.pending.size).toBe(0)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  } finally {
    lifecycle.byEntry = new WeakMap()
    lifecycle.byPath.clear()
    lifecycle.owners.clear()
    vi.restoreAllMocks()
  }
})

describe('bridge authority ends before terminal publication', () => {
  it.each(['done', 'failed', 'timeout', 'cancelled'] as const)('retires the token before observable %s even with delayed file cleanup', async ending => {
    const cleanup = cleanupForCase()
    const config = withTestDshRoutes(effectiveOf({ claudeCliPath: process.execPath, injectGitContext: false, bridgeSkills: false, bridgeTools: 'custom', bridgeToolAllowlist: ['read'], failureRetries: 0 }))
    config.timeoutMinutes = 0.001
    const controller = cleanup.controller
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
      if (run !== undefined) lifecycle.byEntry.set(run.entry, cleanup)
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
    const running = track(cleanup, runDispatch(deps, {
      cli: 'claude', task: 'Run a synthetic multi-step lifecycle verification.',
      taskDifficulty: 'medium', difficultyReason: 'In-memory dispatch, terminal publication and delayed cleanup regression',
      executionAgent: { id: 'synthetic-agent' } as never,
    }, controller.signal, { onPhase: phase => { if (phase === ending) terminal() } }))
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
    } finally { cleanup.release(); await observed }
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
    const cleanup = cleanupForCase()
    cleanup.configError = new Error('synthetic MCP configuration creation failed')
    const config = withTestDshRoutes(effectiveOf({ claudeCliPath: process.execPath, injectGitContext: false, bridgeSkills: false, bridgeTools: 'custom', bridgeToolAllowlist: ['read'], failureRetries: 0 }))
    const state = new BridgeState()
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'synthetic result' }] }))
    const bridge = createBridgeHandle({ state, readConfig: () => config, skills: () => undefined, tools: () => ({ schemas: () => [{ name: 'read' }], execute }), portOf: () => 12345, shimPath: () => 'synthetic-shim.js' })
    let token = ''
    const issue = bridge.runServerEntry.bind(bridge)
    bridge.runServerEntry = (overrides, context) => {
      const run = issue(overrides, context)
      token = run?.token ?? ''
      if (run !== undefined) lifecycle.byEntry.set(run.entry, cleanup)
      return run
    }
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
    await expect(track(cleanup, runDispatch(deps, { cli: 'claude', task: 'Synthetic configuration exception lifecycle regression.', taskDifficulty: 'medium', difficultyReason: 'Token issue, controlled configuration rejection and terminal publication.', executionAgent: { id: 'synthetic-agent' } as never }, cleanup.controller.signal))).rejects.toBeInstanceOf(DispatchError)
    expect(failedPublicationSeen).toBe(true)
    expect(cleanup.entered).toBe(false)
    expect(spawn.launches).toHaveLength(0)
    expect(await bridge.callTool(token, 'read', {})).toMatchObject({ ok: false, status: 401 })
    expect(execute).not.toHaveBeenCalled()
    expect(deps.controllers.size).toBe(0)
  })
})
