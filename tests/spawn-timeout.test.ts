import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../src/spawn.js'
import { scriptedSpawn } from './fake-child.js'

function watchdog(timeoutMode?: 'idle' | 'wall-clock', warning = vi.fn()) {
  const cli = scriptedSpawn(child => {
    // Avoid taskkill against a synthetic pid on Windows.
    child.pid = undefined as unknown as number
  })
  const controller = new AbortController()
  const run = runProcess({
    spawnFn: cli.spawnFn, file: 'fake', args: [], timeoutMs: 1000,
    ...(timeoutMode === undefined ? {} : { timeoutMode }),
    timeoutWarningLeadMs: 200, onTimeoutWarning: warning, signal: controller.signal,
  })
  return { ...run, child: cli.launches[0]!, controller, warning }
}

afterEach(() => { vi.useRealTimers() })

describe('process timeout clocks', () => {
  it('keeps the default wall-clock deadline despite output', async () => {
    vi.useFakeTimers()
    const run = watchdog()
    await vi.advanceTimersByTimeAsync(600)
    run.child.stdout.emit('data', Buffer.from('active'))
    await vi.advanceTimersByTimeAsync(400)
    expect(run.child.killed).toBe(true)
    expect((await run.outcome).timedOut).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows actual output to continue across multiple total deadlines', async () => {
    vi.useFakeTimers()
    const run = watchdog('idle')
    for (let index = 0; index < 5; index += 1) {
      await vi.advanceTimersByTimeAsync(700)
      run.child.stdout.emit('data', Buffer.from('partial JSON'))
      expect(run.child.killed).toBe(false)
    }
    run.child.finish('', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect((await run.outcome).timedOut).toBe(false)
    expect(run.warning).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('kills at the idle deadline and warns once without faking activity', async () => {
    vi.useFakeTimers()
    const run = watchdog('idle')
    await vi.advanceTimersByTimeAsync(800)
    expect(run.warning).toHaveBeenCalledExactlyOnceWith(200)
    expect(run.child.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect((await run.outcome).timedOut).toBe(true)
    expect(run.child.killed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['stdout', 'stderr'] as const)('resets on %s partial/whitespace chunks, not empty chunks', async stream => {
    vi.useFakeTimers()
    const run = watchdog('idle')
    await vi.advanceTimersByTimeAsync(800)
    expect(run.warning).toHaveBeenCalledTimes(1)
    run.child[stream].emit('data', Buffer.from(' \r'))
    await vi.advanceTimersByTimeAsync(799)
    expect(run.child.killed).toBe(false)
    expect(run.warning).toHaveBeenCalledTimes(1)
    run.child[stream].emit('data', Buffer.alloc(0))
    await vi.advanceTimersByTimeAsync(1)
    expect(run.warning).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(200)
    expect((await run.outcome).timedOut).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['idle', 'wall-clock'] as const)('aborts immediately and clears %s timers', async mode => {
    vi.useFakeTimers()
    const run = watchdog(mode)
    run.controller.abort()
    expect(run.child.killed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    run.child.stderr.emit('data', Buffer.from('late output'))
    await vi.advanceTimersByTimeAsync(1000)
    expect((await run.outcome).timedOut).toBe(false)
    expect(run.warning).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['close', 'error'] as const)('clears timeout/warning on normal or error settlement: %s', async event => {
    vi.useFakeTimers()
    const run = watchdog('idle')
    if (event === 'error') run.child.emit('error', new Error('spawn failed'))
    else run.child.emit('close', 0, null)
    const outcome = await run.outcome
    expect(outcome.timedOut).toBe(false)
    if (event === 'error') expect(outcome.stderrTail).toContain('spawn failed')
    run.child.stdout.emit('data', Buffer.from('late output'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(run.child.killed).toBe(false)
    expect(run.warning).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
