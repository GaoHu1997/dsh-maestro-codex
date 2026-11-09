import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { SHIM_KILL_GRACE_MS, superviseMcpChild } from '../src/mcp-env-shim.js'

/** Minimal child-process surface: records kill() calls and emits lifecycle events. */
class FakeMcpChild extends EventEmitter {
  readonly kills: Array<NodeJS.Signals | number | undefined> = []
  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal)
    return true
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('superviseMcpChild', () => {
  it('forwards SIGTERM and escalates to SIGKILL after the grace period', async () => {
    vi.useFakeTimers()
    const signals = new EventEmitter()
    const child = new FakeMcpChild()
    superviseMcpChild(child as never, { signals, graceMs: 1_000, exit: () => {} })

    signals.emit('SIGTERM')
    expect(child.kills).toEqual(['SIGTERM'])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])

    // A repeated signal must not start a second escalation.
    signals.emit('SIGINT')
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('uses a five-second default grace', () => {
    expect(SHIM_KILL_GRACE_MS).toBe(5_000)
  })

  it('exits with the child exit code and clears a pending escalation', async () => {
    vi.useFakeTimers()
    const signals = new EventEmitter()
    const exits: number[] = []
    const child = new FakeMcpChild()
    superviseMcpChild(child as never, { signals, graceMs: 1_000, exit: (code) => exits.push(code) })

    signals.emit('SIGTERM')
    child.emit('exit', 7, null)
    expect(exits).toEqual([7])

    // The escalation timer was cleared: no SIGKILL after the child is gone.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(child.kills).toEqual(['SIGTERM'])
  })

  it('reports a null exit code as failure', () => {
    const child = new FakeMcpChild()
    const exits: number[] = []
    superviseMcpChild(child as never, { signals: new EventEmitter(), exit: (code) => exits.push(code) })
    child.emit('exit', null, 'SIGTERM')
    expect(exits).toEqual([1])
  })

  it('exits 1 and reports a spawn error', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const child = new FakeMcpChild()
    const exits: number[] = []
    superviseMcpChild(child as never, { signals: new EventEmitter(), exit: (code) => exits.push(code) })

    child.emit('error', new Error('ENOENT'))
    expect(exits).toEqual([1])
    expect(String(stderr.mock.calls[0]?.[0])).toContain('MCP command failed to start')
  })
})
