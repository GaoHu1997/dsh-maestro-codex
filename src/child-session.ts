/**
 * CLI observation sessions, NOT DSH continuable executors. `cli-` identity and
 * the log-only maestro/cli-child marker distinguish them; the native catalog
 * mode is one-shot. The installed SessionHeader has NO readonly metadata.
 * SessionStore.create publishes an in-memory session, not a durable writer:
 * persistence and rejection of ordinary DSH execution need host lifecycle APIs.
 * No fake offline load/storeappend or unsupported header keys are used here.
 *
 * Running counters reach this record through {@link ChildSessionRecorder.progress}:
 * CLI spend only existed in the plugin's own projection before, so every plugin
 * that folds the session log (the native `tokenUsage` projection and any
 * third-party usage view) read zero until the task settled. A progress sample
 * is an ordinary `assistant/attempt` for (turn 1, step 1) — both the host fold
 * and those consumers replace by (turn, step) instead of adding, so repeated
 * snapshots correct the same spend rather than double counting it.
 */
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, SessionLogOffset, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { cliTokenCountOf } from './usage.js'
import type { MaestroCliId } from './wire.js'

export const CLI_CHILD_RECORD_EVENT = 'maestro/cli-child'
export const CLI_CHILD_PENDING_CAP = 256
/** Minimum spacing between two running snapshots of the same task. */
export const CLI_CHILD_PROGRESS_INTERVAL_MS = 30_000
/** Upper bound on progress events per task (240 × 30s ≈ two hours). */
export const CLI_CHILD_PROGRESS_CAP = 240
/**
 * This module NEVER appends a private `maestro/*` event to a session. The
 * installed host's `Session.append` accepts only surfaceOp/sourceEventSeqs and
 * has no `ignorable` channel, so a private type written that way makes the
 * whole stored log unloadable ("contains event type ... unknown to this
 * harness and not marked ignorable"). Durable CLI usage already lives in the
 * append-only usage journal ($DSH_HOME/maestro/usage-journal), which is what
 * the usage view and replay fold; the only private marker written here travels
 * through the public `create({ seed })` contract, which does preserve
 * `ignorable`.
 */
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
  /** Optional for old callers, which only distinguished success from failure. */
  readonly phase?: string | undefined
  readonly stats: ChildSessionUsageStats
  readonly route?: { readonly provider: string; readonly model: string } | undefined
  readonly finalText?: string | undefined
}
/** One running snapshot: the same counters the board card already shows. */
export interface ChildSessionProgressInput {
  readonly taskId: string
  readonly stats: ChildSessionUsageStats
  readonly route?: { readonly provider: string; readonly model: string } | undefined
}
/** Preserve the actual terminal outcome without inventing a cancellation cause. */
export function cliChildTurnEndReason(ok: boolean, phase?: string): TurnEndReason {
  if (phase === 'cancelled') return { kind: 'aborted', reason: { kind: 'legacy' } }
  if (phase === 'interrupted') return { kind: 'interrupted' }
  if (ok) return { kind: 'completed' }
  return { kind: 'error', error: { code: phase === 'timeout' ? 'CLI_TIMEOUT' : 'CLI_FAILED',
    message: phase === 'timeout' ? 'CLI task timed out' : 'CLI task did not complete' } }
}
export interface ChildSessionRecorder {
  start(input: ChildSessionStartInput): void
  /** Publish the running cumulative snapshot to the child log (best effort). */
  progress?(input: ChildSessionProgressInput): void
  settle(input: ChildSessionSettleInput): void
  /** Retry pending terminal appends and parent publication; NOT a disk replay. */
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
  pending?: readonly PendingAppend[]
  nextAppend: number
  appending: boolean
  /** Whether the running snapshot already opened turn/start, route and step. */
  progressOpened: boolean
  progressCount: number
  progressAt: number
  /** Serialized last snapshot: an unchanged total is not written again. */
  progressKey: string
}
interface PendingAppend {
  readonly type: string
  readonly data: unknown
  readonly opts?: { surfaceOp: 'append' }
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
export function createChildSessionRecorder(parts: ChildSessionRecorderParts): ChildSessionRecorder {
  const live = new Map<string, LiveRecord>()
  const catalogPending = new Map<string, { parentSessionId: string; data: Record<string, unknown> }>()
  const warn = (stage: string, error: unknown): void => {
    parts.logger?.warn(`dsh-maestro-codex: child session ${stage} skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
  function drain(record: LiveRecord): boolean {
    if (record.pending === undefined || record.appending) return false
    record.appending = true
    try {
      // Session.append validates before commit and contains observer failures.
      // Advance only after acceptance; a failed closer never repeats the usage.
      while (record.nextAppend < record.pending.length) {
        const event = record.pending[record.nextAppend]!
        record.session.append(event.type, event.data, event.opts)
        record.nextAppend++
      }
      live.delete(record.taskId)
      return true
    } catch (error) { warn('settle', error); return false }
    finally { record.appending = false }
  }
  function flushPending(): number {
    let count = 0
    for (const record of live.values()) if (drain(record)) count++
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
        const title = input.label.trim() || id
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
          // Log-only title hint. Measured on host 0.2.2-rc.1: the persisted
          // writer keeps unknown ignorable seed records (that is why the
          // marker above survives) but skips the known `session/title` type
          // even when `ignorable` is set, and the host exposes no plugin
          // title API. Keep the event for in-memory surface consumers; do not
          // promise a title in the on-disk log (see evidence/E2/O7-*-after-fix).
          { seq: SessionSeq(2), time: now, type: 'session/title', ignorable: true, data: {
            title, messageSeqs: [], source: { kind: 'user' },
          } } as unknown as SessionEvent,
        ]
        const session = store.create(id, { seed, inheritedEventCount: SessionLogOffset(0),
          meta: { cwd: input.cwd, parentSession: parentSessionId, origin: 'subagent' } })
        if (session === undefined) return
        const createdAt = session.header?.createdAt ?? now
        live.set(input.taskId, {
          session, taskId: input.taskId, parentSessionId, childSessionId: id, source, usageId,
          label: input.label, startedAt: input.startedAt ?? now,
          nextAppend: 0, appending: false,
          progressOpened: false, progressCount: 0, progressAt: 0, progressKey: '',
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
    progress(input) {
      const record = live.get(input.taskId)
      // 终态方案已冻结（settle 已排队或已写完）：运行期快照到此为止。
      if (record === undefined || record.pending !== undefined) return
      if (record.progressCount >= CLI_CHILD_PROGRESS_CAP) return
      const route = usableRoute(input.route)
      // 没有 route 就没有模型归属；留给结算，别写一条记不到模型的消费。
      if (route === undefined) return
      const usage = usageSampleOf(input.stats)
      // 不完整的样本不落盘：半桶计数写成整桶比没有更糟。
      if (usage === undefined) return
      const key = JSON.stringify(usage)
      const now = Date.now()
      // 两次快照之间至少隔一个间隔；总量没变就不重复写。
      if (record.progressOpened && (key === record.progressKey || now - record.progressAt < CLI_CHILD_PROGRESS_INTERVAL_MS)) return
      try {
        if (!record.progressOpened) {
          record.session.append('turn/start', { turn: 1 })
          record.session.append('request/context', route)
          record.session.append('step/start', { turn: 1, step: 1 })
          record.progressOpened = true
        }
        record.session.append('assistant/attempt', { turn: 1, step: 1,
          stream: [{ type: 'chunk', time: now, chunk: { type: 'usage', usage } }],
        })
        record.progressCount += 1
        record.progressAt = now
        record.progressKey = key
      } catch (error) {
        // 进度是锦上添花：写失败就停掉这条任务的进度，别每帧再试。
        record.progressCount = CLI_CHILD_PROGRESS_CAP
        warn('progress', error)
      }
    },
    settle(input) {
      const record = live.get(input.taskId)
      if (record === undefined) return
      if (record.pending !== undefined) { drain(record); return }
      try {
        flushPending()
        const identityMatches = (input.stats?.['usageSource'] === undefined || input.stats['usageSource'] === record.source)
          && (input.stats?.['usageAttemptId'] === undefined || input.stats['usageAttemptId'] === record.usageId)
        if (!identityMatches) warn('native usage', new Error('settlement identity changed; canonical ledger remains authoritative'))
        const route = usableRoute(input.route)
        // No route means no native attribution. Preserve those counters only in
        // the canonical ledger, rather than publishing an unowned native charge.
        const usage = identityMatches && route !== undefined ? usageSampleOf(input.stats) : undefined
        const events: PendingAppend[] = record.progressOpened
          ? []
          : [{ type: 'turn/start', data: { turn: 1 } }]
        // 运行期进度已经写过开启边界：同一个 (turn, step) 只留一个 turn/start
        // 和 step/start，结算只补终局样本与关闭事件。
        if (!record.progressOpened && route !== undefined) events.push({ type: 'request/context', data: route })
        if (!record.progressOpened) events.push({ type: 'step/start', data: { turn: 1, step: 1 } })
        const finalText = input.finalText?.trim() ?? ''
        if (input.ok && route !== undefined && finalText !== '') {
          events.push({ type: 'assistant/message', data: {
            message: { id: `${input.taskId}-answer`, role: 'assistant', content: [{ type: 'text', text: input.finalText ?? '' }], source: { kind: 'model', ...route } },
            turn: 1, step: 1, stream: [], ...(usage === undefined ? {} : { usage }),
          }, opts: { surfaceOp: 'append' } })
        } else {
          events.push({ type: 'assistant/attempt', data: { turn: 1, step: 1,
            stream: usage === undefined ? [] : [{ type: 'chunk', time: Date.now(), chunk: { type: 'usage', usage } }],
          } })
        }
        events.push({ type: 'step/end', data: { turn: 1, step: 1 } },
          { type: 'turn/end', data: { turn: 1, reason: cliChildTurnEndReason(input.ok, input.phase) } })
        // CLI streaming updates are cumulative snapshots in the channels. Publish
        // their final sample once, and freeze this plan before any append so a
        // later retry cannot replace it with another cumulative charge.
        record.pending = events
        drain(record)
      } catch (error) { warn('settle', error) }
    },
  }
}
