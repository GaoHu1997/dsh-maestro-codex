/**
 * Startup replay of durable CLI settlements as LIVE `cli-*` sessions.
 *
 * SessionStore.create publishes an in-memory session without a persistence
 * writer. The existing NativeRecovery path can nevertheless already have made
 * a CLI child durable. Such IDs MUST NOT be recreated from the journal: the
 * immutable header is owned by persistence, and a different live header makes
 * the host reject the entire logical session list. This replay only fills gaps
 * left after canonical recovery and persistence enumeration.
 *
 * Seed events are constructed, not appended: SessionStore.create stores them
 * without publishing `session/event`, so a replay never double-counts in the
 * live usage fold (which only consumes appended events) while snapshots read
 * by the session detail view do contain them.
 *
 * Scope follows the workspace registry: archived sessions are skipped, each
 * project contributes at most {@link REPLAY_SESSIONS_PER_WORKSPACE} sessions
 * (most recently active first).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { CLI_CHILD_RECORD_EVENT, type ChildSessionStoreFace } from './child-session.js'
import type { CliUsageRecord } from './usage.js'
import type { UsageJournal } from './usage-journal.js'

/** Each project replays at most this many parent sessions, newest first. */
export const REPLAY_SESSIONS_PER_WORKSPACE = 30

/** One owner queue shared by canonical recovery and snapshot replay. */
export class CliSessionRecoveryGate {
  private readonly tails = new Map<string, Promise<void>>()

  run(owner: string, action: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(owner) ?? Promise.resolve()
    const job = previous.catch(() => {}).then(action)
    this.tails.set(owner, job)
    void job.finally(() => {
      if (this.tails.get(owner) === job) this.tails.delete(owner)
    }).catch(() => {})
    return job
  }
}

export interface ReplayListedSession {
  readonly header: { readonly id: string; readonly createdAt?: number | undefined }
  readonly revision?: unknown
}

/** Minimal `sessionPersistence` face used by the replay. */
export interface ReplayPersistence {
  list(): Promise<readonly ReplayListedSession[]>
}

export interface CliSessionReplayDeps {
  readonly store: ChildSessionStoreFace | undefined
  readonly journal: UsageJournal
  readonly persistence: ReplayPersistence | undefined
  readonly dshHome: string
  readonly readConfig: () => { readonly recordChildSessions: boolean }
  readonly log: (level: 'warn' | 'error', message: string) => void
  /** Finish the canonical recovery for this owner before filling live gaps. */
  readonly prepareParent?: ((sessionId: string) => Promise<void>) | undefined
  /** Hold the shared recovery lock through fresh listing and live publication. */
  readonly withParent?: ((sessionId: string, publish: () => Promise<void>) => Promise<void>) | undefined
}

export interface CliSessionReplayOptions {
  /** Override the per-project cap (tests use small numbers). */
  readonly perWorkspace?: number | undefined
  /** Prevent late publication after the owning plugin/service is disposed. */
  readonly signal?: AbortSignal | undefined
}

interface ReplayWorkspace {
  readonly path: string
  readonly sessionIds: readonly string[]
}

interface ReplayWorkspaceState {
  readonly archivedSessionIds: readonly string[]
  readonly workspaces: readonly ReplayWorkspace[]
}

/**
 * Publish settled CLI records as live child sessions. Returns the number of
 * sessions created. Never throws: a broken workspace file, an unusable host
 * surface or one conflicting id must not block the plugin.
 */
export async function replayCliSessions(
  deps: CliSessionReplayDeps,
  options?: CliSessionReplayOptions,
): Promise<number> {
  const { store, journal, persistence, dshHome, log } = deps
  const signal = options?.signal
  if (signal?.aborted || store === undefined || persistence === undefined) return 0
  if (!deps.readConfig().recordChildSessions) return 0
  await journal.load()
  if (signal?.aborted) return 0
  const records = journal.allRecords()
  if (records.length === 0) return 0
  const state = await readWorkspaceState(dshHome)
  if (signal?.aborted || state === undefined) return 0

  const byParent = new Map<string, CliUsageRecord[]>()
  for (const record of records) {
    const parent = record.sessionId
    if (parent === undefined || parent === '') continue
    const list = byParent.get(parent)
    if (list === undefined) byParent.set(parent, [record])
    else list.push(record)
  }
  if (byParent.size === 0) return 0

  const archived = new Set(state.archivedSessionIds)
  const listed = new Map<string, ReplayListedSession>()
  try {
    for (const session of await persistence.list()) listed.set(session.header.id, session)
  } catch (error) {
    log('warn', `子会话重放跳过：读取会话列表失败（${String(error)}）`)
    return 0
  }
  if (signal?.aborted) return 0

  const cap = Math.max(1, Math.trunc(options?.perWorkspace ?? REPLAY_SESSIONS_PER_WORKSPACE))
  const replayed = new Set<string>()
  let created = 0
  for (const workspace of state.workspaces) {
    const candidates = workspace.sessionIds
      .filter((id) => !archived.has(id) && byParent.has(id))
      .map((id) => ({ id, at: lastActiveOf(listed.get(id)) }))
      .sort((a, b) => b.at - a.at)
      .slice(0, cap)
    for (const candidate of candidates) {
      if (signal?.aborted || !deps.readConfig().recordChildSessions) return created
      try {
        // Prepare outside the gate: the canonical recovery uses that same gate.
        await deps.prepareParent?.(candidate.id)
        if (signal?.aborted) return created
        const publish = async (): Promise<void> => {
          if (signal?.aborted || !deps.readConfig().recordChildSessions) return
          if (deps.prepareParent !== undefined || deps.withParent !== undefined) {
            // Hold the owner gate across this IO and every following create.
            // A completed preparation alone cannot prevent a new recovery job.
            for (const session of await persistence.list()) listed.set(session.header.id, session)
            if (signal?.aborted) return
          }
          for (const record of byParent.get(candidate.id) ?? []) {
            if (signal?.aborted || !deps.readConfig().recordChildSessions) return
            const childId = record.childSessionId
            if (childId === undefined || childId === '' || replayed.has(childId)) continue
            replayed.add(childId)
            // Cold durable children are already visible via persistence. Never
            // fabricate their same-ID headers from registry/journal metadata.
            if (listed.has(childId) || store.get?.(childId) !== undefined) continue
            try {
              store.create(childId, {
                seed: seedOf(record, candidate.id),
                inheritedEventCount: SessionLogOffset(0),
                meta: {
                  createdAt: record.startedAt,
                  ...(workspace.path === '' ? {} : { cwd: workspace.path }),
                  parentSession: candidate.id,
                  origin: 'subagent',
                },
              })
              created++
            } catch (error) {
              log('warn', `子会话重放失败：${childId}（${String(error)}）`)
            }
          }
        }
        if (deps.withParent === undefined) await publish()
        else await deps.withParent(candidate.id, publish)
      } catch (error) {
        log('warn', `子会话重放跳过：父会话恢复未完成 ${candidate.id}（${String(error)}）`)
      }
    }
  }
  return created
}

/** Native event shape the child recorder writes at settlement. */
function seedOf(record: CliUsageRecord, parentSessionId: string): readonly SessionEvent[] {
  const started = record.startedAt
  const ended = record.endedAt
  const childSessionId = record.childSessionId ?? `cli-${record.taskId}`
  const provider = record.provider === undefined || record.provider === '' ? 'cli' : record.provider
  const route = { provider, model: record.model }
  const usage = usageOf(record)
  const seed: SessionEvent[] = [
    { seq: SessionSeq(0), time: started, type: 'user/message', surfaceOp: 'append', data: {
      id: MessageId(`${record.taskId}-task`),
      role: 'user',
      content: [{ type: 'text', text: `CLI 任务 ${record.taskId}` }],
      source: { kind: 'user' },
    } },
    { seq: SessionSeq(1), time: started, type: CLI_CHILD_RECORD_EVENT, ignorable: true, data: {
      version: 1,
      kind: 'cli-record',
      taskId: record.taskId,
      childSessionId,
      parentSessionId,
      source: record.source ?? `cli:${record.cli}`,
      usageId: record.usageId ?? JSON.stringify([record.source ?? `cli:${record.cli}`, record.taskId, record.startedAt]),
      executor: 'external-cli',
      accounting: 'native-mirror-of-parent-cli-ledger',
      nativeInputSemantics: 'uncached',
      cli: record.cli,
    } },
  ]
  seed.push({ seq: SessionSeq(seed.length), time: started, type: 'request/context', data: route })
  seed.push({ seq: SessionSeq(seed.length), time: started, type: 'step/start', data: { turn: 1, step: 1 } })
  if (record.phase === 'done') {
    seed.push({ seq: SessionSeq(seed.length), time: ended, type: 'assistant/message', surfaceOp: 'append', data: {
      message: {
        id: MessageId(`${record.taskId}-replay`),
        role: 'assistant',
        content: [{ type: 'text', text: `CLI 任务 ${record.taskId} 已完成` }],
        source: { kind: 'model', provider, model: record.model },
      },
      turn: 1,
      step: 1,
      stream: [],
      ...(usage === undefined ? {} : { usage }),
    } })
  } else {
    seed.push({ seq: SessionSeq(seed.length), time: ended, type: 'assistant/attempt', data: {
      turn: 1,
      step: 1,
      stream: usage === undefined ? [] : [{ type: 'chunk', time: ended, chunk: { type: 'usage', usage } }],
    } })
  }
  return seed
}

interface ReplayUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

function usageOf(record: CliUsageRecord): ReplayUsage | undefined {
  const inputTokens = record.inputTokens
  const outputTokens = record.outputTokens
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return undefined
  const usage: ReplayUsage = { inputTokens, outputTokens }
  const cached = record.cachedInputTokens
  if (typeof cached === 'number' && cached > 0) usage.cacheReadTokens = cached
  const write = record.cacheWriteTokens
  if (typeof write === 'number' && write > 0) usage.cacheWriteTokens = write
  return usage
}

/**
 * Latest activity from the persistence revision (`dev:ino:size:mtimeNs:ctimeNs`),
 * falling back to the header creation time when the host shape changes.
 */
function lastActiveOf(session: ReplayListedSession | undefined): number {
  if (session === undefined) return 0
  const revision = session.revision === undefined ? '' : String(session.revision)
  const mtime = revision.split(':')[3]
  if (mtime !== undefined && /^\d+$/.test(mtime)) {
    try { return Number(BigInt(mtime) / 1_000_000n) } catch { /* fall through */ }
  }
  return session.header.createdAt ?? 0
}

async function readWorkspaceState(dshHome: string): Promise<ReplayWorkspaceState | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8')) as {
      global?: { archivedSessionIds?: unknown } | undefined
      tables?: { workspaces?: Record<string, unknown> | undefined } | undefined
    }
    const archivedRaw = raw.global?.archivedSessionIds
    const archivedSessionIds = Array.isArray(archivedRaw)
      ? archivedRaw.filter((value): value is string => typeof value === 'string')
      : []
    const workspaces: ReplayWorkspace[] = []
    for (const value of Object.values(raw.tables?.workspaces ?? {})) {
      if (value === null || typeof value !== 'object') continue
      const workspace = value as { path?: unknown; sessionIds?: unknown }
      if (typeof workspace.path !== 'string' || workspace.path === '') continue
      const sessionIds = Array.isArray(workspace.sessionIds)
        ? workspace.sessionIds.filter((id): id is string => typeof id === 'string')
        : []
      if (sessionIds.length === 0) continue
      workspaces.push({ path: workspace.path, sessionIds })
    }
    return { archivedSessionIds, workspaces }
  } catch {
    return undefined
  }
}
