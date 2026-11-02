import { describe, expect, it } from 'vitest'
import type { EffectRow } from '../src/effects.js'
import { INTERRUPTED_NOTE, restoreInterrupted, seedsOf } from '../src/recovery.js'
import { TaskRegistry } from '../src/task-registry.js'

function row(key: string, value: Record<string, unknown>): EffectRow {
  return { kind: 'launch', key, value, seq: 1, generation: 1, attempts: 0, due: 0, since: 0 }
}

const good = row('task-1', {
  taskId: 'task-1',
  cli: 'claude',
  taskName: '改个 typo',
  prompt: '把 README 的 typo 改掉',
  cwd: 'C:/repo',
  model: 'claude-sonnet-4-5',
  sessionId: 'session-1',
  startedAt: 1_000,
})

describe('recovery seeds', () => {
  it('reads a launch row back into the fields a task needs', () => {
    const [seed] = seedsOf([good])
    expect(seed).toMatchObject({ taskId: 'task-1', cli: 'claude', taskName: '改个 typo', cwd: 'C:/repo' })
  })

  it('skips rows it cannot trust instead of inventing a task', () => {
    expect(seedsOf([row('task-2', { cli: 'nope' })])).toEqual([])
    expect(seedsOf([row('task-3', { cli: 'codex' })])[0]?.taskName).toBe('CLI 任务')
  })
})

describe('restoreInterrupted', () => {
  it('brings a half-run task back as interrupted, which needs a human', () => {
    const registry = new TaskRegistry()
    const restored = restoreInterrupted(registry, [good])
    expect(restored).toEqual(['task-1'])
    const summary = registry.list()[0]
    expect(summary?.phase).toBe('interrupted')
    expect(summary?.stage).toBe('person/answer')
    expect(summary?.result?.state).toBe('waiting')
    expect(summary?.title).toBe('改个 typo')
    const task = registry.get('task-1')
    if (task === undefined) throw new Error('expected the restored task')
    registry.push(task, 'note', INTERRUPTED_NOTE)
    expect(task.events.some(event => event.text === INTERRUPTED_NOTE)).toBe(true)
  })

  it('leaves an id that persistence already restored alone', () => {
    const registry = new TaskRegistry()
    registry.create({ id: 'task-1', cli: 'claude', title: '已有', model: '', phase: 'done' })
    expect(restoreInterrupted(registry, [good])).toEqual([])
    expect(registry.list()).toHaveLength(1)
  })
})
