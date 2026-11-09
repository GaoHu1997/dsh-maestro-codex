import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROCESS_CLOSE_GRACE_MS, PROCESS_STOP_GRACE_MS, runProcess } from '../src/spawn.js'
import { runPrepare } from '../src/prepare.js'
import { scriptedSpawn } from './fake-child.js'

function launch(ignoreKill = false, onStdoutLine = vi.fn()) {
  const cli = scriptedSpawn(child => {
    if (ignoreKill) child.kill = vi.fn(() => false)
  })
  const controller = new AbortController()
  const { outcome } = runProcess({
    spawnFn: cli.spawnFn, file: 'fake', args: [], timeoutMs: 1000,
    timeoutMode: 'idle', signal: controller.signal, onStdoutLine,
  })
  return { child: cli.launches[0]!, outcome, controller, onStdoutLine }
}

afterEach(() => { vi.useRealTimers() })

describe('process close bounds', () => {
  it('settles a timeout even when termination never produces close', async () => {
    vi.useFakeTimers()
    const run = launch(true)
    await vi.advanceTimersByTimeAsync(1000)
    run.child.stdout.emit('data', Buffer.from('late data'))
    await vi.advanceTimersByTimeAsync(PROCESS_STOP_GRACE_MS)
    expect(await run.outcome).toMatchObject({ code: null, timedOut: true, stderrTail: expect.stringContaining('未收到子进程 close') })
    expect(run.onStdoutLine).toHaveBeenCalledExactlyOnceWith('late data')
    expect(run.child.kill).toHaveBeenLastCalledWith('SIGKILL')
    expect(vi.getTimerCount()).toBe(0)
    const calls = run.onStdoutLine.mock.calls.length
    run.child.stdout.emit('data', Buffer.from('ignored\n'))
    run.child.emit('error', new Error('late error'))
    run.child.emit('close', 0, null)
    expect(run.onStdoutLine).toHaveBeenCalledTimes(calls)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles cancellation without mislabelling it as a timeout', async () => {
    vi.useFakeTimers()
    const run = launch(true)
    run.controller.abort()
    await vi.advanceTimersByTimeAsync(PROCESS_STOP_GRACE_MS)
    expect(await run.outcome).toMatchObject({ code: null, timedOut: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds inherited pipes after exit, preserves a pending UTF-8 line, and does not report success', async () => {
    vi.useFakeTimers()
    const run = launch()
    run.child.exitCode = 0
    run.child.emit('exit', 0, null)
    const text = Buffer.from('最终答复')
    run.child.stdout.emit('data', text.subarray(0, text.length - 1))
    await vi.advanceTimersByTimeAsync(PROCESS_CLOSE_GRACE_MS - 1)
    run.child.stdout.emit('data', text.subarray(text.length - 1))
    await vi.advanceTimersByTimeAsync(1)
    expect(await run.outcome).toMatchObject({ code: null, timedOut: false, stderrTail: expect.stringContaining('输出完整性未确认') })
    expect(run.onStdoutLine).toHaveBeenCalledExactlyOnceWith('最终答复')
    expect(run.child.killed).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a final line delivered between exit and close', async () => {
    vi.useFakeTimers()
    const run = launch()
    run.child.exitCode = 0
    run.child.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(200)
    run.child.stdout.emit('data', Buffer.from('{"answer":"done"}'))
    run.child.emit('close', 0, null)
    expect(await run.outcome).toMatchObject({ code: 0, timedOut: false })
    expect(run.onStdoutLine).toHaveBeenCalledExactlyOnceWith('{"answer":"done"}')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not extend termination grace when exit arrives after cancellation', async () => {
    vi.useFakeTimers()
    const run = launch(true)
    run.controller.abort()
    await vi.advanceTimersByTimeAsync(PROCESS_STOP_GRACE_MS - 1)
    run.child.exitCode = 0
    run.child.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(1)
    expect(await run.outcome).toMatchObject({ code: null, timedOut: false })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('prepare close bounds', () => {
  it.each(['timeout', 'abort'] as const)('settles after %s without close', async reason => {
    vi.useFakeTimers()
    const cli = scriptedSpawn(child => { child.kill = vi.fn(() => false) })
    const controller = new AbortController()
    const result = runPrepare('fake', { cwd: process.cwd(), spawnFn: cli.spawnFn, timeoutMs: 1000, signal: controller.signal })
    if (reason === 'abort') controller.abort()
    else await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(PROCESS_STOP_GRACE_MS)
    expect(await result).toMatchObject({ ok: false, code: null, timedOut: reason === 'timeout', output: expect.stringContaining('未收到子进程 close') })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds drain after an exited prepare wrapper without close', async () => {
    vi.useFakeTimers()
    const cli = scriptedSpawn(() => {})
    const result = runPrepare('fake', { cwd: process.cwd(), spawnFn: cli.spawnFn, timeoutMs: 1000 })
    const child = cli.launches[0]!
    child.exitCode = 0
    child.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(PROCESS_CLOSE_GRACE_MS)
    expect(await result).toMatchObject({ ok: false, code: null, timedOut: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not spawn an already cancelled prepare command', async () => {
    const cli = scriptedSpawn(() => {})
    const controller = new AbortController()
    controller.abort()
    expect(await runPrepare('fake', { cwd: process.cwd(), spawnFn: cli.spawnFn, signal: controller.signal })).toMatchObject({ ok: false, timedOut: false })
    expect(cli.launches).toHaveLength(0)
  })
})
