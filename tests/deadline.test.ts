import { describe, expect, it, vi } from 'vitest'
import { awaitWithin, DeadlineError } from '../src/deadline.js'

const never = (): Promise<void> => new Promise<void>(() => { /* never settles */ })

describe('awaitWithin', () => {
  it('resolves with the work value', async () => {
    await expect(awaitWithin(async () => 'ok', { timeoutMs: 1_000 })).resolves.toBe('ok')
  })

  it('turns a synchronous throw into a rejection', async () => {
    await expect(awaitWithin(() => { throw new Error('拼装失败') }, { timeoutMs: 1_000 })).rejects.toThrow('拼装失败')
  })

  it('rejects with a DeadlineError when the work never settles', async () => {
    vi.useFakeTimers()
    try {
      const pending = awaitWithin(never, { timeoutMs: 50, label: '用量记账' })
      const caught = expect(pending).rejects.toBeInstanceOf(DeadlineError)
      await vi.advanceTimersByTimeAsync(50)
      await caught
      const error = await pending.catch((value: unknown) => value)
      expect(error).toBeInstanceOf(DeadlineError)
      expect((error as DeadlineError).timeoutMs).toBe(50)
      expect((error as Error).message).toContain('用量记账在 1 秒内没有返回')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects immediately when the caller signal is already aborted and never starts the work', async () => {
    const controller = new AbortController()
    controller.abort(new Error('用户已取消'))
    const work = vi.fn(async () => 'late')
    await expect(awaitWithin(work, { signal: controller.signal, timeoutMs: 1_000 })).rejects.toThrow('用户已取消')
    expect(work).not.toHaveBeenCalled()
  })

  it('rejects with the abort reason when cancelled while waiting', async () => {
    const controller = new AbortController()
    const pending = awaitWithin(never, { signal: controller.signal, timeoutMs: 60_000 })
    controller.abort(new Error('派发被取消'))
    await expect(pending).rejects.toThrow('派发被取消')
  })

  it('consumes a late settlement after the deadline without an unhandled rejection', async () => {
    vi.useFakeTimers()
    try {
      let settleLate: (() => void) | undefined
      const late = new Promise<string>((_resolve, reject) => {
        settleLate = () => { reject(new Error('迟到的失败')) }
      })
      const pending = awaitWithin(() => late, { timeoutMs: 10 })
      const caught = expect(pending).rejects.toBeInstanceOf(DeadlineError)
      await vi.advanceTimersByTimeAsync(10)
      await caught
      // The work rejects afterwards; the handler is already attached and drops it.
      settleLate?.()
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
