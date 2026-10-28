import { describe, expect, it } from 'vitest'
import { Limiter, TaskRegistry, isTerminalPhase } from '../src/task-registry.js'
import type { MaestroTask } from '../src/task-registry.js'

function newTask(registry: TaskRegistry, id = 'task-1'): MaestroTask {
  return registry.create({ id, cli: 'claude', title: '示例任务', model: '' })
}

describe('TaskRegistry', () => {
  it('creates a queued task with a first event', () => {
    const registry = new TaskRegistry()
    const task = newTask(registry)
    expect(task.phase).toBe('queued')
    expect(task.events).toHaveLength(1)
    expect(task.events[0]?.seq).toBe(1)
  })

  it('streams events and answers eventsSince cursors', () => {
    const registry = new TaskRegistry()
    const task = newTask(registry)
    registry.push(task, 'text', '第一段')
    registry.push(task, 'text', '第二段')
    const page = registry.eventsSince('task-1', 1)
    expect(page?.events.map(event => event.seq)).toEqual([2, 3])
    expect(page?.nextCursor).toBe(3)
    expect(registry.eventsSince('missing', 0)).toBeUndefined()
  })

  it('caps the event ring without renumbering', () => {
    const registry = new TaskRegistry()
    const task = newTask(registry)
    for (let i = 0; i < 900; i += 1) registry.push(task, 'note', `e${i}`)
    expect(task.events.length).toBeLessThanOrEqual(800)
    expect(task.cursor).toBe(901)
    expect(task.truncated).toBe(true)
    const tail = registry.eventsSince('task-1', 0)
    expect(tail?.events.at(-1)?.text).toBe('e899')
  })

  it('records terminal phases with an end timestamp and note', () => {
    const registry = new TaskRegistry()
    const task = newTask(registry)
    registry.setPhase(task, 'done', '执行完成')
    expect(task.phase).toBe('done')
    expect(task.endedAt).toBeGreaterThan(0)
    expect(task.error).toBe('执行完成')
    expect(isTerminalPhase(task.phase)).toBe(true)
  })

  it('prunes finished tasks past the cap', () => {
    const registry = new TaskRegistry()
    for (let i = 0; i < 70; i += 1) {
      const task = newTask(registry, `task-${i}`)
      registry.setPhase(task, 'done', 'ok')
    }
    expect(registry.list().length).toBeLessThanOrEqual(60)
    expect(registry.get('task-0')).toBeUndefined()
    expect(registry.get('task-69')).toBeDefined()
  })
})

describe('Limiter', () => {
  it('admits up to the limit and queues the rest', async () => {
    const limiter = new Limiter(() => 2)
    const controller = new AbortController()
    const first = limiter.acquire(controller.signal)
    const second = limiter.acquire(controller.signal)
    await Promise.all([first.waited, second.waited])
    let thirdRunning = false
    const third = limiter.acquire(controller.signal)
    const thirdWait = third.waited.then(() => { thirdRunning = true })
    expect(thirdRunning).toBe(false)
    first.release()
    await thirdWait
    expect(thirdRunning).toBe(true)
    second.release()
    third.release()
  })

  it('rejects a queued waiter on abort without starting it', async () => {
    const limiter = new Limiter(() => 1)
    const controller = new AbortController()
    const first = limiter.acquire(controller.signal)
    await first.waited
    const secondController = new AbortController()
    const second = limiter.acquire(secondController.signal)
    const secondWait = second.waited
    secondController.abort(new Error('用户取消'))
    await expect(secondWait).rejects.toThrow('用户取消')
    // The slot is still held by the first; releasing it grants future acquires.
    first.release()
    const third = limiter.acquire(new AbortController().signal)
    await third.waited
    third.release()
  })
})
