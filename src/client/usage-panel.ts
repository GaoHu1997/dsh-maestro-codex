/**
 * 用量统计（设置卡「任务监视」页）：把各会话的 `maestroCliUsage` 投影折成
 * 一个近 7 天的汇总——派发次数、成功/失败、四类 token、总耗时、按 CLI 的
 * 分布和最近几次调用。数据全部来自客户端已有的会话 feed，不加宿主路由。
 *
 * 注意口径：投影里每个会话只保留最近 20 次调用明细，所以这里的「近 7 天」
 * 受该上限约束（UI 文案里说明）。汇总函数是纯的，单测直接跑。
 *
 * @module dsh-maestro-codex/client/usage-panel
 */

import { useCallback, useSyncExternalStore } from 'react'

import type { CliUsageRecord, CliUsageState, CliKnownTokens } from '../usage.js'
import type { MaestroCliId } from '../wire.js'
import { sessionsFaceOf, type BoardSessionsFace, type BoardSessionList } from './board/data.js'

/** 近 7 天的统计窗口。 */
export const USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** 合并展示的最近调用条数。 */
export const USAGE_RECENT_SHOWN = 8

/** 一个 CLI 的 7 天分布。 */
export interface UsageCliBucket {
  readonly requests: number
  readonly ok: number
  readonly failed: number
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cachedInputTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly knownTokens: CliKnownTokens
  readonly durationMs: number
}

/** 一天的调用分布（看板柱状图用，本地时区 0 点对齐）。 */
export interface UsageDayBucket {
  /** 当天 0 点时间戳。 */
  readonly day: number
  readonly requests: number
  readonly ok: number
  readonly failed: number
}

/** 近 7 天汇总。 */
export interface UsageSummary {
  readonly requests: number
  readonly ok: number
  readonly failed: number
  readonly cancelled: number
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cachedInputTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly durationMs: number
  readonly knownTokens: CliKnownTokens
  readonly perCli: Readonly<Record<MaestroCliId, UsageCliBucket>>
  /** 合并后的最近调用（新→旧，最多 {@link USAGE_RECENT_SHOWN} 条）。 */
  readonly recent: readonly CliUsageRecord[]
  /** 有调用记录的会话数。 */
  readonly sessions: number
  /** 近 7 个自然日（本地 0 点对齐）的每日分布，旧→新。 */
  readonly daily: readonly UsageDayBucket[]
}

const EMPTY_BUCKET: UsageCliBucket = { requests: 0, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, knownTokens: {}, durationMs: 0 }

const ZERO_SUMMARY: UsageSummary = {
  requests: 0, ok: 0, failed: 0, cancelled: 0,
  inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0,
  durationMs: 0, knownTokens: {},
  perCli: { claude: EMPTY_BUCKET, codex: EMPTY_BUCKET, grok: EMPTY_BUCKET },
  recent: [],
  sessions: 0,
  daily: [],
}

function finitePositive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 本地 0 点时间戳。 */
function dayStart(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 默认窗口为今天及前六个本地自然日，截止 now；非默认 windowMs 使用滚动窗口。 */
export function summarizeUsage(
  states: ReadonlyArray<CliUsageState | undefined>,
  now: number,
  windowMs: number = USAGE_WINDOW_MS,
): UsageSummary {
  const todayDate = new Date(now)
  todayDate.setHours(0, 0, 0, 0)
  const firstDate = new Date(todayDate)
  firstDate.setDate(firstDate.getDate() - 6)
  // Default: today and the previous six local calendar days, up to now.
  const since = windowMs === USAGE_WINDOW_MS ? firstDate.getTime() : now - windowMs
  const knownTokens: Record<TokenKey, number> = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 }
  const unknown = new Set<TokenKey>()
  const perCli: Record<MaestroCliId, UsageCliBucket> = { claude: { ...EMPTY_BUCKET }, codex: { ...EMPTY_BUCKET }, grok: { ...EMPTY_BUCKET } }
  let requests = 0
  let ok = 0
  let failed = 0
  let cancelled = 0
  let durationMs = 0
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  let cacheWriteTokens = 0
  let sessions = 0
  const recent: CliUsageRecord[] = []
  const dailyMap = new Map<number, { requests: number; ok: number; failed: number }>()
  for (const state of states) {
    if (state === undefined) continue
    const records = state.recent ?? []
    if (records.length > 0) sessions += 1
    for (const record of records) {
      if (record == null || typeof record.startedAt !== 'number' || !Number.isFinite(record.startedAt) || record.startedAt < since || record.startedAt > now || (record.cli !== 'claude' && record.cli !== 'codex' && record.cli !== 'grok')) continue
      const isOk = record.phase === 'done'
      const isFailed = record.phase === 'failed' || record.phase === 'timeout'
      for (const key of TOKEN_KEYS) {
        const value = record[key]
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) unknown.add(key)
        knownTokens[key] += finitePositive(value ?? record.knownTokens?.[key])
      }
      const input = finitePositive(record.inputTokens)
      const output = finitePositive(record.outputTokens)
      const duration = Math.max(0, finitePositive(record.durationMs))
      requests += 1
      if (isOk) ok += 1
      else if (isFailed) failed += 1
      else cancelled += 1
      durationMs += duration
      inputTokens += input
      outputTokens += output
      cachedInputTokens += finitePositive(record.cachedInputTokens)
      cacheWriteTokens += finitePositive(record.cacheWriteTokens)
      const bucket = perCli[record.cli] ?? { ...EMPTY_BUCKET }
      const bucketKnown = { ...bucket.knownTokens }
      for (const key of TOKEN_KEYS) bucketKnown[key] = (bucketKnown[key] ?? 0) + finitePositive(record[key] ?? record.knownTokens?.[key])
      const sum = (key: TokenKey): number | null => bucket[key] === null || record[key] === null || !Number.isFinite(record[key]) ? null : (bucket[key] ?? 0) + finitePositive(record[key])
      perCli[record.cli] = {
        requests: bucket.requests + 1,
        ok: bucket.ok + (isOk ? 1 : 0),
        failed: bucket.failed + (isFailed ? 1 : 0),
        inputTokens: sum('inputTokens'),
        outputTokens: sum('outputTokens'),
        cachedInputTokens: sum('cachedInputTokens'), cacheWriteTokens: sum('cacheWriteTokens'), knownTokens: bucketKnown,
        durationMs: bucket.durationMs + duration,
      }
      recent.push(record)
      const day = dayStart(record.startedAt)
      const dayBucket = dailyMap.get(day) ?? { requests: 0, ok: 0, failed: 0 }
      dayBucket.requests += 1
      if (isOk) dayBucket.ok += 1
      else if (isFailed) dayBucket.failed += 1
      dailyMap.set(day, dayBucket)
    }
  }
  recent.sort((left, right) => right.startedAt - left.startedAt)
  const today = dayStart(now)
  const daily: UsageDayBucket[] = []
  const date = new Date(dayStart(since))
  while (date.getTime() <= today) {
    const day = date.getTime()
    const bucket = dailyMap.get(day) ?? { requests: 0, ok: 0, failed: 0 }
    daily.push({ day, ...bucket })
    date.setDate(date.getDate() + 1)
  }
  return {
    requests, ok, failed, cancelled, durationMs,
    inputTokens: unknown.has('inputTokens') ? null : inputTokens, outputTokens: unknown.has('outputTokens') ? null : outputTokens,
    cachedInputTokens: unknown.has('cachedInputTokens') ? null : cachedInputTokens, cacheWriteTokens: unknown.has('cacheWriteTokens') ? null : cacheWriteTokens, knownTokens,
    perCli,
    recent: recent.slice(0, USAGE_RECENT_SHOWN),
    sessions,
    daily,
  }
}

export const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens'] as const
export type TokenKey = (typeof TOKEN_KEYS)[number]
/** Unknown is never rendered as a measured zero. */
export function usageTokenLabel(value: number | null, known: number | undefined): string {
  return value === null ? known !== undefined && known > 0 ? '至少 ' + String(known) + '（部分未知）' : '未知' : String(value)
}

const EMPTY_SNAPSHOT: BoardSessionList = { byId: {} }
const ZERO_AVAILABLE_SUMMARY = { ...ZERO_SUMMARY, available: true }
const UNAVAILABLE_SUMMARY = { ...ZERO_SUMMARY, available: false }

/** 读会话 feed 并折叠可见样本；feed 缺席不是零调用。 */
export function useUsageSummary(ctx: { get(name: string): unknown }): UsageSummary & { readonly available: boolean } {
  const sessions: BoardSessionsFace | undefined = sessionsFaceOf(ctx)
  const subscribe = useCallback(
    (listener: () => void) => (sessions === undefined ? () => {} : sessions.list.subscribe(listener)),
    [sessions],
  )
  const read = useCallback(
    () => (sessions === undefined ? EMPTY_SNAPSHOT : sessions.list.getSnapshot()),
    [sessions],
  )
  const list = useSyncExternalStore(subscribe, read, read)
  const states = Object.values(list.projectionsBySession ?? {}).map(projection => projection?.values.maestroCliUsage)
  const summary = summarizeUsage(states, Date.now())
  if (sessions === undefined) return UNAVAILABLE_SUMMARY
  return summary.requests === 0 ? ZERO_AVAILABLE_SUMMARY : { ...summary, available: true }
}
