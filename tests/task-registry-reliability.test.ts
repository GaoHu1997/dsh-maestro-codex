import { describe, expect, it } from 'vitest'
import { TaskRegistry, isTerminalPhase } from '../src/task-registry.js'

describe('interrupted tasks', () => {
  it('is terminal without being a failure', () => {
    expect(isTerminalPhase('interrupted')).toBe(true)
    const registry = new TaskRegistry()
    const task = registry.create({ id: 'task-1', cli: 'claude', title: '中断的', model: 'm', phase: 'interrupted' })
    expect(task.endedAt).toBeGreaterThan(0)
    expect(task.error).toBeUndefined()
    const summary = registry.summaryOf(task)
    expect(summary.phase).toBe('interrupted')
    expect(summary.stage).toBe('person/answer')
    expect(summary.result).toEqual({ state: 'waiting', humanAction: '决定是否重新派发', source: 'fallback' })
  })

  it('reports an event so the detail view can explain it', () => {
    const registry = new TaskRegistry()
    const task = registry.create({
      id: 'task-1',
      cli: 'claude',
      title: '中断的',
      model: 'm',
      phase: 'interrupted',
      note: '已中断：上次退出时这个任务还没跑完',
    })
    const page = registry.eventsSince(task.id, 0)
    expect(page?.events.some(event => event.kind === 'phase' && event.text.includes('已中断'))).toBe(true)
  })
})

describe('structured results', () => {
  it('keeps the protocol result and prefers it over the fallback', () => {
    const registry = new TaskRegistry()
    const task = registry.create({ id: 'task-1', cli: 'claude', title: '跑完了', model: 'm' })
    registry.setPhase(task, 'done', '执行完成')
    registry.setResult(task, { state: 'ready', humanAction: '看看改动', summary: '改了三个文件', source: 'protocol' })
    const summary = registry.summaryOf(task)
    expect(summary.result).toMatchObject({ state: 'ready', humanAction: '看看改动', summary: '改了三个文件', source: 'protocol' })
    expect(summary.stage).toBe('person/review')
  })

  it('falls back to ready when a finished task said nothing', () => {
    const registry = new TaskRegistry()
    const task = registry.create({ id: 'task-1', cli: 'claude', title: '跑完了', model: 'm' })
    registry.setPhase(task, 'done', '执行完成')
    const summary = registry.summaryOf(task)
    expect(summary.result).toEqual({ state: 'ready', source: 'fallback' })
    expect(summary.stage).toBe('person/review')
  })

  it('marks an npm job as idle even when it ends ready', () => {
    const registry = new TaskRegistry()
    const job = registry.create({ id: 'npm-1', cli: 'claude', title: '安装', model: '', kind: 'npm' })
    registry.setPhase(job, 'done', '装好了')
    expect(registry.summaryOf(job).stage).toBe('idle')
  })
})
