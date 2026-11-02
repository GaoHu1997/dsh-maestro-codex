/**
 * CLI observation sessions, NOT DSH continuable executors. `cli-` identity and
 * the log-only maestro/cli-child marker distinguish them; the native catalog
 * mode is one-shot. The installed SessionHeader has NO readonly metadata.
 * SessionStore.create publishes an in-memory session, not a durable writer:
 * persistence and rejection of ordinary DSH execution need host lifecycle APIs.
 * No fake offline load/storeappend or unsupported header keys are used here.
 */
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { cliTokenCountOf } from './usage.js'
import type { MaestroCliId } from './wire.js'

export const CLI_CHILD_RECORD_EVENT = 'maestro/cli-child'
export const CLI_CHILD_PENDING_CAP = 256
/**
 * Live CLI usage snapshots, written into the child session while the task is
 * running and into the parent session once at settlement. The parent copy is
 * the durable ledger: the child session itself is memory-only, so a restart
 * would otherwise erase every CLI subagent from the usage view. `kind`
 * distinguishes the throttled running snapshot from the final settlement.
 */
export const CLI_USAGE_LIVE_EVENT = 'maestro/cli-usage-live'
/** Minimum spacing between two live snapshots of one task. The CLI emits
 *  usage far more often than a human can read; the view polls every 1.5s. */
export const LIVE_USAGE_MIN_INTERVAL_MS = 2_000
export interface ChildSessionAppend {
  readonly header?: { readonly createdAt: number } | undefined
  append(type: string, data: unknown, opts?: { surfaceOp?: 'append' }): unknown
}
/** Real installed SessionStore surface: create/get are LIVE, not disk access. */
export interface ChildSessionStoreFace {
  create(id: string, options?: { seed?: readonly SessionEvent[]; inheritedEventCount?: SessionLogOffset; meta?: { cwd?: string; parentSession?: string; origin?: 'subagent'; createdAt?: number } }): ChildSessionAppend | undefined
  get?(id: string): ChildSessionAppend | undefined
}
export type ChildSessionUsageStats = Record<string, string | number | boolean> | undefined
export interface ChildSessionStartInput {
  readonly taskId: string
  readonly cli?: MaestroCliId | undefined
  readonly startedAt?: number | undefined
  readonly label: string
  readonly taskText: string
  readonly cwd: string
  readonly parentSession?: ChildSessionAppend | undefined
  readonly parentSessionId?: string | undefined
}
export interface ChildSessionSettleInput {
  readonly taskId: string
  readonly ok: boolean
  readonly stats: ChildSessionUsageStats
  readonly route?: { readonly provider: string; readonly model: string } | undefined
  readonly finalText?: string | undefined
}
/** One throttled usage snapshot taken while the task is still running. */
export interface ChildSessionLiveInput {
  readonly taskId: string
  readonly stats: ChildSessionUsageStats
  readonly route?: { readonly provider: string; readonly model: string } | undefined
}
export interface ChildSessionRecorder {
  start(input: ChildSessionStartInput): void
  /** Publish a running usage snapshot (child) plus the eventual settlement
   *  (child and parent). No-op once settled or when the sample is incomplete. */
  reportLive(input: ChildSessionLiveInput): void
  settle(input: ChildSessionSettleInput): void
  /** Retry parent catalog publication against live get only; NOT a disk replay. */
  flushPending?(): number
}
export interface ChildSessionRecorderParts {
  store: () => ChildSessionStoreFace | undefined
  readConfig: () => { recordChildSessions: boolean }
  logger?: { warn(message: string): void } | undefined
}
interface LiveRecord {
  readonly session: ChildSessionAppend
  readonly taskId: string
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly source: string
  readonly usageId: string
  readonly label: string
  readonly startedAt: number
  stepStarted: boolean
  settled: boolean
  lastLiveAt: number
  lastLiveSignature: string
}
interface NativeUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
}
function usageSampleOf(stats: ChildSessionUsageStats): NativeUsage | undefined {
  const inputTokens = cliTokenCountOf(stats, 'inputTokens')
  const outputTokens = cliTokenCountOf(stats, 'outputTokens')
  // Native TokenUsage REQUIRES both. Incomplete samples cannot be represented
  // there; the parent custom ledger preserves each known/unknown bucket instead.
  const semantics = stats?.['usageInputSemantics']
  // Before semantics metadata existed, the plugin's channel counters were
  // already normalized to uncached input. Only that absent legacy tag is allowed.
  if (inputTokens === null || outputTokens === null || (semantics !== undefined && semantics !== 'uncached')) return undefined
  const cacheReadTokens = cliTokenCountOf(stats, 'cachedInputTokens')
  const cacheWriteTokens = cliTokenCountOf(stats, 'cacheWriteTokens')
  // The shared helper rejects partial required buckets above and omits partial
  // optional buckets here. A stale provider total cannot repair an incomplete sum.
  const partial = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens']
    .some(key => stats?.[`usagePartial_${key}`] === true)
  const totalTokens = partial ? null : cliTokenCountOf(stats, 'totalTokens')
  return {
    inputTokens, outputTokens,
    ...(cacheReadTokens === null ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === null ? {} : { cacheWriteTokens }),
    // Preserve an explicit provider total only. Never guess one by adding buckets.
    ...(totalTokens === null || totalTokens < inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) ? {} : { totalTokens }),
  }
}
function usableRoute(route: ChildSessionSettleInput['route']): { provider: string; model: string } | undefined {
  const provider = route?.provider.trim() ?? ''
  const model = route?.model.trim() ?? ''
  return provider !== '' && model !== '' ? { provider, model } : undefined
}
/**
 * One `maestro/cli-usage-live` payload. Both the child snapshot (`live`) and
 * the durable parent ledger row (`settled`) share this shape so a consumer can
 * fold them with the same code; `kind` only tells recovery which rows count.
 */
function liveUsagePayload(
  record: LiveRecord,
  kind: 'live' | 'settled',
  phase: 'running' | 'done' | 'failed',
  usage: NativeUsage | undefined,
  route: { provider: string; model: string } | undefined,
  now: number,
): Record<string, unknown> {
  return {
    version: 1, kind, phase,
    taskId: record.taskId,
    childSessionId: record.childSessionId,
    parentSessionId: record.parentSessionId,
    source: record.source,
    usageId: record.usageId,
    cli: record.source.startsWith('cli:') ? record.source.slice(4) : record.source,
    turn: 1, step: 1,
    startedAt: record.startedAt,
    updatedAt: now,
    ...(route === undefined ? {} : { provider: route.provider, model: route.model }),
    ...(usage === undefined ? {} : { usage: {
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
      ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
      ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    } }),
    label: record.label,
  }
}
export function createChildSessionRecorder(parts: ChildSessionRecorderParts): ChildSessionRecorder {
  const live = new Map<string, LiveRecord>()
  const catalogPending = new Map<string, { parentSessionId: string; data: Record<string, unknown> }>()
  const warn = (stage: string, error: unknown): void => {
    parts.logger?.warn(`dsh-maestro-codex: child session ${stage} skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
  function flushPending(): number {
    let count = 0
    for (const [id, row] of catalogPending) {
      try {
        const parent = parts.store()?.get?.(row.parentSessionId)
        if (parent === undefined) continue
        parent.append('subagent/catalog', row.data)
        catalogPending.delete(id)
        count++
      } catch (error) { warn('catalog retry', error) }
    }
    return count
  }
  return {
    flushPending,
    start(input) {
      try {
        if (!parts.readConfig().recordChildSessions || live.has(input.taskId)) return
        const parentSessionId = input.parentSessionId
        if (parentSessionId === undefined || parentSessionId === '') return
        const store = parts.store()
        if (store === undefined) return
        flushPending()
        const id = `cli-${input.taskId}`
        const now = Date.now()
        const source = `cli:${input.cli ?? 'unknown'}`
        const usageId = JSON.stringify([source, input.taskId, input.startedAt ?? now])
        // Session.append drops ignorable options on current released hosts.
        // The public seed contract preserves the explicit event envelope.
        const seed: readonly SessionEvent[] = [
          { seq: SessionSeq(0), time: now, type: 'user/message', surfaceOp: 'append', data: {
            id: MessageId(`${input.taskId}-task`), role: 'user', content: [{ type: 'text', text: input.taskText }], source: { kind: 'user' },
          } },
          { seq: SessionSeq(1), time: now, type: CLI_CHILD_RECORD_EVENT, ignorable: true, data: {
            version: 1, kind: 'cli-record', taskId: input.taskId, parentSessionId, childSessionId: id,
            source, usageId, executor: 'external-cli', accounting: 'native-mirror-of-parent-cli-ledger',
            // Describes the writer's normalization policy, not a usage sample.
            nativeInputSemantics: 'uncached',
            ...(input.cli === undefined ? {} : { cli: input.cli }),
          } },
        ]
        const session = store.create(id, { seed, inheritedEventCount: SessionLogOffset(0),
          meta: { cwd: input.cwd, parentSession: parentSessionId, origin: 'subagent' } })
        if (session === undefined) return
        const createdAt = session.header?.createdAt ?? now
        live.set(input.taskId, {
          session, taskId: input.taskId, parentSessionId, childSessionId: id, source, usageId,
          label: input.label, startedAt: input.startedAt ?? now,
          stepStarted: false, settled: false, lastLiveAt: 0, lastLiveSignature: '',
        })
        const data = { version: 0, childId: id, childCreatedAt: createdAt, mode: 'one-shot', label: input.label }
        const parent = input.parentSession ?? store.get?.(parentSessionId)
        try {
          if (parent === undefined) throw new Error('parent is not live')
          parent.append('subagent/catalog', data)
        } catch (error) {
          catalogPending.set(id, { parentSessionId, data })
          while (catalogPending.size > CLI_CHILD_PENDING_CAP) {
            const oldest = catalogPending.keys().next().value
            if (oldest === undefined) break
            catalogPending.delete(oldest)
            warn('catalog queue', new Error('bounded live retry queue overflow; oldest catalog dropped'))
          }
          warn('catalog', error)
        }
      } catch (error) { warn('recording', error) }
    },
    reportLive(input) {
      const record = live.get(input.taskId)
      if (record === undefined || record.settled) return
      try {
        const usage = usageSampleOf(input.stats)
        // Partial CLI output cannot be represented as native usage; the view
        // keeps the previous snapshot instead of showing a truncated number.
        if (usage === undefined) return
        const now = Date.now()
        const route = usableRoute(input.route)
        const signature = [
          usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0,
          usage.cacheWriteTokens ?? 0, usage.totalTokens ?? 0,
          route?.provider ?? '', route?.model ?? '',
        ].join(':')
        if (signature === record.lastLiveSignature) return
        if (now - record.lastLiveAt < LIVE_USAGE_MIN_INTERVAL_MS) return
        record.lastLiveAt = now
        record.lastLiveSignature = signature
        record.session.append(CLI_USAGE_LIVE_EVENT, liveUsagePayload(record, 'live', 'running', usage, route, now))
      } catch (error) { warn('live usage', error) }
    },
    settle(input) {
      const record = live.get(input.taskId)
      if (record === undefined || record.settled) return
      try {
        flushPending()
        const identityMatches = (input.stats?.['usageSource'] === undefined || input.stats['usageSource'] === record.source)
          && (input.stats?.['usageAttemptId'] === undefined || input.stats['usageAttemptId'] === record.usageId)
        // The seed owns immutable linkage. If settlement changes identity, keep
        // its spend in the canonical journal rather than misattribute a mirror.
        const usage = identityMatches ? usageSampleOf(input.stats) : undefined
        if (!identityMatches) warn('native usage', new Error('settlement identity changed; canonical ledger remains authoritative'))
        const route = usableRoute(input.route)
        // request/context is the real host attribution contract for attempts;
        // assistant/attempt itself has no source/provider/model field.
        if (route !== undefined) record.session.append('request/context', route)
        if (!record.stepStarted) { record.session.append('step/start', { turn: 1, step: 1 }); record.stepStarted = true }
        const finalText = input.finalText?.trim() ?? ''
        if (input.ok && route !== undefined && finalText !== '') {
          record.session.append('assistant/message', {
            message: { id: `${input.taskId}-answer`, role: 'assistant', content: [{ type: 'text', text: input.finalText ?? '' }], source: { kind: 'model', ...route } },
            turn: 1, step: 1, stream: [], ...(usage === undefined ? {} : { usage }),
          }, { surfaceOp: 'append' })
        } else {
          record.session.append('assistant/attempt', { turn: 1, step: 1,
            stream: usage === undefined ? [] : [{ type: 'chunk', time: Date.now(), chunk: { type: 'usage', usage } }],
          })
        }
        const phase = input.ok ? 'done' as const : 'failed' as const
        record.session.append(CLI_USAGE_LIVE_EVENT, liveUsagePayload(record, 'settled', phase, usage, route, Date.now()))
        // Durable copy of the final usage for the usage view: the child session
        // is memory-only, so settlement is the last moment the spend can survive
        // a restart. Best effort — a disposed parent must not fail settlement.
        try {
          parts.store()?.get?.(record.parentSessionId)?.append(CLI_USAGE_LIVE_EVENT, liveUsagePayload(record, 'settled', phase, usage, route, Date.now()))
        } catch (error) { warn('parent usage ledger', error) }
        record.settled = true
        // Drop append faces after settlement. Duplicate starts are also blocked
        // by the host's real duplicate-id guard, duplicate settles by this removal.
        live.delete(input.taskId)
      } catch (error) { warn('settle', error) }
    },
  }
}
