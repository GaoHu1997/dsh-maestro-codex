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

  it('records terminal phases with an end timestamp; only failures carry an error', () => {
    const registry = new TaskRegistry()
    const task = newTask(registry)
    registry.setPhase(task, 'done', '执行完成')
    expect(task.phase).toBe('done')
    expect(task.endedAt).toBeGreaterThan(0)
    // `error` 是失败原因：成功/取消的标签只留在事件流里，否则 UI 会给每个
    // 成功任务渲染红色错误横幅。
    expect(task.error).toBeUndefined()
    expect(task.events.some(event => event.text === '执行完成')).toBe(true)
    registry.setPhase(task, 'failed', '进程退出码 1')
    expect(task.error).toBe('进程退出码 1')
    expect(task.phase).toBe('failed')
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

  it('scopes list() by owner session and keeps owner-less tasks', () => {
    const registry = new TaskRegistry()
    registry.create({ id: 'own', cli: 'claude', title: 'own', model: '', sessionId: 's1' })
    registry.create({ id: 'other', cli: 'claude', title: 'other', model: '', sessionId: 's2' })
    registry.create({ id: 'npm', cli: 'claude', title: 'npm', model: '' })
    const ids = (sessions?: ReadonlySet<string>): string[] => registry.list(sessions).map(summary => summary.id).sort()
    expect(ids()).toEqual(['npm', 'other', 'own'])
    expect(ids(new Set(['s1']))).toEqual(['npm', 'own'])
    expect(ids(new Set(['s2']))).toEqual(['npm', 'other'])
    // 不依赖渲染顺序：summary 里带上 owner，前端才能区分来源。
    expect(registry.list().find(summary => summary.id === 'own')?.sessionId).toBe('s1')
    expect(registry.list().find(summary => summary.id === 'npm')?.sessionId).toBeUndefined()
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

  it('starts queued tasks when the limit rises without a new acquire', async () => {
    // 配置页把并发数调大时，排队中的任务必须被放行——不能等某次 release。
    let limit = 1
    const limiter = new Limiter(() => limit)
    const first = limiter.acquire(new AbortController().signal)
    await first.waited
    const second = limiter.acquire(new AbortController().signal)
    let secondStarted = false
    void second.waited.then(() => { secondStarted = true })
    limit = 2
    await new Promise(resolve => { setTimeout(resolve, 400) })
    expect(secondStarted).toBe(true)
    first.release()
    second.release()
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

describe('TaskRegistry.restore', () => {
  it('seeds a finished task from a persisted record with its event tail', () => {
    const registry = new TaskRegistry()
    const restored = registry.restore({
      id: 'task-persisted',
      cli: 'codex',
      title: '历史任务',
      model: 'm1',
      sessionId: 's1',
      phase: 'done',
      startedAt: 1_000,
      endedAt: 9_000,
      exitCode: 0,
      finalText: '结论',
      stats: { outputTokens: 3 },
      events: [
        { seq: 1, at: 1_100, kind: 'phase' as const, text: '已创建' },
        { seq: 2, at: 9_000, kind: 'text' as const, text: '结论' },
      ],
    })
    expect(restored?.phase).toBe('done')
    const summary = registry.list()[0]
    expect(summary).toMatchObject({ id: 'task-persisted', durationMs: 8_000, sessionId: 's1' })
    expect(registry.eventsSince('task-persisted', 0)?.events).toHaveLength(2)
  })

  it('rejects live phases, duplicate ids and malformed events', () => {
    const registry = new TaskRegistry()
    expect(registry.restore({
      id: 'task-live', cli: 'claude', title: 't', phase: 'running', startedAt: 1,
    })).toBeUndefined()
    const first = registry.restore({
      id: 'task-dup', cli: 'claude', title: 't', phase: 'done', startedAt: 1, events: [{ seq: 1, at: 1, kind: 'phase' as const, text: 'a' }],
    })
    expect(first).toBeDefined()
    expect(registry.restore({
      id: 'task-dup', cli: 'claude', title: 't', phase: 'failed', startedAt: 2,
    })).toBeUndefined()
    // 坏事件行被跳过，任务本身仍然进表。
    expect(registry.restore({
      id: 'task-badevents', cli: 'claude', title: 't', phase: 'failed', startedAt: 3,
      events: [undefined, { seq: 1, at: 1, kind: 'phase' as const, text: 'ok' }, { seq: 'x', at: 1, kind: 'phase' as const, text: 'bad' }],
    } as never)).toBeDefined()
    expect(registry.eventsSince('task-badevents', 0)?.events).toHaveLength(1) // 只回放那 1 条干净事件
  })

  it('carries the truncated flag from the persisted record', () => {
    const registry = new TaskRegistry()
    registry.restore({
      id: 'task-truncated', cli: 'claude', title: 't', phase: 'done', startedAt: 1, truncated: true,
      events: [{ seq: 1, at: 1, kind: 'phase' as const, text: 'a' }],
    })
    expect(registry.list()[0]?.truncated).toBe(true)
  })

  it('keeps original event timestamps instead of resetting them to boot time', () => {
    const registry = new TaskRegistry()
    const at = 1_700_000_000_000
    registry.restore({
      id: 'task-old', cli: 'claude', title: '历史', phase: 'done', startedAt: at, endedAt: at + 5,
      events: [{ seq: 1, at, kind: 'text' as const, text: '历史行' }],
    })
    const event = registry.eventsSince('task-old', 0)?.events[0]
    expect(event?.at).toBe(at)
  })

  it('skips events with unknown kinds or non-integer seqs and still advances the cursor', () => {
    const registry = new TaskRegistry()
    registry.restore({
      id: 'task-corrupt', cli: 'claude', title: 't', phase: 'done', startedAt: 10,
      events: [
        { seq: 1, at: 11, kind: 'phase' as const, text: 'ok' },
        { seq: 4, at: 12, kind: 'bogus' as never, text: '坏 kind' },
        { seq: 1.5, at: 13, kind: 'text' as const, text: '坏 seq' },
        { seq: 5, at: 14, kind: 'text' as const, text: '跳跃 seq' },
      ],
    })
    const page = registry.eventsSince('task-corrupt', 0)
    expect(page?.events.map(event => event.seq)).toEqual([1, 5])
    // 游标越过不连续的 seq，续读才不会重复投递。
    expect(page?.nextCursor).toBe(5)
    expect(registry.eventsSince('task-corrupt', 5)?.events).toEqual([])
  })
})
