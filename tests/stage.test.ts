import { describe, expect, it } from 'vitest'
import { RESULT_STATES, fallbackResult, needsPerson, stageOf } from '../src/stage.js'
import type { MaestroPhase, MaestroTaskResult } from '../src/wire.js'

function result(state: MaestroTaskResult['state']): MaestroTaskResult {
  return { state, source: 'protocol' }
}

describe('fallbackResult', () => {
  it('derives an honest result for every phase', () => {
    expect(fallbackResult('done')).toEqual({ state: 'ready', source: 'fallback' })
    expect(fallbackResult('failed')).toEqual({ state: 'failed', source: 'fallback' })
    expect(fallbackResult('timeout')).toEqual({ state: 'failed', source: 'fallback' })
    expect(fallbackResult('cancelled')).toEqual({ state: 'dropped', source: 'fallback' })
    expect(fallbackResult('interrupted')).toEqual({
      state: 'waiting',
      humanAction: '决定是否重新派发',
      source: 'fallback',
    })
    expect(fallbackResult('queued').state).toBe('progress')
    expect(fallbackResult('running').state).toBe('progress')
  })

  it('covers every result state the protocol allows', () => {
    expect([...RESULT_STATES]).toEqual(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped', 'unknown'])
  })
})

describe('stageOf', () => {
  const cases: Array<[MaestroPhase, MaestroTaskResult | undefined, string]> = [
    ['queued', undefined, 'working/queued'],
    ['running', undefined, 'working'],
    // 跑着的任务不等人：CLI 进程还在动，那不是此刻真的阻塞。
    ['running', result('blocked'), 'working'],
    ['interrupted', undefined, 'person/answer'],
    ['failed', undefined, 'person/failed'],
    ['timeout', undefined, 'person/failed'],
    ['done', undefined, 'person/review'],
    ['done', result('waiting'), 'person/answer'],
    ['done', result('blocked'), 'person/blocked'],
    ['done', result('failed'), 'person/failed'],
    ['done', result('ready'), 'person/review'],
    ['done', result('progress'), 'idle'],
    ['done', result('dropped'), 'idle'],
    ['done', result('unknown'), 'idle'],
    ['cancelled', undefined, 'idle'],
  ]

  for (const [phase, value, expected] of cases) {
    it(`maps ${phase}${value === undefined ? '' : ` + ${value.state}`} to ${expected}`, () => {
      expect(stageOf({ phase, result: value })).toBe(expected)
    })
  }

  it('treats only person/* as work for a human', () => {
    expect(needsPerson('person/answer')).toBe(true)
    expect(needsPerson('person/review')).toBe(true)
    expect(needsPerson('working')).toBe(false)
    expect(needsPerson('idle')).toBe(false)
  })
})
