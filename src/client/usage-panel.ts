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

import type { CliUsageRecord, CliUsageState } from '../usage.js'
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
  readonly inputTokens: number
  readonly outputTokens: number
  readonly durationMs: number
}

/** 近 7 天汇总。 */
export interface UsageSummary {
  readonly requests: number
  readonly ok: number
  readonly failed: number
  readonly cancelled: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens: number
  readonly cacheWriteTokens: number
  readonly durationMs: number
  readonly perCli: Readonly<Record<MaestroCliId, UsageCliBucket>>
  /** 合并后的最近调用（新→旧，最多 {@link USAGE_RECENT_SHOWN} 条）。 */
  readonly recent: readonly CliUsageRecord[]
  /** 有调用记录的会话数。 */
  readonly sessions: number
}

const EMPTY_BUCKET: UsageCliBucket = { requests: 0, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 }

const ZERO_SUMMARY: UsageSummary = {
  requests: 0, ok: 0, failed: 0, cancelled: 0,
  inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0,
  durationMs: 0,
  perCli: { claude: EMPTY_BUCKET, codex: EMPTY_BUCKET },
  recent: [],
  sessions: 0,
}

function finitePositive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 折叠各会话的 CLI 用量投影（窗口 = [now - windowMs, now] 内的记录）。 */
export function summarizeUsage(
  states: ReadonlyArray<CliUsageState | undefined>,
  now: number,
  windowMs: number = USAGE_WINDOW_MS,
): UsageSummary {
  const since = now - windowMs
  const perCli: Record<MaestroCliId, UsageCliBucket> = { claude: { ...EMPTY_BUCKET }, codex: { ...EMPTY_BUCKET } }
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
  for (const state of states) {
    if (state === undefined) continue
    const records = state.recent ?? []
    if (records.length > 0) sessions += 1
    for (const record of records) {
      if (record == null || typeof record.startedAt !== 'number' || record.startedAt < since) continue
      const isOk = record.phase === 'done'
      const isFailed = record.phase === 'failed' || record.phase === 'timeout'
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
      perCli[record.cli] = {
        requests: bucket.requests + 1,
        ok: bucket.ok + (isOk ? 1 : 0),
        failed: bucket.failed + (isFailed ? 1 : 0),
        inputTokens: bucket.inputTokens + input,
        outputTokens: bucket.outputTokens + output,
        durationMs: bucket.durationMs + duration,
      }
      recent.push(record)
    }
  }
  recent.sort((left, right) => right.startedAt - left.startedAt)
  return {
    requests, ok, failed, cancelled, durationMs,
    inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens,
    perCli,
    recent: recent.slice(0, USAGE_RECENT_SHOWN),
    sessions,
  }
}

const EMPTY_SNAPSHOT: BoardSessionList = { byId: {} }

/** 读会话 feed 并折叠出用量汇总（feed 缺席时是全零的稳定值）。 */
export function useUsageSummary(ctx: { get(name: string): unknown }): UsageSummary {
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
  return summary.requests === 0 ? ZERO_SUMMARY : summary
}
