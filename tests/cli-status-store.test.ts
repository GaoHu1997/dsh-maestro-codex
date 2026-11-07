import { describe, expect, it, vi } from 'vitest'
import { type CliDetection, type detectCli } from '../src/cli-manager.js'
import { effectiveOf } from '../src/config.js'
import { handleCliNpmJob, handleCliRefresh, StatusStore, type RouteDeps } from '../src/routes.js'
import { TaskRegistry } from '../src/task-registry.js'
import { scriptedSpawn } from './fake-child.js'

type Probe = {
  options: Parameters<typeof detectCli>[0]
  resolve: (value: CliDetection) => void
  reject: (error: Error) => void
}

function harness() {
  const config = effectiveOf({ claudeCliPath: '/claude-v1', codexCliPath: '/codex-v1' })
  const probes: Probe[] = []
  let onProbe: (() => void) | undefined
  const detector = vi.fn<typeof detectCli>(options => new Promise((resolve, reject) => {
    probes.push({ options, resolve, reject })
    onProbe?.()
  }))
  const store = new StatusStore(() => config, detector)
  return { config, probes, detector, store, notify: (callback: () => void) => { onProbe = callback } }
}

const detected = (version: string, path = '/cli'): CliDetection => ({ installed: true, version, path, error: undefined })
const drain = async () => { for (let turn = 0; turn < 4; turn += 1) await Promise.resolve() }

describe('independent CLI status refresh', () => {
  it('marks the initial state as pending, not a completed missing detection', () => {
    const { store } = harness()
    expect(store.get().claude).toMatchObject({ installed: false, checking: true })
    expect(store.get().codex).toMatchObject({ installed: false, checking: true })
    expect(store.get().grok).toMatchObject({ installed: false, checking: true })
    expect(store.get().claude.error).toBeUndefined()
  })

  it('publishes a fast CLI before the other probe finishes', async () => {
    const { store, probes } = harness()
    const pass = store.refresh()
    expect(probes).toHaveLength(3)
    probes[0]!.resolve(detected('1.2.3', '/claude-v1'))
    await drain()
    expect(store.get().claude).toMatchObject({ installed: true, version: '1.2.3', checking: false })
    expect(store.get().codex.checking).toBe(true)
    probes[1]!.resolve(detected('4.5.6', '/codex-v1'))
    probes[2]!.resolve(detected('7.0.0', '/grok-v1'))
    await pass
    expect(store.get().codex).toMatchObject({ version: '4.5.6', checking: false })
    expect(store.get().grok).toMatchObject({ version: '7.0.0', checking: false })
  })

  it('coalesces full, periodic and single-CLI refresh requests', async () => {
    const { store, probes, detector } = harness()
    const first = store.refresh()
    const second = store.refresh()
    const route = handleCliRefresh({ statusStore: store, pathCache: { invalidate: vi.fn() } } as unknown as RouteDeps, { cli: 'claude' })
    expect(detector).toHaveBeenCalledTimes(3)
    probes[0]!.resolve(detected('1.0.0'))
    probes[1]!.resolve(detected('2.0.0'))
    probes[2]!.resolve(detected('3.0.0'))
    await Promise.all([first, second])
    expect((await route).status).toBe(200)
    expect(detector).toHaveBeenCalledTimes(3)
  })

  it('contains an unexpected detector rejection without losing the other CLI', async () => {
    const { store, probes } = harness()
    const pass = store.refresh()
    probes[0]!.reject(new Error('bad probe'))
    probes[1]!.resolve(detected('2.0.0'))
    probes[2]!.resolve(detected('3.0.0'))
    await expect(pass).resolves.toBeUndefined()
    expect(store.get().claude).toMatchObject({ checking: false, error: 'CLI 检测失败：bad probe' })
    expect(store.get().codex).toMatchObject({ installed: true, version: '2.0.0' })
    expect(store.get().grok).toMatchObject({ installed: true, version: '3.0.0' })
  })

  it('preserves the last successful installation on a transient probe exception', async () => {
    const { store, probes } = harness()
    store.set('claude', detected('1.0.0', '/claude-v1'))
    const pass = store.refresh('claude')
    expect(store.get().claude).toMatchObject({ installed: true, version: '1.0.0', checking: true })
    probes[0]!.reject(new Error('transient'))
    await pass
    expect(store.get().claude).toMatchObject({ installed: true, version: '1.0.0', checking: false, error: 'CLI 检测失败：transient' })
  })

  it('invalidates an install pre-change probe and ignores its late result', async () => {
    const { store, probes } = harness()
    const old = store.refresh('codex')
    store.invalidate('codex')
    const fresh = store.refresh('codex')
    expect(probes[0]!.options.signal?.aborted).toBe(true)
    probes[1]!.resolve(detected('2.0.0'))
    await fresh
    probes[0]!.resolve(detected('1.0.0'))
    await old
    expect(store.get().codex.version).toBe('2.0.0')
  })

  it('does not publish an old override after the user changes configuration', async () => {
    const { store, probes, config } = harness()
    const old = store.refresh('claude')
    config.claude.cliPath = '/claude-v2'
    const fresh = store.refresh('claude')
    expect(probes[1]!.options.override).toBe('/claude-v2')
    expect(probes[0]!.options.signal?.aborted).toBe(true)
    expect(store.get().claude).toMatchObject({ path: '', version: '', checking: true })
    probes[1]!.resolve(detected('2.0.0', '/claude-v2'))
    await fresh
    probes[0]!.resolve(detected('1.0.0', '/claude-v1'))
    await old
    expect(store.get().claude).toMatchObject({ version: '2.0.0', path: '/claude-v2' })
  })

  it('re-probes rather than writing stale data even without another refresh call', async () => {
    const { store, probes, config } = harness()
    const pass = store.refresh('claude')
    config.claude.cliPath = '/claude-v2'
    probes[0]!.resolve(detected('1.0.0', '/claude-v1'))
    await drain()
    expect(probes).toHaveLength(2)
    expect(probes[1]!.options.override).toBe('/claude-v2')
    probes[1]!.resolve(detected('2.0.0', '/claude-v2'))
    await pass
    expect(store.get().claude.version).toBe('2.0.0')
  })

  it('does not publish an old-configuration failure after the override changes', async () => {
    const { config, store, probes } = harness()
    const pass = store.refresh('codex')
    Object.assign(config.codex, { cliPath: '/codex-v2' })
    probes[0]!.reject(new Error('old configuration failed'))
    await drain()
    expect(probes).toHaveLength(2)
    expect(probes[1]!.options.override).toBe('/codex-v2')
    probes[1]!.resolve(detected('2.0.0', '/codex-v2'))
    await pass
    expect(store.get().codex).toMatchObject({ version: '2.0.0', path: '/codex-v2', checking: false })
    expect(store.get().codex.error).toBeUndefined()
  })

  it('returns isolated status objects', () => {
    const { store } = harness()
    const snapshot = store.get()
    Object.assign(snapshot.claude, { version: 'mutated' })
    expect(store.get().claude.version).toBe('')
  })

  it('starts a fresh affected-CLI probe after an npm job ends', async () => {
    const { config, probes, store, notify } = harness()
    const old = store.refresh('codex')
    const freshStarted = new Promise<void>(resolve => notify(() => { if (probes.length >= 2) resolve() }))
    const spawn = scriptedSpawn(child => child.finish('npm done'))
    const registry = new TaskRegistry()
    const pathCache = { invalidate: vi.fn() }
    const deps = {
      readConfig: () => config, statusStore: store, spawnFn: spawn.spawnFn,
      registry, pathCache, controllers: new Map<string, AbortController>(),
    } as unknown as RouteDeps
    const response = handleCliNpmJob(deps, 'install', { cli: 'codex' })
    expect(response.status).toBe(200)
    await freshStarted
    expect(probes.map(probe => probe.options.cli)).toEqual(['codex', 'codex'])
    expect(probes[0]!.options.signal?.aborted).toBe(true)
    expect(pathCache.invalidate).toHaveBeenCalled()
    const fresh = store.refresh('codex')
    probes[1]!.resolve(detected('2.0.0'))
    await fresh
    probes[0]!.resolve(detected('1.0.0'))
    await old
    expect(store.get().codex.version).toBe('2.0.0')
  })
})
