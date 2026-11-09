import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCodexTask } from '../src/channels/codex.js'
import { scriptedSpawn } from './fake-child.js'

function start() {
  const cli = scriptedSpawn(() => {})
  const controller = new AbortController()
  const events: string[] = []
  const result = runCodexTask({
    spawnFn: cli.spawnFn, codexPath: 'fake-codex', task: 'task', cwd: undefined,
    model: '', sandbox: 'workspace-write', baseUrl: '', apiKey: '', timeoutMs: 1000,
    signal: controller.signal, onEvent: (_kind, text) => { events.push(text) },
  })
  const child = cli.launches[0]!
  const frame = (value: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'))
  const reconnect = () => frame({ type: 'error', message: 'Reconnecting... waiting for network (Connection failed: error sending request)' })
  const complete = () => child.finish([
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n'))
  return { child, result, controller, events, frame, reconnect, complete }
}

afterEach(() => { vi.useRealTimers() })

describe('Codex reconnect deadline', () => {
  it('ends repeated reconnects despite unrelated stderr, whitespace and unknown frames', async () => {
    vi.useFakeTimers()
    const run = start()
    run.reconnect()
    await vi.advanceTimersByTimeAsync(600)
    run.reconnect()
    run.child.stderr.emit('data', Buffer.from('diagnostic\n'))
    run.child.stdout.emit('data', Buffer.from(' \n{}\n{"type":"future.heartbeat"}\n'))
    await vi.advanceTimersByTimeAsync(400)
    const result = await run.result
    expect(result).toMatchObject({ ok: false, stats: { timedOut: true, reconnectTimedOut: true } })
    expect(result.error).toContain('持续重连 1 秒仍未恢复')
    expect(result.error).not.toContain('连续无 stdout/stderr 输出 1 秒超时')
    expect(run.controller.signal.aborted).toBe(false)
    expect(run.child.killed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['stdout', 'stderr'] as const)('also detects unstructured reconnect diagnostics on %s', async stream => {
    vi.useFakeTimers()
    const run = start()
    run.child[stream].emit('data', Buffer.from('Reconnecting... 1/5 (connection failed)\n'))
    await vi.advanceTimersByTimeAsync(600)
    run.child[stream].emit('data', Buffer.from('Reconnecting... 2/5 (connection failed)\n'))
    await vi.advanceTimersByTimeAsync(400)
    expect(await run.result).toMatchObject({ ok: false, stats: { timedOut: true, reconnectTimedOut: true } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the recovery deadline on real progress and grants a new budget to a later outage', async () => {
    vi.useFakeTimers()
    const run = start()
    run.reconnect()
    await vi.advanceTimersByTimeAsync(600)
    run.frame({ type: 'item.started', item: { type: 'command_execution', command: 'git status' } })
    await vi.advanceTimersByTimeAsync(600)
    expect(run.child.killed).toBe(false)
    run.reconnect()
    await vi.advanceTimersByTimeAsync(600)
    run.reconnect()
    await vi.advanceTimersByTimeAsync(400)
    expect(await run.result).toMatchObject({ ok: false, stats: { reconnectTimedOut: true } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('can recover to a successful completed turn', async () => {
    vi.useFakeTimers()
    const run = start()
    run.reconnect()
    await vi.advanceTimersByTimeAsync(600)
    run.complete()
    await vi.advanceTimersByTimeAsync(0)
    expect(await run.result).toMatchObject({ ok: true, finalText: 'done' })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(run.child.killed).toBe(false)
  })

  it('still permits productive runs beyond multiple total deadlines', async () => {
    vi.useFakeTimers()
    const run = start()
    for (let index = 0; index < 5; index += 1) {
      await vi.advanceTimersByTimeAsync(700)
      run.frame({ type: 'item.updated', item: { type: 'reasoning', text: 'working' } })
      expect(run.child.killed).toBe(false)
    }
    run.complete()
    await vi.advanceTimersByTimeAsync(0)
    expect(await run.result).toMatchObject({ ok: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps cancellation distinct while waiting for a child that never closes', async () => {
    vi.useFakeTimers()
    const run = start()
    run.child.kill = vi.fn(() => false)
    run.reconnect()
    await vi.advanceTimersByTimeAsync(600)
    run.controller.abort()
    await vi.advanceTimersByTimeAsync(6000)
    const result = await run.result
    expect(result.ok).toBe(false)
    expect(result.stats['timedOut']).toBeUndefined()
    expect(result.stats['reconnectTimedOut']).toBeUndefined()
    expect(result.error).toContain('任务已取消')
    expect(run.events.filter(text => text.includes('持续重连 1 秒仍未恢复'))).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears its recovery timer on caller cancellation', async () => {
    vi.useFakeTimers()
    const run = start()
    run.reconnect()
    run.controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    const result = await run.result
    expect(result.ok).toBe(false)
    expect(result.stats['timedOut']).toBeUndefined()
    expect(result.error).toContain('任务已取消')
    expect(vi.getTimerCount()).toBe(0)
  })
})
