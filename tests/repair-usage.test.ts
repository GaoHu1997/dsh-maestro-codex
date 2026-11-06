import { afterEach, describe, expect, it, vi } from 'vitest'
import { summarizeUsage, usageTokenLabel } from '../src/client/usage-panel.js'
import type { CliUsageRecord, CliUsageState } from '../src/usage.js'

const now = new Date(2026, 10, 5, 12).getTime()
const row = (value: Partial<CliUsageRecord> = {}): CliUsageRecord => ({ taskId: 't', cli: 'codex', model: '', phase: 'done', startedAt: now - 1000, endedAt: now, durationMs: 1000, inputTokens: 7, outputTokens: 11, cachedInputTokens: 13, cacheWriteTokens: 17, ...value })
const state = (recent: CliUsageRecord[]): CliUsageState => ({ recent, totals: { requests: 999, inputTokens: 999, outputTokens: 999, cachedInputTokens: 999, cacheWriteTokens: 999, durationMs: 999 } })
afterEach(() => vi.unstubAllEnvs())
describe('修复：用量四桶与窗口合同', () => {
  it('保留未知和部分已知下限，已知零仍为零，四桶不相加', () => {
    const records = [row({ inputTokens: null, knownTokens: { inputTokens: 123 }, outputTokens: 0, cachedInputTokens: null, cacheWriteTokens: null }), row({ outputTokens: 0 })]
    const summary = summarizeUsage([state(records)], now)
    expect(summary.inputTokens).toBeNull()
    expect(summary.knownTokens.inputTokens).toBe(130)
    expect(summary.outputTokens).toBe(0)
    expect(summary.cachedInputTokens).toBeNull()
    expect(summary.knownTokens.cachedInputTokens).toBe(13)
    expect(summary.cacheWriteTokens).toBeNull()
    expect(summary.knownTokens.cacheWriteTokens).toBe(17)
    expect(summary.perCli.codex.knownTokens).toEqual(summary.knownTokens)
    expect(summary.perCli.codex.inputTokens).toBeNull()
    expect(usageTokenLabel(null, 123)).toContain('至少 123')
    expect(usageTokenLabel(null, 0)).toBe('未知')
    expect(usageTokenLabel(0, 0)).toBe('0')
  })
  it('四桶已知计数分别保留', () => {
    const result = summarizeUsage([state([row()])], now)
    expect([result.inputTokens, result.outputTokens, result.cachedInputTokens, result.cacheWriteTokens]).toEqual([7, 11, 13, 17])
    expect(result.perCli.codex).toMatchObject({ inputTokens: 7, outputTokens: 11, cachedInputTokens: 13, cacheWriteTokens: 17 })
  })
  it('拒绝未来与非有限日期，包含now，不从累计totals制造日期数据', () => {
    const result = summarizeUsage([state([row({ startedAt: now }), row({ startedAt: now + 1 }), row({ startedAt: Infinity }), row({ startedAt: NaN })])], now)
    expect(result.requests).toBe(1)
    expect(result.daily.reduce((sum, d) => sum + d.requests, 0)).toBe(1)
    expect(result.inputTokens).toBe(7)
  })
  it.each(['America/New_York', 'Asia/Shanghai'])('%s按日历回退，summary与daily使用同一集合', timezone => {
    vi.stubEnv('TZ', timezone)
    const end = new Date(2026, 10, 5, 12).getTime()
    const first = new Date(2026, 9, 30, 0).getTime()
    const recent = Array.from({ length: 7 }, (_, i) => row({ taskId: String(i), startedAt: new Date(2026, 9, 30 + i, 12).getTime() }))
    const result = summarizeUsage([state([...recent, row({ startedAt: first - 1 }), row({ startedAt: end + 1 })])], end)
    expect(result.requests).toBe(7)
    expect(result.daily).toHaveLength(7)
    expect(result.daily.reduce((s, d) => s + d.requests, 0)).toBe(result.requests)
    expect(result.daily.every(d => new Date(d.day).getHours() === 0)).toBe(true)
    expect(result.daily[0]?.day).toBe(first)
    if (timezone === 'America/New_York') expect(result.daily[3]!.day - result.daily[2]!.day).toBe(25 * 3600000)
  })
})
