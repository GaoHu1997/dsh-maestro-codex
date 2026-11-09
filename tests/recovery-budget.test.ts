import { describe, expect, it, vi } from 'vitest'
import { createRecoveryBudget } from '../src/recovery-budget.js'

describe('createRecoveryBudget', () => {
  it('starts one deadline on the first reconnect diagnostic', async () => {
    vi.useFakeTimers()
    try {
      const expires = vi.fn()
      const budget = createRecoveryBudget(new AbortController().signal, 1_000, expires)
      budget.observeDiagnostic('Reconnecting... waiting for network (Connection failed: error sending request)')
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(999)
      expect(budget.timedOut).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(budget.timedOut).toBe(true)
      expect(expires).toHaveBeenCalledTimes(1)
      expect(budget.signal.aborted).toBe(true)
      expect((budget.signal.reason as Error).message).toContain('持续重连超过恢复期限')
      budget.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not extend the deadline on repeated diagnostics', async () => {
    vi.useFakeTimers()
    try {
      const budget = createRecoveryBudget(new AbortController().signal, 1_000)
      budget.observeDiagnostic('Retrying... network error')
      await vi.advanceTimersByTimeAsync(600)
      budget.observeDiagnostic('Retrying... network error')
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(400)
      expect(budget.timedOut).toBe(true)
      budget.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the budget when a real protocol frame arrives', async () => {
    vi.useFakeTimers()
    try {
      const budget = createRecoveryBudget(new AbortController().signal, 1_000)
      budget.observeDiagnostic('socket hang up')
      await vi.advanceTimersByTimeAsync(500)
      budget.markProgress()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(budget.timedOut).toBe(false)
      // A later outage gets a fresh, full window.
      budget.observeDiagnostic('connection reset')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(budget.timedOut).toBe(true)
      budget.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores lines that are not recovery diagnostics', async () => {
    vi.useFakeTimers()
    try {
      const budget = createRecoveryBudget(new AbortController().signal, 1_000)
      budget.observeDiagnostic('正在读取 src/index.ts')
      budget.observeDiagnostic('')
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(budget.timedOut).toBe(false)
      budget.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels its timer when the caller aborts and never reports a timeout', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const budget = createRecoveryBudget(controller.signal, 1_000)
      budget.observeDiagnostic('Reconnecting...')
      controller.abort(new Error('用户取消'))
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(budget.timedOut).toBe(false)
      expect(budget.signal.aborted).toBe(true)
      budget.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
