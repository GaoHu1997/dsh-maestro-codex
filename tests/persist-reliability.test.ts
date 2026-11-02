import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPersistedTasks, persistedOf, persistTask } from '../src/persist.js'
import { TaskRegistry } from '../src/task-registry.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'maestro-persist-reliability-'))
}

describe('persisted results', () => {
  it('omits the result field when the task never wrote one', () => {
    const registry = new TaskRegistry()
    const task = registry.create({ id: 'task-1', cli: 'claude', title: '改个 typo', model: 'm', cwd: 'C:/repo' })
    registry.setPhase(task, 'done', '执行完成')
    expect(persistedOf(task, 5_000)).not.toHaveProperty('result')
  })

  it('keeps a structured result across a restart', async () => {
    const dir = home()
    const registry = new TaskRegistry()
    const task = registry.create({ id: 'task-1', cli: 'claude', title: '改个 typo', model: 'm', cwd: 'C:/repo', sessionId: 's' })
    registry.setPhase(task, 'done', '执行完成')
    registry.setResult(task, { state: 'blocked', humanAction: '确认线上库能否直连', summary: '卡在权限', source: 'protocol' })
    await persistTask(dir, task)
    const records = await loadPersistedTasks(dir)
    expect(records[0]?.result).toEqual({ state: 'blocked', humanAction: '确认线上库能否直连', summary: '卡在权限', source: 'protocol' })
    const restored = new TaskRegistry()
    for (const record of records) restored.restore(record)
    expect(restored.list()[0]?.stage).toBe('person/blocked')
  })

  it('persists an interrupted task, which is terminal without being a failure', async () => {
    const dir = home()
    const registry = new TaskRegistry()
    const task = registry.create({ id: 'task-1', cli: 'codex', title: '没跑完的', model: 'm', cwd: 'C:/repo', phase: 'interrupted' })
    await persistTask(dir, task)
    const records = await loadPersistedTasks(dir)
    expect(records[0]?.phase).toBe('interrupted')
    const restored = new TaskRegistry()
    for (const record of records) restored.restore(record)
    expect(restored.list()[0]?.stage).toBe('person/answer')
  })

  it('still skips npm jobs, which are not CLI tasks', async () => {
    const dir = home()
    const registry = new TaskRegistry()
    const job = registry.create({ id: 'npm-1', cli: 'claude', title: '安装', model: '', kind: 'npm' })
    registry.setPhase(job, 'done', '装好了')
    await persistTask(dir, job)
    expect(await loadPersistedTasks(dir)).toEqual([])
  })
})
