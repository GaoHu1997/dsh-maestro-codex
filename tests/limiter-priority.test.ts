import { afterEach, describe, expect, it, vi } from 'vitest'
import { Limiter } from '../src/task-registry.js'

function grantPromise(limiter: Limiter, priority: 'normal' | 'human' = 'normal'): { ready: Promise<void>; release: () => void; settled: () => boolean } {
  let done = false
  const controller = new AbortController()
  const { waited, release } = limiter.acquire(controller.signal, { priority })
  const ready = waited.then(() => { done = true })
  return { ready, release, settled: () => done }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Limiter', () => {
  it('caps normal dispatches at the configured concurrency', async () => {
    const limiter = new Limiter(() => 2)
    const first = grantPromise(limiter)
    const second = grantPromise(limiter)
    await Promise.all([first.ready, second.ready])
    expect(limiter.activeCount()).toBe(2)
    const third = grantPromise(limiter)
    await flush()
    expect(third.settled()).toBe(false)
    expect(limiter.waitingCount()).toBe(1)
    first.release()
    await third.ready
    expect(limiter.activeCount()).toBe(2)
    second.release()
    third.release()
  })

  it('lets a human message take the single overflow slot when the machine is full', async () => {
    const limiter = new Limiter(() => 1)
    const machine = grantPromise(limiter)
    await machine.ready
    const human = grantPromise(limiter, 'human')
    await human.ready
    expect(limiter.activeCount()).toBe(2)
    // 溢出只有一个槽：第二个人也只能排队。
    const secondHuman = grantPromise(limiter, 'human')
    await flush()
    expect(secondHuman.settled()).toBe(false)
    human.release()
    await secondHuman.ready
    machine.release()
    secondHuman.release()
    expect(limiter.activeCount()).toBe(0)
  })

  it('never lets a normal dispatch jump ahead of a queued human', async () => {
    const limiter = new Limiter(() => 1)
    const running = grantPromise(limiter)
    await running.ready
    const normal = grantPromise(limiter)
    const human = grantPromise(limiter, 'human')
    await flush()
    running.release()
    await human.ready
    await flush()
    expect(normal.settled()).toBe(false)
    human.release()
    await normal.ready
    normal.release()
    expect(limiter.activeCount()).toBe(0)
  })

  it('drops an aborted waiter instead of starting it later', async () => {
    const limiter = new Limiter(() => 1)
    const running = grantPromise(limiter)
    await running.ready
    const controller = new AbortController()
    const waited = limiter.acquire(controller.signal).waited
    expect(limiter.waitingCount()).toBe(1)
    controller.abort(new Error('用户取消了'))
    await expect(waited).rejects.toThrow('用户取消了')
    expect(limiter.waitingCount()).toBe(0)
    running.release()
    expect(limiter.activeCount()).toBe(0)
  })

  it('picks up a raised limit while someone is queued', async () => {
    vi.useFakeTimers()
    let capacity = 1
    const limiter = new Limiter(() => capacity)
    const running = grantPromise(limiter)
    await running.ready
    const waiting = grantPromise(limiter)
    await flush()
    expect(waiting.settled()).toBe(false)
    capacity = 2
    await vi.advanceTimersByTimeAsync(1_000)
    expect(waiting.settled()).toBe(true)
    running.release()
    waiting.release()
  })
})
