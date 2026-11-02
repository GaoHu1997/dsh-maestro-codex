import { describe, expect, it } from 'vitest'
import { HEALTH_NAMES, HealthBoard } from '../src/health.js'

describe('HealthBoard', () => {
  it('starts silent: an unclaimed name is not a healthy entry, it is absent', () => {
    const board = new HealthBoard()
    expect(board.all()).toEqual([])
    expect(board.worst()).toBe('ok')
    const reporter = board.claim('dispatch')
    reporter.set('ok', '一切正常')
    expect(board.all().map(entry => entry.name)).toEqual(['dispatch'])
    expect(board.problems()).toEqual([])
  })

  it('refuses a second claimant with a message that names the entry', () => {
    const board = new HealthBoard()
    board.claim('effects')
    expect(() => board.claim('effects')).toThrow('健康条目 effects 已被另一处认领')
  })

  it('reports the worst level and lists only real problems', () => {
    const board = new HealthBoard()
    const dispatch = board.claim('dispatch')
    const persist = board.claim('persist')
    dispatch.set('degraded', '一次重试')
    persist.set('error', '磁盘写不进去')
    expect(board.worst()).toBe('error')
    expect(board.problems().map(entry => entry.name).sort()).toEqual(['dispatch', 'persist'])
    persist.clear()
    expect(board.worst()).toBe('degraded')
    expect(board.problems().map(entry => entry.name)).toEqual(['dispatch'])
  })

  it('orders entries by the declared name order, then newest first', () => {
    let now = 0
    const board = new HealthBoard({ now: () => now })
    const persist = board.claim('persist')
    now = 10
    const dispatch = board.claim('dispatch')
    dispatch.set('ok', '先更新')
    now = 20
    persist.set('ok', '后更新')
    expect(board.all().map(entry => entry.name)).toEqual([...HEALTH_NAMES].filter(name => name === 'dispatch' || name === 'persist'))
  })

  it('carries the human-facing impact text so a problem explains itself', () => {
    const board = new HealthBoard()
    board.claim('effects').set('error', '队列坏了')
    expect(board.all()[0]?.impact.length).toBeGreaterThan(0)
  })
})
