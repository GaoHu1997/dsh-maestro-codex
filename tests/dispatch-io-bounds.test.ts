import { describe, expect, it } from 'vitest'
import { effectiveOf, type EffectiveConfig } from '../src/config.js'
import { CliPathCache, runDispatch, type DispatchParams } from '../src/dispatch.js'
import { DedupeGuard } from '../src/dedupe.js'
import { EffectQueue } from '../src/effects.js'
import { HealthBoard } from '../src/health.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { scriptedSpawn } from './fake-child.js'
import { resolveTestDshModel, withTestDshRoutes } from './dsh-route-fixture.js'

const assessment = {
  taskDifficulty: 'medium' as const,
  difficultyReason: '范围明确的多步任务，需要实现并验证输出和回归行为',
}

function config(overrides: Record<string, unknown> = {}): EffectiveConfig {
  return withTestDshRoutes(effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath, ...overrides }))
}

function claudeSpawn(finalText: string): ReturnType<typeof scriptedSpawn> {
  return scriptedSpawn(child => {
    if (child.spawnArgs[0] === '--version') {
      child.finish('claude version 9.9.9 (CCL)')
      return
    }
    child.finish([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: finalText, is_error: false, num_turns: 1 }),
    ].join('\n'), 0)
  })
}

function makeDeps(spawnFn: ReturnType<typeof scriptedSpawn>['spawnFn'], extra: Record<string, unknown> = {}) {
  const registry = new TaskRegistry()
  const controllers = new Map<string, AbortController>()
  const effects = new EffectQueue()
  const dedupe = new DedupeGuard()
  const healthBoard = new HealthBoard()
  const limiter = new Limiter(() => 4)
  return {
    registry,
    effects,
    limiter,
    controllers,
    deps: {
      readConfig: () => config(),
      registry,
      limiter,
      controllers,
      pathCache: new CliPathCache(() => config(), spawnFn),
      spawnFn,
      resolveDshModel: resolveTestDshModel,
      effects,
      dedupe,
      health: healthBoard.claim('dispatch'),
      ...extra,
    },
  }
}

const params: DispatchParams = { cli: 'claude', task: '把 README 的 typo 改掉', ...assessment, sessionId: 'sess-parent' }
const never = (): Promise<never> => new Promise<never>(() => { /* never settles */ })

describe('runDispatch host-IO budgets', () => {
  it('does not hang when the effect queue never records the launch', async () => {
    const spawn = claudeSpawn('改好了。')
    const { deps, registry, controllers, limiter } = makeDeps(spawn.spawnFn, {
      ioTimeouts: { startupMs: 30 },
    })
    deps.effects.enqueue = never
    const started = Date.now()
    const value = await runDispatch(deps, params, new AbortController().signal)
    expect(value.ok).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(registry.list()[0]?.phase).toBe('done')
    expect(controllers.size).toBe(0)
    expect(limiter.activeCount()).toBe(0)
  })

  it('fails closed and releases the slot when beginUsage never returns', async () => {
    const spawn = claudeSpawn('改好了。')
    const { deps, controllers, limiter } = makeDeps(spawn.spawnFn, {
      ioTimeouts: { startupMs: 30 },
      beginUsage: never,
    })
    const error = await runDispatch(deps, params, new AbortController().signal).catch((value: unknown) => value)
    // The dispatch layer wraps host-IO deadlines in its own DispatchError, so
    // assert the message rather than the original error type.
    expect((error as Error).message).toContain('用量记账开始')
    expect(controllers.size).toBe(0)
    expect(limiter.activeCount()).toBe(0)
  })

  it('reports the result even when settleUsage never returns', async () => {
    const spawn = claudeSpawn('交付完成。')
    const { deps, registry } = makeDeps(spawn.spawnFn, {
      ioTimeouts: { settleMs: 30 },
      settleUsage: never,
    })
    const started = Date.now()
    const value = await runDispatch(deps, params, new AbortController().signal)
    expect(value.ok).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(registry.list()[0]?.phase).toBe('done')
  })
})
