import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { CliSessionRecoveryGate, REPLAY_SESSIONS_PER_WORKSPACE, replayCliSessions, type CliSessionReplayOptions, type ReplayListedSession, type ReplayPersistence } from '../src/replay.js'
import type { ChildSessionStoreFace } from '../src/child-session.js'
import type { UsageJournal } from '../src/usage-journal.js'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function homeWithRegistry(workspaces: { path: string; sessionIds: string[] }[], archived: string[] = []): string {
  const home = mkdtempSync(join(tmpdir(), 'maestro-replay-'))
  homes.push(home)
  mkdirSync(join(home, 'storages'), { recursive: true })
  const tables: Record<string, unknown> = {}
  workspaces.forEach((workspace, index) => { tables[`ws-${index}`] = workspace })
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
    global: { archivedSessionIds: archived },
    tables: { workspaces: tables },
  }))
  return home
}

function recordOf(taskId: string, parent: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId,
    cli: 'codex',
    model: 'group/gpt-6.1-sol',
    phase: 'done',
    sessionId: parent,
    startedAt: 1_000,
    endedAt: 9_000,
    durationMs: 8_000,
    inputTokens: 11,
    outputTokens: 22,
    cachedInputTokens: 33,
    cacheWriteTokens: 44,
    childSessionId: `cli-${taskId}`,
    provider: 'magpie-gateway',
    usageId: `usage-${taskId}`,
    source: 'cli:codex',
    ...overrides,
  }
}

function persistenceOf(sessions: ReplayListedSession[]): { list(): Promise<readonly ReplayListedSession[]> } {
  return { list: async () => sessions }
}

function listedOf(id: string, mtimeMs: number, createdAt = 1): ReplayListedSession {
  return { header: { id, createdAt }, revision: `1:2:3:${BigInt(mtimeMs) * 1_000_000n}:4` }
}

function runner(deps: {
  home: string
  records: readonly Record<string, unknown>[]
  sessions: readonly ReplayListedSession[]
  existing?: readonly string[]
  persistence?: ReplayPersistence
  prepareParent?: (sessionId: string) => Promise<void>
  withParent?: (sessionId: string, publish: () => Promise<void>) => Promise<void>
}): { created: { id: string; options: any }[]; run: (options?: CliSessionReplayOptions) => Promise<number> } {
  const created: { id: string; options: any }[] = []
  const live = new Map((deps.existing ?? []).map(id => [id, { append: () => undefined }]))
  const store = {
    create: (id: string, options: unknown) => {
      if (live.has(id)) throw new Error(`session "${id}" already exists`)
      const session = { append: () => undefined }
      live.set(id, session)
      created.push({ id, options })
      return session
    },
    get: (id: string) => live.get(id),
  }
  const journal = { load: async () => undefined, allRecords: () => deps.records }
  const run = (options?: CliSessionReplayOptions) => replayCliSessions({
    store: store as any,
    journal: journal as any,
    persistence: deps.persistence ?? persistenceOf([...deps.sessions]),
    dshHome: deps.home,
    readConfig: () => ({ recordChildSessions: true }),
    log: () => undefined,
    ...(deps.prepareParent === undefined ? {} : { prepareParent: deps.prepareParent }),
    ...(deps.withParent === undefined ? {} : { withParent: deps.withParent }),
  }, options)
  return { created, run }
}

describe('CLI child session replay', () => {
  it('keeps only the most recently active sessions per project', async () => {
    const ids = Array.from({ length: 40 }, (_, index) => `session-${index}`)
    const home = homeWithRegistry([{ path: 'D:/work', sessionIds: ids }])
    const records = ids.map((id, index) => recordOf(`task-${index}`, id))
    const sessions = ids.map((id, index) => listedOf(id, 1_000 + index))
    const { created, run } = runner({ home, records, sessions })
    expect(await run()).toBe(REPLAY_SESSIONS_PER_WORKSPACE)
    const kept = created.map(item => item.id)
    expect(kept).toHaveLength(30)
    expect(kept).toContain('cli-task-39')
    expect(kept).not.toContain('cli-task-0')
    expect(created[0]?.options.meta).toMatchObject({ cwd: 'D:/work', parentSession: 'session-39', origin: 'subagent' })
  })

  it('skips archived sessions and sessions without a settled record', async () => {
    const home = homeWithRegistry([{ path: 'D:/work', sessionIds: ['s-a', 's-b', 's-c'] }], ['s-a'])
    const records = [recordOf('t-a', 's-a'), recordOf('t-b', 's-b')]
    const sessions = [listedOf('s-a', 1), listedOf('s-b', 2), listedOf('s-c', 3)]
    const { created, run } = runner({ home, records, sessions })
    expect(await run()).toBe(1)
    expect(created.map(item => item.id)).toEqual(['cli-t-b'])
  })

  it('skips child sessions that are already live', async () => {
    const home = homeWithRegistry([{ path: 'D:/work', sessionIds: ['s-a'] }])
    const { created, run } = runner({
      home,
      records: [recordOf('t-a', 's-a')],
      sessions: [listedOf('s-a', 1)],
      existing: ['cli-t-a'],
    })
    expect(await run()).toBe(0)
    expect(created).toHaveLength(0)
  })

  it('ranks recent activity ahead of newer creation timestamps', async () => {
    const home = homeWithRegistry([{ path: 'D:/work', sessionIds: ['new-created', 'recently-active'] }])
    const { created, run } = runner({
      home,
      records: [recordOf('new', 'new-created'), recordOf('active', 'recently-active')],
      sessions: [listedOf('new-created', 10, 10_000), listedOf('recently-active', 20_000, 1)],
    })
    expect(await run({ perWorkspace: 1 })).toBe(1)
    expect(created.map(item => item.id)).toEqual(['cli-active'])
  })

  it('never creates a cold persisted child or rewrites any persisted header', async () => {
    const home = homeWithRegistry([{ path: 'D:/work', sessionIds: ['s-a'] }])
    const parent = Object.freeze({ header: Object.freeze({
      version: 4, id: 's-a', createdAt: 123, cwd: 'D:/original-parent', isSeeded: false, delegationDepth: 0,
    }) })
    // Real persisted children may live in _no-cwd, unlike the current project.
    // Copying the usage record's time/cwd would NOT preserve this identity.
    const cold = Object.freeze({ header: Object.freeze({
      version: 4, id: 'cli-t-a', createdAt: 456, parentSession: 's-a', isSeeded: false, origin: 'subagent', delegationDepth: 1,
    }) })
    const sessions = Object.freeze([parent, cold])
    const before = structuredClone(sessions)
    const { created, run } = runner({
      home, records: [recordOf('t-a', 's-a')], sessions, persistence: { list: async () => sessions },
    })
    expect(await run()).toBe(0)
    expect(await run()).toBe(0)
    expect(created).toEqual([])
    expect(sessions).toEqual(before)
    expect(sessions[0]?.header).toBe(parent.header)
    expect(sessions[1]?.header).toBe(cold.header)
  })

  it('is idempotent across replay calls after creating a missing live child', async () => {
    const home = homeWithRegistry([{ path: 'D:/work', sessionIds: ['s-a'] }])
    const { created, run } = runner({
      home, records: [recordOf('t-a', 's-a')], sessions: [listedOf('s-a', 1)],
    })
    expect(await run()).toBe(1)
    expect(await run()).toBe(0)
    expect(created.map(item => item.id)).toEqual(['cli-t-a'])
  })

  it('does not create after disposal while the asynchronous persistence list is pending', async () => {
    const home = homeWithRegistry([{ path: 'D:/work', sessionIds: ['s-a'] }])
    const controller = new AbortController()
    const sessions = [listedOf('s-a', 1)]
    let releaseList!: (value: readonly ReplayListedSession[]) => void
    let notifyListStarted!: () => void
    const listStarted = new Promise<void>(resolve => { notifyListStarted = resolve })
    const pendingList = new Promise<readonly ReplayListedSession[]>(resolve => { releaseList = resolve })
    const list = vi.fn(() => { notifyListStarted(); return pendingList })
    const { created, run } = runner({
      home, records: [recordOf('t-a', 's-a')], sessions, persistence: { list },
    })
    const replay = run({ signal: controller.signal })
    await listStarted
    controller.abort()
    releaseList(sessions)
    expect(await replay).toBe(0)
    expect(created).toEqual([])
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('rechecks persisted children after preparing the selected parent', async () => {
    const home = homeWithRegistry([{ path: 'D:/work', sessionIds: ['s-a'] }])
    const sessions: ReplayListedSession[] = [listedOf('s-a', 1)]
    const cold = Object.freeze({ header: Object.freeze({
      version: 4, id: 'cli-t-a', createdAt: 456, parentSession: 's-a', isSeeded: false,
    }) })
    const list = vi.fn(async () => [...sessions])
    const prepareParent = vi.fn(async (sessionId: string) => {
      expect(sessionId).toBe('s-a')
      sessions.push(cold)
    })
    const { created, run } = runner({
      home, records: [recordOf('t-a', 's-a')], sessions, persistence: { list }, prepareParent,
    })
    expect(await run()).toBe(0)
    expect(prepareParent).toHaveBeenCalledExactlyOnceWith('s-a')
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(created).toEqual([])
    expect(sessions[1]).toBe(cold)
  })

  it('fails closed when parent preparation rejects', async () => {
    const home = homeWithRegistry([{ path: 'D:/work', sessionIds: ['s-a'] }])
    const prepareParent = vi.fn(async () => { throw new Error('parent restore refused') })
    const { created, run } = runner({
      home, records: [recordOf('t-a', 's-a')], sessions: [listedOf('s-a', 1)], prepareParent,
    })
    expect(await run()).toBe(0)
    expect(prepareParent).toHaveBeenCalledExactlyOnceWith('s-a')
    expect(created).toEqual([])
  })

  it('does not create after disposal while parent preparation is pending', async () => {
    const home = homeWithRegistry([{ path: 'D:/work', sessionIds: ['s-a'] }])
    const controller = new AbortController()
    let releasePreparation!: () => void
    let notifyPreparationStarted!: () => void
    const preparationStarted = new Promise<void>(resolve => { notifyPreparationStarted = resolve })
    const pendingPreparation = new Promise<void>(resolve => { releasePreparation = resolve })
    const prepareParent = vi.fn(() => { notifyPreparationStarted(); return pendingPreparation })
    const { created, run } = runner({
      home, records: [recordOf('t-a', 's-a')], sessions: [listedOf('s-a', 1)], prepareParent,
    })
    const replay = run({ signal: controller.signal })
    await preparationStarted
    controller.abort()
    releasePreparation()
    expect(await replay).toBe(0)
    expect(created).toEqual([])
  })

  it('fails closed when the post-preparation persistence list rejects', async () => {
    const home = homeWithRegistry([{ path: 'D:/work', sessionIds: ['s-a'] }])
    const sessions = [listedOf('s-a', 1)]
    const list = vi.fn<() => Promise<readonly ReplayListedSession[]>>()
      .mockResolvedValueOnce(sessions)
      .mockRejectedValue(new Error('persistence unavailable after parent restore'))
    const prepareParent = vi.fn(async () => undefined)
    const { created, run } = runner({
      home, records: [recordOf('t-a', 's-a')], sessions, persistence: { list }, prepareParent,
    })
    expect(await run()).toBe(0)
    expect(prepareParent).toHaveBeenCalledExactlyOnceWith('s-a')
    expect(created).toEqual([])
  })

  it('holds the shared owner gate across a slow fresh list and live publication', async () => {
    const home = homeWithRegistry([{ path: 'D:/work', sessionIds: ['s-a'] }])
    const gate = new CliSessionRecoveryGate()
    const sessions = [listedOf('s-a', 1)]
    let releaseFreshList!: (value: readonly ReplayListedSession[]) => void
    let notifyFreshListStarted!: () => void
    const freshListStarted = new Promise<void>(resolve => { notifyFreshListStarted = resolve })
    const pendingFreshList = new Promise<readonly ReplayListedSession[]>(resolve => { releaseFreshList = resolve })
    const list = vi.fn<() => Promise<readonly ReplayListedSession[]>>()
      .mockResolvedValueOnce(sessions)
      .mockImplementationOnce(() => { notifyFreshListStarted(); return pendingFreshList })
    const { created, run } = runner({
      home, records: [recordOf('t-a', 's-a')], sessions, persistence: { list },
      // Preparation also uses the gate, so calling this INSIDE withParent would deadlock.
      prepareParent: owner => gate.run(owner, async () => undefined),
      withParent: (owner, publish) => gate.run(owner, publish),
    })
    const persist = vi.fn(async () => undefined)
    const nativeStarted = vi.fn()
    const nativeSawLive = vi.fn()
    const replay = run()
    await freshListStarted
    const native = gate.run('s-a', async () => {
      nativeStarted()
      // This is the native recovery's live recheck before any durable write.
      if (created.some(item => item.id === 'cli-t-a')) { nativeSawLive(); return }
      await persist()
    })
    try {
      // Another owner must progress even while the shared s-a gate is held.
      await gate.run('s-b', async () => undefined)
      expect(nativeStarted).not.toHaveBeenCalled()
      expect(persist).not.toHaveBeenCalled()
      releaseFreshList(sessions)
      expect(await replay).toBe(1)
      await native
      expect(created.map(item => item.id)).toEqual(['cli-t-a'])
      expect(nativeStarted).toHaveBeenCalledTimes(1)
      expect(nativeSawLive).toHaveBeenCalledTimes(1)
      expect(persist).not.toHaveBeenCalled()
    } finally {
      releaseFreshList(sessions)
      await Promise.allSettled([replay, native])
    }
  })

  it('skips a durable child when native recovery owns the shared gate first', async () => {
    const home = homeWithRegistry([{ path: 'D:/work', sessionIds: ['s-a'] }])
    const gate = new CliSessionRecoveryGate()
    const sessions: ReplayListedSession[] = [listedOf('s-a', 1)]
    const cold = Object.freeze({ header: Object.freeze({
      version: 4, id: 'cli-t-a', createdAt: 456, parentSession: 's-a', isSeeded: false, origin: 'subagent',
    }) })
    let releaseNativeWrite!: () => void
    let notifyNativeStarted!: () => void
    let notifyStartupListStarted!: () => void
    const nativeStarted = new Promise<void>(resolve => { notifyNativeStarted = resolve })
    const startupListStarted = new Promise<void>(resolve => { notifyStartupListStarted = resolve })
    const pendingWrite = new Promise<void>(resolve => { releaseNativeWrite = resolve })
    const native = gate.run('s-a', async () => {
      notifyNativeStarted()
      await pendingWrite
      sessions.push(cold)
    })
    await nativeStarted
    const list = vi.fn(async () => { notifyStartupListStarted(); return [...sessions] })
    const { created, run } = runner({
      home, records: [recordOf('t-a', 's-a')], sessions, persistence: { list },
      prepareParent: owner => gate.run(owner, async () => undefined),
      withParent: (owner, publish) => gate.run(owner, publish),
    })
    const replay = run()
    await startupListStarted
    try {
      await gate.run('s-b', async () => undefined)
      expect(created).toEqual([])
      expect(list).toHaveBeenCalledTimes(1)
      releaseNativeWrite()
      await native
      expect(await replay).toBe(0)
      expect(list.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(created).toEqual([])
      expect(sessions[1]).toBe(cold)
      expect(cold.header).not.toHaveProperty('cwd')
      expect(cold.header.createdAt).toBe(456)
    } finally {
      releaseNativeWrite()
      await Promise.allSettled([replay, native])
    }
  })

  it('does not publish after disposal while waiting for the shared owner gate', async () => {
    const home = homeWithRegistry([{ path: 'D:/work', sessionIds: ['s-a'] }])
    const gate = new CliSessionRecoveryGate()
    const controller = new AbortController()
    let releaseOwner!: () => void
    let notifyPublishQueued!: () => void
    const ownerHeld = new Promise<void>(resolve => { releaseOwner = resolve })
    const publishQueued = new Promise<void>(resolve => { notifyPublishQueued = resolve })
    const native = gate.run('s-a', () => ownerHeld)
    const sessions = [listedOf('s-a', 1)]
    const list = vi.fn(async () => sessions)
    const { created, run } = runner({
      home, records: [recordOf('t-a', 's-a')], sessions, persistence: { list },
      withParent: (owner, publish) => { notifyPublishQueued(); return gate.run(owner, publish) },
    })
    const replay = run({ signal: controller.signal })
    await publishQueued
    controller.abort()
    releaseOwner()
    await native
    expect(await replay).toBe(0)
    expect(created).toEqual([])
  })

  it('does not poison the shared gate queue after a rejected owner action', async () => {
    const gate = new CliSessionRecoveryGate()
    const order: string[] = []
    const first = gate.run('s-a', async () => { order.push('first'); throw new Error('native recovery refused') })
    const observedFirst = expect(first).rejects.toThrow('native recovery refused')
    const second = gate.run('s-a', async () => { order.push('second') })
    await observedFirst
    await second
    const third = gate.run('s-a', async () => { order.push('third') })
    await third
    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('preserves real live headers and persisted cold identity while announcing only missing children', async () => {
    const home = homeWithRegistry([{ path: 'D:/work', sessionIds: ['s-a'] }])
    const root = new Context()
    const fiber = root.plugin(SessionStore)
    await fiber.await()
    try {
      const nativeStore = root.sessions
      const parent = nativeStore.create('s-a', { meta: { createdAt: 123, cwd: 'D:/original-parent' } })
      const live = nativeStore.create('cli-live', { meta: {
        createdAt: 789, cwd: 'D:/original-child', parentSession: 's-a', origin: 'subagent', delegationDepth: 1,
      } })
      const cold = Object.freeze({ header: Object.freeze({
        version: 4, id: 'cli-cold', createdAt: 456, parentSession: 's-a', isSeeded: false, origin: 'subagent', delegationDepth: 1,
      }) })
      const persisted = Object.freeze([{ header: parent.header }, { header: live.header }, cold])
      const before = structuredClone(persisted)
      const parentHeader = parent.header
      const liveHeader = live.header
      const announced: string[] = []
      root.on('session/created', session => { announced.push(session.id) })
      const store = nativeStore as unknown as ChildSessionStoreFace
      const journal = { load: async () => undefined, allRecords: () => [
        recordOf('cold', 's-a'), recordOf('live', 's-a'), recordOf('fresh', 's-a'),
      ] } as unknown as UsageJournal
      const deps = {
        store, journal, persistence: { list: async () => persisted }, dshHome: home,
        readConfig: () => ({ recordChildSessions: true }), log: () => undefined,
      }
      expect(await replayCliSessions(deps)).toBe(1)
      expect(await replayCliSessions(deps)).toBe(0)
      expect(announced).toEqual(['cli-fresh'])
      expect(nativeStore.get('cli-cold')).toBeUndefined()
      expect(nativeStore.get('s-a')).toBe(parent)
      expect(nativeStore.get('cli-live')).toBe(live)
      expect(parent.header).toBe(parentHeader)
      expect(live.header).toBe(liveHeader)
      expect(persisted).toEqual(before)
      const fresh = nativeStore.get('cli-fresh')
      expect(fresh?.header).toMatchObject({
        version: 4, id: 'cli-fresh', createdAt: 1_000, cwd: 'D:/work', parentSession: 's-a', isSeeded: false, origin: 'subagent',
      })
      expect(fresh?.snapshotEvents().map(event => event.type)).toEqual([
        'user/message', 'maestro/cli-child', 'request/context', 'step/start', 'assistant/message', 'session/end-seed',
      ])
    } finally { await root.fiber.dispose() }
  })

  it('replays the native settlement shape with the canonical usage', async () => {
    const home = homeWithRegistry([{ path: 'D:/work', sessionIds: ['s-a'] }])
    const { created, run } = runner({ home, records: [recordOf('t-a', 's-a')], sessions: [listedOf('s-a', 1)] })
    await run()
    const seed = created[0]?.options.seed as readonly { type: string; data: any }[]
    expect(seed.map(event => event.type)).toEqual(['user/message', 'maestro/cli-child', 'request/context', 'step/start', 'assistant/message'])
    expect(seed[2]?.data).toEqual({ provider: 'magpie-gateway', model: 'group/gpt-6.1-sol' })
    expect(seed[3]?.data).toEqual({ turn: 1, step: 1 })
    expect(seed[4]?.data).toMatchObject({
      turn: 1,
      step: 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'magpie-gateway', model: 'group/gpt-6.1-sol' } },
      usage: { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 },
    })
  })

  it('replays failed settlements as an attempt', async () => {
    const home = homeWithRegistry([{ path: 'D:/work', sessionIds: ['s-a'] }])
    const { created, run } = runner({
      home,
      records: [recordOf('t-a', 's-a', { phase: 'failed' })],
      sessions: [listedOf('s-a', 1)],
    })
    await run()
    const seed = created[0]?.options.seed as readonly { type: string; data: any }[]
    expect(seed.at(-1)?.type).toBe('assistant/attempt')
    expect(seed.at(-1)?.data.stream[0].chunk.usage).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 })
  })

  it('does nothing without a workspace registry or when recording is disabled', async () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-replay-'))
    homes.push(home)
    const { run } = runner({ home, records: [recordOf('t-a', 's-a')], sessions: [listedOf('s-a', 1)] })
    expect(await run()).toBe(0)
    const disabledHome = homeWithRegistry([{ path: 'D:/work', sessionIds: ['s-a'] }])
    const store = { create: () => { throw new Error('must not create') }, get: () => undefined }
    const count = await replayCliSessions({
      store: store as any,
      journal: { load: async () => undefined, allRecords: () => [recordOf('t-a', 's-a')] } as any,
      persistence: persistenceOf([listedOf('s-a', 1)]),
      dshHome: disabledHome,
      readConfig: () => ({ recordChildSessions: false }),
      log: () => undefined,
    })
    expect(count).toBe(0)
  })
})
