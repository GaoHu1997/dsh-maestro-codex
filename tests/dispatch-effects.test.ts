import { describe, expect, it, vi } from 'vitest'
import { effectiveOf, type EffectiveConfig } from '../src/config.js'
import { CliPathCache, runDispatch, type DispatchParams } from '../src/dispatch.js'
import { DedupeGuard, DuplicateDispatchError } from '../src/dedupe.js'
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

/** 假的 CLI：按 claude 的 JSON 流回一段结论；`finalText` 决定收尾行。 */
function claudeSpawn(finalText: string, ok = true): ReturnType<typeof scriptedSpawn> {
  return scriptedSpawn(child => {
    if (child.spawnArgs[0] === '--version') {
      child.finish('claude version 9.9.9 (CCL)')
      return
    }
    child.finish([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: finalText, is_error: !ok, num_turns: 1 }),
    ].join('\n'), ok ? 0 : 1)
  })
}

class RecordingLimiter extends Limiter {
  readonly priorities: string[] = []

  override acquire(signal: AbortSignal, options?: { readonly priority?: 'normal' | 'human' | undefined }) {
    this.priorities.push(options?.priority ?? 'normal')
    return super.acquire(signal, options)
  }
}

function makeDeps(spawnFn: ReturnType<typeof scriptedSpawn>['spawnFn'], extra: Partial<Record<string, unknown>> = {}) {
  const registry = new TaskRegistry()
  const controllers = new Map<string, AbortController>()
  const effects = new EffectQueue()
  const dedupe = new DedupeGuard()
  const healthBoard = new HealthBoard()
  const limiter = new RecordingLimiter(() => 4)
  return {
    registry,
    effects,
    dedupe,
    healthBoard,
    limiter,
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

describe('runDispatch + effects', () => {
  it('records a launch row and settles it when the task finishes', async () => {
    const spawn = claudeSpawn('改完了三处。')
    const { deps, registry, effects } = makeDeps(spawn.spawnFn)
    const value = await runDispatch(deps, params, new AbortController().signal)
    expect(value.ok).toBe(true)
    expect(effects.size()).toBe(0)
    const summary = registry.list()[0]
    expect(summary?.phase).toBe('done')
    expect(summary?.stage).toBe('person/review')
  })

  it('keeps the prompt and cwd in the row so a restart can explain itself', async () => {
    const spawn = claudeSpawn('好的。')
    const { deps, effects } = makeDeps(spawn.spawnFn)
    const seen: unknown[] = []
    effects.enqueue = async (kind, key, value) => {
      seen.push({ kind, key, value })
      return { kind, key, value, seq: 1, generation: 1, attempts: 0, due: 0, since: 0 }
    }
    await runDispatch(deps, params, new AbortController().signal)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'launch', value: { prompt: params.task, cli: 'claude' } })
  })

  it('settles the row even when the task fails', async () => {
    const spawn = claudeSpawn('', false)
    const { deps, registry, effects } = makeDeps(spawn.spawnFn)
    await expect(runDispatch(deps, params, new AbortController().signal)).rejects.toThrow('任务失败')
    expect(effects.size()).toBe(0)
    expect(registry.list()[0]?.stage).toBe('person/failed')
  })
})

describe('runDispatch + protocol result', () => {
  it('reads the structured result and derives the stage from it', async () => {
    const spawn = claudeSpawn('改了两处，剩下一处要你确认。\nMAESTRO_RESULT {"state":"blocked","human_action":"确认线上库能否直连","summary":"卡在权限"}')
    const { deps, registry } = makeDeps(spawn.spawnFn)
    await runDispatch(deps, params, new AbortController().signal)
    const summary = registry.list()[0]
    expect(summary?.result).toEqual({ state: 'blocked', humanAction: '确认线上库能否直连', summary: '卡在权限', source: 'protocol' })
    expect(summary?.stage).toBe('person/blocked')
  })

  it('falls back to ready when the CLI says nothing about its state', async () => {
    const spawn = claudeSpawn('改完了。')
    const { deps, registry } = makeDeps(spawn.spawnFn)
    await runDispatch(deps, params, new AbortController().signal)
    expect(registry.list()[0]?.result).toEqual({ state: 'ready', source: 'fallback' })
  })
})

describe('runDispatch + dedupe', () => {
  it('refuses the same dispatch twice inside the window', async () => {
    const spawn = claudeSpawn('第一次跑完了。')
    const { deps } = makeDeps(spawn.spawnFn)
    await runDispatch(deps, params, new AbortController().signal)
    await expect(runDispatch(deps, params, new AbortController().signal)).rejects.toThrow(DuplicateDispatchError)
  })

  it('honours an explicit dedupe key and releases it after a failure', async () => {
    const failing = claudeSpawn('', false)
    const { deps } = makeDeps(failing.spawnFn)
    const keyed = { ...params, dedupeKey: 'release-42' }
    await expect(runDispatch(deps, keyed, new AbortController().signal)).rejects.toThrow('任务失败')
    // 失败不占窗口：同一个键可以再派发一次。
    await expect(runDispatch(deps, keyed, new AbortController().signal)).rejects.toThrow('任务失败')
  })

  it('does not dedupe a resume: continuing the same task twice is legitimate', async () => {
    const spawn = claudeSpawn('继续做完了。')
    const { deps, registry } = makeDeps(spawn.spawnFn)
    const first = await runDispatch(deps, params, new AbortController().signal)
    const resumed: DispatchParams = { ...params, task: '继续', resume: first.sessionRef }
    await runDispatch(deps, resumed, new AbortController().signal)
    expect(registry.list()).toHaveLength(2)
  })
})

describe('runDispatch + priority', () => {
  it('asks for the human lane only when the dispatch answers a person', async () => {
    const spawn = claudeSpawn('跑完了。')
    const { deps, registry, limiter } = makeDeps(spawn.spawnFn)
    const first = await runDispatch(deps, params, new AbortController().signal)
    const anchorId = registry.list()[0]?.id ?? ''
    await runDispatch(
      deps,
      { ...params, task: '继续', resume: first.sessionRef, replyTo: anchorId },
      new AbortController().signal,
    )
    expect(limiter.priorities).toEqual(['normal', 'human'])
  })
})

describe('runDispatch + prepareCommand', () => {
  it('runs the prepare command before the CLI and fails the round when it fails', async () => {
    const spawn = claudeSpawn('不该跑到这里。')
    const { deps, registry } = makeDeps(spawn.spawnFn, { prepareCommand: () => 'exit 3' })
    await expect(runDispatch(deps, params, new AbortController().signal)).rejects.toThrow('prepareCommand 失败')
    const summary = registry.list()[0]
    expect(summary?.phase).toBe('failed')
    expect(summary?.stage).toBe('person/failed')
    // 只有版本探测和就绪命令：CLI 本体（一长串参数）没有被启动。
    expect(spawn.launches.filter(child => child.spawnArgs.length > 5)).toHaveLength(0)
  })

  it('leaves the run alone when no prepare command is configured', async () => {
    const spawn = claudeSpawn('正常跑完。')
    const { deps, registry } = makeDeps(spawn.spawnFn, { prepareCommand: () => '   ' })
    await runDispatch(deps, params, new AbortController().signal)
    expect(registry.list()[0]?.phase).toBe('done')
    expect(spawn.launches.some(child => child.spawnArgs.length > 5)).toBe(true)
  })
})
