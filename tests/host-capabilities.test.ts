import { describe, expect, it } from 'vitest'
import {
  HOST_PACKAGES, probeHostCapabilities, probeHostCapability, readHostPackageVersions,
} from '../src/host-capabilities.js'
import { effectiveOf } from '../src/config.js'
import { CliPathCache } from '../src/dispatch.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { StatusStore, handleOverview } from '../src/routes.js'
import { scriptedSpawn } from './fake-child.js'

const completeFaces = {
  settings: { configure: () => undefined, describe: () => [] },
  skills: { list: () => [], get: () => undefined },
  agents: { get: () => undefined },
  sessions: { create: () => undefined, get: () => undefined, list: () => [], flush: async () => true },
  sessionQuery: { readSession: async () => undefined },
  sessionPersistence: { identity: Symbol('host persistence'), create: async () => undefined, open: async () => undefined },
  sessionProjections: { register: () => undefined, stateOf: () => undefined },
  tools: { schemas: () => [], execute: async () => undefined },
  systemPrompt: { context: () => () => undefined },
  webServer: { port: 4321 },
}

const fixedVersions = { versions: () => ({ '@deepseek-ai/dsh-session': '0.2.0-rc.1' }), now: () => 1_700_000_000_000 }

const throwingProjectionFaces = [
  {
    kind: 'getter',
    face: {
      get register() { throw new Error('cannot get property "register" without inject') },
      stateOf: () => { throw new Error('diagnostics must not call services') },
    },
  },
  {
    kind: 'Proxy',
    face: new Proxy(completeFaces.sessionProjections, {
      get(target, key, receiver) {
        if (key === 'register') throw new Error('cannot get property "register" without inject')
        return Reflect.get(target, key, receiver)
      },
    }),
  },
]

describe('host capability probing', () => {
  it('reports a fully resolved host as undegraded with no missing members', () => {
    const report = probeHostCapabilities(completeFaces, fixedVersions)
    expect(report.schemaVersion).toBe(1)
    expect(report.probedAt).toBe(1_700_000_000_000)
    expect(report.degraded).toBe(false)
    expect(report.capabilities.map(capability => capability.id)).toEqual([
      'settings', 'skills', 'agents', 'sessions', 'sessionQuery',
      'sessionPersistence', 'sessionProjections', 'tools', 'systemPrompt', 'webServer',
    ])
    for (const capability of report.capabilities) {
      expect(capability.present).toBe(true)
      expect(capability.degraded).toBe('none')
      expect(capability.missing).toEqual([])
      expect(capability.impact.length).toBeGreaterThan(0)
    }
  })

  it('treats an absent face as an absent capability and names every member it cannot expose', () => {
    const result = probeHostCapability('sessions', undefined)
    expect(result.present).toBe(false)
    expect(result.degraded).toBe('absent')
    expect(result.missing).toEqual(['create', 'get', 'list', 'flush'])
    const report = probeHostCapabilities({ ...completeFaces, sessions: undefined }, fixedVersions)
    expect(report.degraded).toBe(true)
    expect(report.capabilities.find(capability => capability.id === 'sessions')?.degraded).toBe('absent')
  })

  it('flags a host release that lacks only optional members as partial, not broken', () => {
    const result = probeHostCapability('sessions', { create: () => undefined })
    expect(result.present).toBe(true)
    expect(result.degraded).toBe('partial')
    expect(result.missing).toEqual(['get', 'list', 'flush'])
    // A required member that is present keeps the capability usable.
    const noQuery = probeHostCapability('sessionPersistence', { identity: Symbol('x'), create: () => undefined })
    expect(noQuery.degraded).toBe('partial')
    expect(noQuery.missing).toEqual(['open'])
  })

  it.each(throwingProjectionFaces)('treats a throwing $kind member as missing without calling services', ({ face }) => {
    expect(probeHostCapability('sessionProjections', face)).toMatchObject({
      present: true,
      degraded: 'partial',
      missing: ['register'],
    })
  })

  it('fails closed for unreadable identities, permissive members, and permission faces', () => {
    const face = new Proxy({}, { get() { throw new Error('host face unavailable') } })
    expect(probeHostCapability('sessionPersistence', face).missing).toEqual(['identity', 'create', 'open'])
    expect(probeHostCapability('webServer', face)).toMatchObject({
      present: true, degraded: 'partial', missing: ['port'],
    })
    const report = probeHostCapabilities({ ...completeFaces, agents: face, tools: face }, fixedVersions)
    expect(report.degraded).toBe(true)
    expect(report.permissionContext).toEqual({
      source: 'unavailable', parentToken: 'absent', scopeParameterTrusted: false,
    })
  })

  it('treats an unreadable face property as an absent capability', () => {
    const report = probeHostCapabilities({
      ...completeFaces,
      get sessionProjections() { throw new Error('cannot get property "sessionProjections" without inject') },
    }, fixedVersions)
    expect(report.degraded).toBe(true)
    expect(report.capabilities.find(capability => capability.id === 'sessionProjections')).toMatchObject({
      present: false, degraded: 'absent', missing: ['register', 'stateOf'],
    })
  })

  it('requires the persistence identity to be a symbol, not any truthy value', () => {
    const fake = probeHostCapability('sessionPersistence', { identity: 'symbol', create: () => undefined, open: () => undefined })
    expect(fake.missing).toEqual(['identity'])
    expect(fake.degraded).toBe('partial')
  })

  it('never derives the permission context from a scope parameter', () => {
    const host = probeHostCapabilities(completeFaces, fixedVersions)
    expect(host.permissionContext).toEqual({
      source: 'public-agent-registry',
      parentToken: 'real-symbol-parent',
      scopeParameterTrusted: false,
    })
    const noAgent = probeHostCapabilities({ ...completeFaces, agents: undefined }, fixedVersions)
    expect(noAgent.permissionContext.source).toBe('unavailable')
    expect(noAgent.permissionContext.scopeParameterTrusted).toBe(false)
  })

  it('marks the report degraded when a host package version cannot be resolved', () => {
    const report = probeHostCapabilities(completeFaces, { versions: () => ({ '@deepseek-ai/dsh-session': null }), now: () => 0 })
    expect(report.degraded).toBe(true)
  })

  it('reads real installed host package versions without throwing', () => {
    const versions = readHostPackageVersions()
    expect(Object.keys(versions)).toEqual([...HOST_PACKAGES])
    // The dev environment installs cordis and dsh-session; the value must be a
    // real semver-ish string, never a fabricated one.
    expect(versions['@deepseek-ai/cordis']).toMatch(/^\d+\.\d+\.\d+/)
    expect(versions['@deepseek-ai/dsh-session']).toMatch(/^\d+\.\d+\.\d+/)
    for (const value of Object.values(versions)) {
      expect(value === null || /^\d+\.\d+\.\d+/.test(value)).toBe(true)
    }
  })
})

describe('overview capability report', () => {
  function deps(hostCapabilities?: () => unknown) {
    const config = effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath })
    const spawn = scriptedSpawn(child => child.finish('', 0))
    const registry = new TaskRegistry()
    return {
      readConfig: () => config,
      registry,
      limiter: new Limiter(() => config.maxConcurrentTasks),
      controllers: new Map<string, AbortController>(),
      pathCache: new CliPathCache(() => config, spawn.spawnFn),
      statusStore: new StatusStore(() => config),
      spawnFn: spawn.spawnFn,
      toolName: () => 'dispatch_cli_task',
      ...(hostCapabilities === undefined ? {} : { hostCapabilities }),
    }
  }

  it('omits the field when the host layer supplies no probe', () => {
    expect(handleOverview(deps() as never).body).not.toHaveProperty('hostCapabilities')
  })

  it('exposes the probe result verbatim on the cheap overview route', () => {
    const report = probeHostCapabilities(completeFaces, fixedVersions)
    const body = handleOverview(deps(() => report) as never).body as { hostCapabilities?: unknown }
    expect(body.hostCapabilities).toEqual(report)
  })

  it.each(throwingProjectionFaces)('returns HTTP 200 with a complete degraded report after a $kind throws', ({ face }) => {
    const outcome = handleOverview(deps(() => probeHostCapabilities({
      ...completeFaces, sessionProjections: face,
    }, fixedVersions)) as never)
    expect(outcome.status).toBe(200)
    const healthy = probeHostCapabilities(completeFaces, fixedVersions)
    const report = (outcome.body as { hostCapabilities: unknown }).hostCapabilities
    expect(report).toEqual({
      ...healthy,
      degraded: true,
      capabilities: healthy.capabilities.map(capability => capability.id === 'sessionProjections'
        ? { ...capability, degraded: 'partial', missing: ['register'] }
        : capability),
    })
    expect(() => JSON.stringify(outcome.body)).not.toThrow()
  })

  it('returns HTTP 200 when a Proxy rejects a face lookup', () => {
    const faces = new Proxy(completeFaces, {
      get(target, key, receiver) {
        if (key === 'sessionProjections') throw new Error('cannot get property "sessionProjections" without inject')
        return Reflect.get(target, key, receiver)
      },
    })
    const outcome = handleOverview(deps(() => probeHostCapabilities(faces, fixedVersions)) as never)
    expect(outcome.status).toBe(200)
    const report = (outcome.body as { hostCapabilities: ReturnType<typeof probeHostCapabilities> }).hostCapabilities
    expect(report.degraded).toBe(true)
    expect(report.capabilities).toHaveLength(10)
    expect(report.capabilities.find(capability => capability.id === 'sessionProjections')).toMatchObject({
      present: false, degraded: 'absent', missing: ['register', 'stateOf'],
    })
    expect(report.permissionContext).toEqual(probeHostCapabilities(completeFaces, fixedVersions).permissionContext)
  })
})
