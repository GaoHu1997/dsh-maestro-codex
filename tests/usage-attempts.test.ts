import { describe, expect, it } from 'vitest'
import { accumulateAttemptStats } from '../src/dispatch.js'
import { tokenUsageOfStats } from '../src/wire.js'

const complete = { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, cacheWriteTokens: 0 }
const buckets = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens'] as const

describe('actual attempt settlement completeness', () => {
  it('sums two complete attempts without marking their buckets unknown', () => {
    const first = accumulateAttemptStats(undefined, complete)
    const second = accumulateAttemptStats(first, complete)
    expect(second).toMatchObject({ usageAttempts: 2, inputTokens: 20, outputTokens: 8, cachedInputTokens: 4, cacheWriteTokens: 0 })
    expect(buckets.some(key => second?.[`usagePartial_${key}`] === true)).toBe(false)
    expect(tokenUsageOfStats(second)).toEqual({ uncachedInputTokens: 20, outputTokens: 8, cacheReadTokens: 4, cacheWriteTokens: 0 })
  })
  it('keeps known subtotals but does not present a later missing attempt as complete', () => {
    const second = accumulateAttemptStats(accumulateAttemptStats(undefined, complete), undefined)
    expect(second?.inputTokens).toBe(10)
    expect(second?.usageAttempts).toBe(2)
    for (const key of buckets) expect(second?.[`usagePartial_${key}`]).toBe(true)
    expect(tokenUsageOfStats(second)).toBeUndefined()
  })
  it('remembers a missing first attempt even when a later retry provides counters', () => {
    const second = accumulateAttemptStats(accumulateAttemptStats(undefined, undefined), complete)
    expect(second?.inputTokens).toBe(10)
    for (const key of buckets) expect(second?.[`usagePartial_${key}`]).toBe(true)
    expect(tokenUsageOfStats(second)).toBeUndefined()
  })
  it('preserves measured zero and never rounds a missing cache bucket down to zero', () => {
    expect(tokenUsageOfStats({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 })).toEqual({
      uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    })
    expect(tokenUsageOfStats({ inputTokens: 1, outputTokens: 1 })).toBeUndefined()
  })
  it('rejects negative, NaN and infinite observations instead of adding them to valid subtotals', () => {
    for (const value of [-1, NaN, Infinity]) {
      const second = accumulateAttemptStats(accumulateAttemptStats(undefined, complete), { ...complete, inputTokens: value })
      expect(second?.inputTokens).toBe(10)
      expect(second?.usagePartial_inputTokens).toBe(true)
      expect(tokenUsageOfStats(second)).toBeUndefined()
    }
  })
})
