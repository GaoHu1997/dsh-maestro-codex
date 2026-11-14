import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectiveOf } from '../src/config.js'
import { CliPathCache, runDispatch, type DispatchDeps, type DispatchParams } from '../src/dispatch.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { clearCliUsageMirrors, cliUsageProjectionDefinition, cliUsageRecordOf, type CliUsageRecord } from '../src/usage.js'
import { scriptedSpawn } from './fake-child.js'

// M: production runner + scripted CLI frames + controlled accounting failures.
// Filesystem durability and real host checkpoints are tested independently.
function fixture() {
  const order: string[] = []
  const config = effectiveOf({ claudeCliPath: process.execPath, bridgeSkills: false, bridgeTools: 'off' })
  config.claude.dshModel = 'test-provider::test-model'
  const spawn = scriptedSpawn(child => {
    if (child.spawnArgs[0] === '--version') child.finish('claude version 9.9.9')
    else if (!child.spawnArgs.includes('-p')) child.finish('')
    else {
      order.push('cli')
      child.finish(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'finished', session_id: 'pipeline-thread', usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }))
    }
  })
  const registry = new TaskRegistry(), controllers = new Map<string, AbortController>()
  const parent = { id: 'owner-pipeline', append: vi.fn() }
  const childSessions = { start: vi.fn(), settle: vi.fn(() => { order.push('native') }) }
  const deps: DispatchDeps = {
    readConfig: () => config, registry, controllers, limiter: new Limiter(() => 1), childSessions,
    pathCache: new CliPathCache(() => config, spawn.spawnFn), spawnFn: spawn.spawnFn,
    resolveDshModel: async () => ({ provider: 'test-provider', model: 'test-model', api: 'anthropic-messages', baseURL: 'https://example.invalid', apiKey: 'synthetic-non-secret' }),
  }
  const params: DispatchParams = { cli: 'claude', task: 'Analyze scoped fixture metrics and summarize their verification steps.', taskDifficulty: 'medium', difficultyReason: 'Independent multi-step fixture processing and verification', sessionId: parent.id, usageSession: parent, cwd: process.cwd() }
  const canonical: CliUsageRecord[] = []
  const definition = cliUsageProjectionDefinition(sessionId => canonical.filter(record => record.sessionId === sessionId))
  const state = definition.init({ id: parent.id }, 0)
  const view = () => definition.wire.view(state)
  return { deps, params, order, spawn, registry, controllers, parent, childSessions, canonical, state, view }
}

function expectMeasuredUsage(f: ReturnType<typeof fixture>): void {
  const projected = f.view()
  expect(f.parent.append).not.toHaveBeenCalled()
  expect(f.state.totals.requests).toBe(0)
  expect(projected.recent).toHaveLength(1)
  expect(projected.recent[0]).toMatchObject({
    taskId: f.registry.list()[0]!.id, sessionId: f.parent.id,
    cli: 'claude', phase: 'done', model: 'test-model',
    inputTokens: 10, outputTokens: 4, cachedInputTokens: 0, cacheWriteTokens: 0,
  })
  expect(projected.totals).toMatchObject({
    requests: 1, inputTokens: 10, outputTokens: 4, cachedInputTokens: 0, cacheWriteTokens: 0,
  })
  expect(f.view()).toEqual(projected)
}

beforeEach(() => { clearCliUsageMirrors() })

describe('canonical accounting lifecycle remains distinct from CLI execution success', () => {
  it('does not launch a CLI when the durable begin marker is unavailable', async () => {
    const f = fixture()
    f.deps.beginUsage = async () => { throw new Error('synthetic marker failure') }
    f.deps.settleUsage = async () => { throw new Error('synthetic storage failure') }
    await expect(runDispatch(f.deps, f.params, new AbortController().signal)).rejects.toThrow('synthetic marker failure')
    expect(f.order).not.toContain('cli')
    const task = f.registry.get(f.registry.list()[0]!.id)!
    expect(task.phase).toBe('failed')
    expect(task.stats?.['accountingBeginState']).toBe('failed')
    expect(task.stats?.['accountingState']).toBe('unconfirmed')
    expect(f.parent.append).not.toHaveBeenCalled()
    expect(f.canonical).toEqual([])
    const projected = f.view()
    const tokens = { inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteTokens: null }
    expect(projected.recent).toHaveLength(1)
    expect(projected.recent[0]).toMatchObject({ taskId: task.id, sessionId: f.parent.id, phase: 'failed', ...tokens })
    expect(projected.totals).toMatchObject({ requests: 1, ...tokens })
    expect(f.state.totals.requests).toBe(0)
    expect(f.controllers.size).toBe(0)
  })
  it('commits the canonical source before settling native record usage', async () => {
    const f = fixture()
    f.deps.beginUsage = async () => { f.order.push('marker') }
    f.deps.settleUsage = async task => {
      f.order.push('canonical')
      f.canonical.push(cliUsageRecordOf(task))
      task.stats = { ...task.stats, accountingState: 'canonical-stored' }
    }
    const value = await runDispatch(f.deps, f.params, new AbortController().signal)
    expect(value.ok).toBe(true)
    expect(f.order).toEqual(['marker', 'cli', 'canonical', 'native'])
    expect(value.notes).toContain('accountingState: canonical-stored')
    expectMeasuredUsage(f)
    clearCliUsageMirrors()
    expectMeasuredUsage(f)
  })
  it('preserves a valid final answer while exposing settlement failure in result notes and machine state', async () => {
    const f = fixture()
    f.deps.beginUsage = async () => {}
    f.deps.settleUsage = async () => { throw new Error('synthetic settlement failure') }
    const value = await runDispatch(f.deps, f.params, new AbortController().signal)
    expect(value.ok).toBe(true)
    expect(value.finalText).toBe('finished')
    expect(value.notes.some(note => note.includes('持久化用量或宿主投影尚未确认'))).toBe(true)
    expect(value.notes).toContain('accountingState: unconfirmed')
    expectMeasuredUsage(f)
    expect(f.childSessions.settle).toHaveBeenCalledTimes(1)
    expect(f.controllers.size).toBe(0)
  })
  it('does not downgrade a committed canonical record when only host publication fails', async () => {
    const f = fixture()
    f.deps.beginUsage = async () => {}
    f.deps.settleUsage = async task => {
      f.canonical.push(cliUsageRecordOf(task))
      task.stats = { ...task.stats, accountingState: 'canonical-stored-host-replay-pending' }
      throw new Error('synthetic host checkpoint failure')
    }
    const value = await runDispatch(f.deps, f.params, new AbortController().signal)
    expect(value.ok).toBe(true)
    expect(value.finalText).toBe('finished')
    expect(value.notes).toContain('accountingState: canonical-stored-host-replay-pending')
    // Canonical and the fallback runtime mirror describe the same settlement.
    expectMeasuredUsage(f)
    clearCliUsageMirrors()
    expectMeasuredUsage(f)
    expect(f.childSessions.settle).toHaveBeenCalledTimes(1)
  })
})
