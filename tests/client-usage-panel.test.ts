import { describe, expect, it } from 'vitest'
import { summarizeUsage, USAGE_RECENT_SHOWN } from '../src/client/usage-panel.js'
import type { CliUsageRecord, CliUsageState } from '../src/usage.js'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function record(overrides: Partial<CliUsageRecord> & Pick<CliUsageRecord, 'taskId' | 'cli'>): CliUsageRecord {
  return {
    model: 'm1',
    phase: 'done',
    sessionId: 's1',
    startedAt: NOW - DAY,
    endedAt: NOW - DAY + 5_000,
    durationMs: 5_000,
    exitCode: 0,
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 10,
    cacheWriteTokens: 5,
    ...overrides,
  }
}

function state(records: CliUsageRecord[]): CliUsageState {
  return {
    totals: {
      requests: records.length,
      inputTokens: records.reduce((sum, entry) => sum + entry.inputTokens, 0),
      outputTokens: records.reduce((sum, entry) => sum + entry.outputTokens, 0),
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      durationMs: records.reduce((sum, entry) => sum + entry.durationMs, 0),
    },
    recent: records,
  }
}

describe('summarizeUsage', () => {
  it('returns a stable zero summary without data', () => {
    const empty = summarizeUsage([], NOW)
    expect(empty.requests).toBe(0)
    expect(empty.recent).toEqual([])
    expect(empty.perCli.claude.requests).toBe(0)
    // 引用稳定：空态不触发多余的渲染。
    expect(summarizeUsage([undefined, undefined], NOW)).toEqual(empty)
  })

  it('folds requests, phases, tokens and duration across sessions', () => {
    const summary = summarizeUsage([
      state([record({ taskId: 't1', cli: 'claude', phase: 'done', durationMs: 1_000, inputTokens: 10, outputTokens: 2 })]),
      state([record({ taskId: 't2', cli: 'codex', phase: 'failed', durationMs: 3_000, inputTokens: 30, outputTokens: 4 })]),
      state([record({ taskId: 't3', cli: 'codex', phase: 'timeout' })]),
      state([record({ taskId: 't4', cli: 'codex', phase: 'cancelled' })]),
    ], NOW)
    expect(summary.requests).toBe(4)
    expect(summary.ok).toBe(1)
    expect(summary.failed).toBe(2)
    expect(summary.cancelled).toBe(1)
    expect(summary.sessions).toBe(4)
    // t1(10/2) + t2(30/4) + t3/t4 走默认(100/20)
    expect(summary.inputTokens).toBe(240)
    expect(summary.outputTokens).toBe(46)
    expect(summary.durationMs).toBe(14_000)
    expect(summary.perCli.claude.requests).toBe(1)
    expect(summary.perCli.claude.ok).toBe(1)
    expect(summary.perCli.codex.requests).toBe(3)
    expect(summary.perCli.codex.failed).toBe(2)
  })

  it('keeps only records inside the 7-day window and sorts recent newest first', () => {
    const summary = summarizeUsage([
      state([
        record({ taskId: 'old', cli: 'claude', startedAt: NOW - 8 * DAY }),
        record({ taskId: 'newest', cli: 'claude', startedAt: NOW - 1_000 }),
        record({ taskId: 'middle', cli: 'claude', startedAt: NOW - 2 * DAY }),
      ]),
    ], NOW)
    expect(summary.requests).toBe(2)
    expect(summary.recent.map(entry => entry.taskId)).toEqual(['newest', 'middle'])
    // 旧记录不计 token。
    expect(summary.inputTokens).toBe(200)
  })

  it('bounds the merged recent list to the display cap', () => {
    const records = Array.from({ length: USAGE_RECENT_SHOWN + 5 }, (_, index) =>
      record({ taskId: `t${String(index)}`, cli: index % 2 === 0 ? 'claude' : 'codex', startedAt: NOW - (index + 1) * 1_000 }))
    const summary = summarizeUsage([state(records)], NOW)
    expect(summary.recent).toHaveLength(USAGE_RECENT_SHOWN)
    expect(summary.requests).toBe(USAGE_RECENT_SHOWN + 5)
    expect(summary.recent[0]?.taskId).toBe('t0')
  })

  it('ignores malformed records instead of throwing', () => {
    const broken = { recent: [undefined, { taskId: 'x' }, null], totals: undefined } as unknown as CliUsageState
    expect(summarizeUsage([broken], NOW).requests).toBe(0)
    expect(summarizeUsage([state([record({ taskId: 'ok', durationMs: -5, inputTokens: Number.NaN })])], NOW).inputTokens).toBe(0)
  })
})
