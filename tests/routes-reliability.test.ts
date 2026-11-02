import { describe, expect, it } from 'vitest'
import { ConfigHistory } from '../src/config-history.js'
import { effectiveOf } from '../src/config.js'
import { CliPathCache } from '../src/dispatch.js'
import { EffectQueue } from '../src/effects.js'
import { HealthBoard } from '../src/health.js'
import { PromptBook } from '../src/prompts.js'
import { StatusStore, handleConfigHistory, handleHealth, handlePrompts, handlePromptsSave, handleStatus, replyTextOf } from '../src/routes.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { scriptedSpawn } from './fake-child.js'

function makeDeps() {
  const config = effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath })
  const registry = new TaskRegistry()
  const controllers = new Map<string, AbortController>()
  const spawn = scriptedSpawn(child => { child.finish('') })
  return {
    registry,
    deps: {
      readConfig: () => config,
      registry,
      limiter: new Limiter(() => 2),
      controllers,
      pathCache: new CliPathCache(() => config, spawn.spawnFn),
      spawnFn: spawn.spawnFn,
      statusStore: new StatusStore(() => config),
      toolName: () => 'dispatch_cli_task',
    },
  }
}

describe('handleHealth', () => {
  it('says nothing when nothing is wrong', () => {
    const { deps } = makeDeps()
    expect(handleHealth(deps).body).toEqual({ worst: 'ok', entries: [] })
  })

  it('surfaces only the entries that were actually claimed', () => {
    const { deps } = makeDeps()
    const board = new HealthBoard()
    board.claim('effects').set('error', '队列连续失败')
    const outcome = handleHealth({ ...deps, healthBoard: board })
    const body = outcome.body as { worst: string; entries: Array<{ name: string }> }
    expect(body.worst).toBe('error')
    expect(body.entries.map(entry => entry.name)).toEqual(['effects'])
  })
})

describe('handleStatus', () => {
  it('counts every stage and reports how many wait on a person', () => {
    const { deps, registry } = makeDeps()
    const running = registry.create({ id: 'task-running', cli: 'claude', title: '跑着的', model: '' })
    registry.setPhase(running, 'running', '执行中')
    const reviewing = registry.create({ id: 'task-done', cli: 'claude', title: '跑完的', model: '' })
    registry.setPhase(reviewing, 'done', '执行完成')
    const failed = registry.create({ id: 'task-failed', cli: 'codex', title: '失败的', model: '' })
    registry.setPhase(failed, 'failed', '失败了')
    const queued = registry.create({ id: 'task-queued', cli: 'codex', title: '排队的', model: '' })

    const outcome = handleStatus({ ...deps, effects: new EffectQueue() })
    const body = outcome.body as { tasks: Record<string, number>; needsPerson: number; pendingEffects: number }
    expect(body.tasks['working']).toBe(1)
    expect(body.tasks['working/queued']).toBe(1)
    expect(body.tasks['person/review']).toBe(1)
    expect(body.tasks['person/failed']).toBe(1)
    expect(body.needsPerson).toBe(2)
    expect(body.pendingEffects).toBe(0)
    expect(queued.phase).toBe('queued')
  })

  it('counts queued effect rows so a half-finished launch is visible', async () => {
    const { deps } = makeDeps()
    const effects = new EffectQueue()
    await effects.enqueue('launch', 'task-x', {})
    const body = handleStatus({ ...deps, effects }).body as { pendingEffects: number }
    expect(body.pendingEffects).toBe(1)
  })
})

describe('handlePrompts / handlePromptsSave', () => {
  it('lists the shipped fragments and answers 503 without a prompt book', () => {
    const { deps } = makeDeps()
    expect(handlePrompts(deps).body).toMatchObject({ cap: 1000, fragments: [] })
    expect(handlePrompts(deps).status).toBe(200)
  })

  it('saves an override and resets it with empty text', async () => {
    const { deps } = makeDeps()
    const prompts = new PromptBook()
    const withPrompts = { ...deps, prompts }
    const saved = await handlePromptsSave(withPrompts, { id: 'routingHint', text: '新的一句提示' })
    expect(saved.status).toBe(200)
    expect(prompts.text('routingHint')).toBe('新的一句提示')
    const reset = await handlePromptsSave(withPrompts, { id: 'routingHint', text: '   ' })
    expect(reset.status).toBe(200)
    expect(prompts.list().find(entry => entry.id === 'routingHint')?.edited).toBe(false)
  })

  it('rejects an unknown id and a non-string body', async () => {
    const { deps } = makeDeps()
    const withPrompts = { ...deps, prompts: new PromptBook() }
    expect((await handlePromptsSave(withPrompts, { id: 'nope', text: 'x' })).status).toBe(400)
    expect((await handlePromptsSave(withPrompts, { id: 'routingHint', text: 42 })).status).toBe(400)
    expect((await handlePromptsSave(deps, { id: 'routingHint', text: 'x' })).status).toBe(503)
  })
})

describe('handleConfigHistory', () => {
  it('answers 503 without a history and lists snapshots when there is one', async () => {
    const { deps } = makeDeps()
    expect(handleConfigHistory(deps).status).toBe(503)
    const configHistory = new ConfigHistory()
    await configHistory.record(effectiveOf({}))
    await configHistory.record(effectiveOf({ maxConcurrentTasks: 3 }))
    const body = handleConfigHistory({ ...deps, configHistory }).body as { entries: unknown[]; latest: Array<{ field: string }> }
    expect(body.entries).toHaveLength(2)
    expect(body.latest.map(change => change.field)).toContain('maxConcurrentTasks')
  })
})

describe('replyTextOf', () => {
  it('leaves the text alone when no prefix is configured', () => {
    expect(replyTextOf('', '把测试补上')).toBe('把测试补上')
    expect(replyTextOf('   ', '把测试补上')).toBe('把测试补上')
  })

  it('puts the configured opening line before what the person wrote', () => {
    expect(replyTextOf('继续上次的任务。', '把测试补上')).toBe('继续上次的任务。\n\n把测试补上')
  })
})
