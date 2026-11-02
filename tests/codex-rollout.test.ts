import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findRolloutFile, parseRolloutUsageLine, startRolloutUsageTail, usageFromTotals, type RolloutUsageStats } from '../src/channels/codex-rollout.js'

const THREAD = '01a19019-1ece-7851-8c9f-7fe357ac0567'
const FIXED = new Date(2026, 9, 31, 12, 0, 0)

/** A rollout row shaped like codex 0.165 writes after each model response. */
const tokenLine = (input: number, cached: number, output: number): string => JSON.stringify({
  timestamp: '2026-10-31T03:55:39.235Z',
  ordinal: 26,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 252, total_tokens: input + output },
      last_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 252, total_tokens: input + output },
    },
  },
})

const made: string[] = []
const tempHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-rollout-'))
  made.push(dir)
  return dir
}
const wait = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('codex rollout usage', () => {
  it.each([undefined, null, NaN, Infinity, -1])('preserves inclusive raw input diagnostically when cached totals are %s', cached => {
    expect(usageFromTotals({ input_tokens: 100, output_tokens: 9, cache_write_input_tokens: 3,
      ...(cached === undefined ? {} : { cached_input_tokens: cached }),
    })).toEqual({ reportedInputTokens: 100, outputTokens: 9, cacheWriteTokens: 3, usageInputSemantics: 'includes-cache' })
  })

  it('uses only measured cache reads to normalize input and keeps cache writes independent', () => {
    expect(usageFromTotals({ input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 3 }))
      .toEqual({ inputTokens: 97, cachedInputTokens: 0, cacheWriteTokens: 3, usageInputSemantics: 'uncached' })
    expect(usageFromTotals({ input_tokens: 0, cached_input_tokens: 0 }))
      .toEqual({ inputTokens: 0, cachedInputTokens: 0, usageInputSemantics: 'uncached' })
    expect(usageFromTotals({ input_tokens: 0 })).toEqual({ reportedInputTokens: 0, usageInputSemantics: 'includes-cache' })
    expect(usageFromTotals({ cached_input_tokens: 7, cache_write_input_tokens: 3, total_tokens: 1000 }))
      .toEqual({ cachedInputTokens: 7, cacheWriteTokens: 3 })
  })

  it('splits total_token_usage into the shared stats contract', () => {
    expect(parseRolloutUsageLine(tokenLine(15316, 14592, 594))).toEqual({
      inputTokens: 724,
      usageInputSemantics: 'uncached',
      cachedInputTokens: 14592,
      outputTokens: 594,
      cacheWriteTokens: 0,
    })
  })

  it('ignores rows that carry no usage and tolerates truncated json', () => {
    expect(parseRolloutUsageLine('{"type":"session_meta","payload":{}}')).toBeUndefined()
    expect(parseRolloutUsageLine('{"type":"event_msg","payload":{"type":"item_completed"}}')).toBeUndefined()
    expect(parseRolloutUsageLine('not json at all')).toBeUndefined()
    expect(parseRolloutUsageLine('{"type":"event_msg","payload":{"type":"token_count","info":{}}}')).toBeUndefined()
    expect(usageFromTotals({ output_tokens: 12 })).toEqual({ outputTokens: 12 })
  })

  it('locates the rollout file of a thread under the local day folder', () => {
    const home = tempHome()
    const dir = join(home, 'sessions', '2026', '10', '31')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `rollout-2026-10-31T11-55-28-${THREAD}.jsonl`)
    writeFileSync(file, '')
    expect(findRolloutFile(THREAD, home, FIXED.getTime())).toBe(file)
    // A run that started before midnight keeps writing into yesterday's folder.
    const previous = join(home, 'sessions', '2026', '10', '30')
    mkdirSync(previous, { recursive: true })
    const oldFile = join(previous, `rollout-2026-10-30T23-59-00-${THREAD}.jsonl`)
    rmSync(file)
    writeFileSync(oldFile, '')
    expect(findRolloutFile(THREAD, home, FIXED.getTime())).toBe(oldFile)
    expect(findRolloutFile('ffffffff-0000-0000-0000-000000000000', home, FIXED.getTime())).toBeUndefined()
  })

  it('follows a transcript that appears and grows while the run is live', async () => {
    const home = tempHome()
    const dir = join(home, 'sessions', '2026', '10', '31')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `rollout-2026-10-31T11-55-28-${THREAD}.jsonl`)
    const seen: RolloutUsageStats[] = []
    const tail = startRolloutUsageTail({
      threadId: THREAD,
      codexHome: home,
      intervalMs: 10,
      now: () => FIXED.getTime(),
      onUsage: stats => { seen.push(stats) },
    })
    try {
      // codex creates the file right after `thread.started`: polling must wait.
      await wait(30)
      writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: {} })}\n${tokenLine(15316, 14592, 594)}\n`)
      await wait(80)
      appendFileSync(file, `${tokenLine(36220, 30464, 1134)}\n`)
      await wait(80)
      // Identical totals are deduped, so re-reading the file emits nothing new.
      await wait(60)
    } finally {
      tail.stop()
    }
    expect(seen.length).toBe(2)
    expect(seen[1]).toEqual({ inputTokens: 5756, outputTokens: 1134, cachedInputTokens: 30464, cacheWriteTokens: 0, usageInputSemantics: 'uncached' })
  })
})
