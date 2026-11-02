import { describe, expect, it } from 'vitest'
import { DEDUPE_WINDOW_MS, DedupeGuard, DuplicateDispatchError, dedupeKeyOf } from '../src/dedupe.js'

const identity = { parentSessionId: 'session-1', cli: 'claude', taskName: '改个 typo', cwd: 'C:/repo' }

describe('dedupeKeyOf', () => {
  it('derives a stable key from the identity fields', () => {
    expect(dedupeKeyOf(identity)).toBe(dedupeKeyOf({ ...identity }))
    expect(dedupeKeyOf(identity)).not.toBe(dedupeKeyOf({ ...identity, cli: 'codex' }))
  })

  it('lets an explicit key win verbatim', () => {
    expect(dedupeKeyOf(identity, 'release-42')).toBe('explicit:release-42')
    expect(dedupeKeyOf(identity, '   ')).toBe(dedupeKeyOf(identity))
  })
})

describe('DedupeGuard', () => {
  it('rejects the same key inside the window and names the remaining time', () => {
    let now = 0
    const guard = new DedupeGuard({ now: () => now })
    guard.claim('k')
    expect(() => guard.claim('k')).toThrow(DuplicateDispatchError)
    try {
      guard.claim('k')
    } catch (error) {
      expect((error as DuplicateDispatchError).remainingMs).toBe(DEDUPE_WINDOW_MS)
      expect((error as Error).message).toContain('已经派发过一次')
    }
    now = DEDUPE_WINDOW_MS
    expect(() => guard.claim('k')).not.toThrow()
  })

  it('lets a failed dispatch release its window immediately', () => {
    const guard = new DedupeGuard()
    guard.claim('k')
    expect(guard.has('k')).toBe(true)
    guard.release('k')
    expect(guard.has('k')).toBe(false)
    expect(() => guard.claim('k')).not.toThrow()
  })

  it('keeps the map bounded by evicting expired entries first', () => {
    let now = 0
    const guard = new DedupeGuard({ now: () => now, cap: 2 })
    guard.claim('a')
    now += 1
    guard.claim('b')
    now += 1
    guard.claim('c')
    expect(guard.size()).toBeLessThanOrEqual(2)
  })
})
