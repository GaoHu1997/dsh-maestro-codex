import { describe, expect, it } from 'vitest'
import type { MaestroTask } from '../src/task-registry.js'
import {
  CLI_USAGE_EVENT,
  CLI_USAGE_PROJECTION_KEY,
  CLI_USAGE_RECENT_CAP,
  EMPTY_CLI_USAGE,
  applyCliUsage,
  cliUsageProjectionDefinition,
  cliUsageRecordOf,
  installCliUsageProjection,
  projectionRegistryOf,
  reportCliUsage,
  sessionUsageAppendOf,
  type CliUsageRecord,
} from '../src/usage.js'

function task(overrides: Partial<MaestroTask> = {}): MaestroTask {
  return {
    id: 'task-1',
    cli: 'claude',
    title: 'x',
    cwd: '/tmp',
    model: 'agent-model',
    sessionId: 'session-1',
    phase: 'done',
    startedAt: 1_000,
    endedAt: 2_500,
    exitCode: 0,
    error: undefined,
    finalText: 'ok',
    stats: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 40, cacheWriteTokens: 7 },
    events: [],
    cursor: 1,
    truncated: false,
    ...overrides,
  }
}

describe('cliUsageRecordOf', () => {
  it('reads the channel stats and the wall-clock duration', () => {
    const record = cliUsageRecordOf(task())
    expect(record).toMatchObject({
      taskId: 'task-1',
      cli: 'claude',
      model: 'agent-model',
      phase: 'done',
      sessionId: 'session-1',
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 40,
      cacheWriteTokens: 7,
      durationMs: 1_500,
      exitCode: 0,
    })
  })

  it('treats missing or non-numeric stats as zero', () => {
    const record = cliUsageRecordOf(task({ stats: { inputTokens: 'many', outputTokens: 5 } }))
    expect(record.inputTokens).toBe(0)
    expect(record.outputTokens).toBe(5)
    expect(record.cachedInputTokens).toBe(0)
    expect(record.cacheWriteTokens).toBe(0)
  })

  it('stamps an unfinished record with the current time', () => {
    const before = Date.now()
    const record = cliUsageRecordOf(task({ endedAt: undefined }))
    expect(record.endedAt).toBeGreaterThanOrEqual(before)
  })
})

describe('reportCliUsage', () => {
  it('appends the usage event to the owning session', () => {
    const appended: Array<{ type: string; data: unknown }> = []
    const session = { append: (type: string, data: unknown) => { appended.push({ type, data }) } }
    reportCliUsage(session, task())
    expect(appended).toHaveLength(1)
    expect(appended[0]?.type).toBe(CLI_USAGE_EVENT)
    expect(appended[0]?.data).toMatchObject({ taskId: 'task-1', inputTokens: 120 })
  })

  it('is a no-op without a session', () => {
    expect(() => { reportCliUsage(undefined, task()) }).not.toThrow()
    expect(() => { reportCliUsage({}, task()) }).not.toThrow()
    expect(() => { reportCliUsage({ append: 'nope' }, task()) }).not.toThrow()
  })

  it('never lets a refusing session break the dispatch', () => {
    const session = { append: () => { throw new Error('read-only log') } }
    expect(() => { reportCliUsage(session, task()) }).not.toThrow()
  })
})

describe('sessionUsageAppendOf', () => {
  it('binds append to the session object', () => {
    const session = { seen: 0, append(this: { seen: number }) { this.seen += 1 } }
    const handle = sessionUsageAppendOf(session)
    handle?.append(CLI_USAGE_EVENT, {})
    expect(session.seen).toBe(1)
  })

  it('rejects non-session values', () => {
    expect(sessionUsageAppendOf(undefined)).toBeUndefined()
    expect(sessionUsageAppendOf(null)).toBeUndefined()
    expect(sessionUsageAppendOf('session')).toBeUndefined()
    expect(sessionUsageAppendOf({ append: 1 })).toBeUndefined()
  })
})

describe('applyCliUsage', () => {
  it('keeps the same reference for unrelated events', () => {
    expect(applyCliUsage(EMPTY_CLI_USAGE, { type: 'step/end' })).toBe(EMPTY_CLI_USAGE)
  })

  it('folds totals and keeps the newest runs first', () => {
    const first = cliUsageRecordOf(task({ id: 'a' }))
    const second = cliUsageRecordOf(task({ id: 'b', stats: { inputTokens: 1, outputTokens: 2 } }))
    const once = applyCliUsage(EMPTY_CLI_USAGE, { type: CLI_USAGE_EVENT, data: first })
    const twice = applyCliUsage(once, { type: CLI_USAGE_EVENT, data: second })
    expect(twice.totals.requests).toBe(2)
    expect(twice.totals.inputTokens).toBe(121)
    expect(twice.totals.outputTokens).toBe(32)
    expect(twice.recent.map(record => record.taskId)).toEqual(['b', 'a'])
  })

  it('caps the recent list', () => {
    let state = EMPTY_CLI_USAGE
    for (let index = 0; index < CLI_USAGE_RECENT_CAP + 5; index++) {
      state = applyCliUsage(state, { type: CLI_USAGE_EVENT, data: cliUsageRecordOf(task({ id: `t-${index}` })) })
    }
    expect(state.recent).toHaveLength(CLI_USAGE_RECENT_CAP)
    expect(state.recent[0]?.taskId).toBe(`t-${CLI_USAGE_RECENT_CAP + 4}`)
  })

  it('ignores malformed payloads', () => {
    const state = applyCliUsage(EMPTY_CLI_USAGE, { type: CLI_USAGE_EVENT, data: {} })
    expect(state).toBe(EMPTY_CLI_USAGE)
  })
})

describe('cliUsageProjectionDefinition', () => {
  it('declares the projection key and a synchronous wire view', () => {
    const definition = cliUsageProjectionDefinition()
    expect(definition.key).toBe(CLI_USAGE_PROJECTION_KEY)
    expect(definition.stateVersion).toBe(1)
    const record: CliUsageRecord = cliUsageRecordOf(task())
    const state = definition.apply(definition.init(undefined, 0), { type: CLI_USAGE_EVENT, data: record })
    expect(definition.wire.viewSchema.parse(definition.wire.view(state))).toBe(state)
    expect(() => definition.wire.viewSchema.parse(undefined)).toThrow()
  })
})

describe('installCliUsageProjection', () => {
  it('registers once and returns the registry disposer', () => {
    let disposed = 0
    const registered: unknown[] = []
    const host = {
      sessionProjections: {
        register: (definition: unknown) => { registered.push(definition); return () => { disposed += 1 } },
      },
    }
    const dispose = installCliUsageProjection(host)
    expect(registered).toHaveLength(1)
    dispose?.()
    expect(disposed).toBe(1)
  })

  it('is absent when the host has no registry', () => {
    expect(projectionRegistryOf({})).toBeUndefined()
    expect(projectionRegistryOf(undefined)).toBeUndefined()
    expect(projectionRegistryOf({ sessionProjections: { register: 1 } })).toBeUndefined()
    expect(installCliUsageProjection({})).toBeUndefined()
  })

  it('swallows a registry that refuses the definition', () => {
    const host = { sessionProjections: { register: () => { throw new Error('boom') } } }
    expect(installCliUsageProjection(host)).toBeUndefined()
  })
})
