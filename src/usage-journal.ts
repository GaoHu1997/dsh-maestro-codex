import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { CLI_USAGE_EVENT, EMPTY_CLI_USAGE, applyCliUsage, cliUsageIdentityOf, cliUsageRecordOf, parseCliUsageRecord, sessionUsageAppendOf, type CliUsageRecord, type CliUsageState, type CliUsageTask } from './usage.js'

/** Canonical plugin-owned accounting journal. Never pruned with task history.
 * append acceptance and host flush acknowledgements NEVER delete these files.
 * A host crash before settlement is represented by an incomplete marker, not 0.
 */
export interface UsageJournalStatus {
  readonly records: number
  readonly incomplete: number
  readonly corrupt: number
  readonly writeFailures: number
  readonly cleanupFailures: number
  readonly hostFlushAcknowledged: number
  readonly hostFlushUnavailable: number
}
interface PendingRecord { version: 1; taskId: string; cli: 'codex' | 'claude'; sessionId?: string | undefined; startedAt: number; model: string }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const pendingKey = (record: Pick<CliUsageRecord, 'sessionId' | 'cli' | 'taskId' | 'startedAt'>): string => digest([record.sessionId ?? null, record.cli, record.taskId, record.startedAt])
const recordKey = (record: CliUsageRecord): string => digest([record.sessionId ?? null, cliUsageIdentityOf(record)])
const isMissing = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
function pendingOf(value: unknown): PendingRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const data = value as Record<string, unknown>
  return data['version'] === 1 && typeof data['taskId'] === 'string' && data['taskId'] !== ''
    && (data['cli'] === 'codex' || data['cli'] === 'claude') && typeof data['model'] === 'string'
    && typeof data['startedAt'] === 'number' && Number.isFinite(data['startedAt']) && data['startedAt'] >= 0
    && (data['sessionId'] === undefined || typeof data['sessionId'] === 'string') ? data as unknown as PendingRecord : undefined
}
/** Commit a new immutable file without overwriting a concurrent writer. The
 * temporary inode is synced before the atomic hard-link commit. NTFS supports
 * this same-volume operation. Failure is explicit; no unlink-then-rename gap.
 */
async function commit(dir: string, name: string, payload: unknown): Promise<void> {
  await mkdir(dir, { recursive: true })
  const temporary = join(dir, `.pending-${randomUUID()}.tmp`)
  const target = join(dir, name)
  const text = JSON.stringify(payload)
  const file = await open(temporary, 'wx', 0o600)
  let synced = false
  try { await file.writeFile(text, 'utf8'); await file.sync(); synced = true }
  finally { await file.close(); if (!synced) await unlink(temporary).catch(() => {}) }
  try {
    try { await link(temporary, target) }
    catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error
      if (JSON.stringify(JSON.parse(await readFile(target, 'utf8'))) !== text) throw new Error('同一用量身份对应了不同的结算记录')
    }
    // Directory fsync is supported on Unix, not on every Windows filesystem.
    // The synced immutable inode remains canonical in either case.
    try { const directory = await open(dir, 'r'); try { await directory.sync() } finally { await directory.close() } } catch { /* documented filesystem capability */ }
  } finally { await unlink(temporary).catch(() => {}) }
}
export class UsageJournal {
  readonly directory: string
  private readonly records = new Map<string, CliUsageRecord>()
  private readonly pending = new Map<string, PendingRecord>()
  private readonly delivered = new WeakMap<object, Set<string>>()
  private loading: Promise<void> | undefined
  private serial: Promise<void> = Promise.resolve()
  private refreshing: Promise<void> | undefined
  private readonly corruptFiles = new Set<string>()
  private writeFailures = 0
  private cleanupFailures = 0
  private hostFlushAcknowledged = 0
  private hostFlushUnavailable = 0
  constructor(dshHome: string) { this.directory = join(dshHome, 'maestro', 'usage-journal') }
  status(): UsageJournalStatus { return { records: this.records.size, incomplete: this.pending.size, corrupt: this.corruptFiles.size, writeFailures: this.writeFailures, cleanupFailures: this.cleanupFailures, hostFlushAcknowledged: this.hostFlushAcknowledged, hostFlushUnavailable: this.hostFlushUnavailable } }
  incompleteFor(sessionId: string): number { return [...this.pending.values()].filter(record => record.sessionId === sessionId).length }
  /** Supplementary classification for an execution veto, never read authorization. */
  ownsChildSession(sessionId: string, parentSessionId: string): boolean {
    return [...this.records.values()].some(record => record.sessionId === parentSessionId && record.childSessionId === sessionId)
      || [...this.pending.values()].some(record => record.sessionId === parentSessionId && `cli-${record.taskId}` === sessionId)
  }
  load(): Promise<void> {
    this.loading ??= this.loadFiles().catch(error => { this.loading = undefined; throw error })
    return this.loading
  }
  /** Re-read immutable records committed by another host process. Concurrent
   * readers share one scan and never race this instance's begin/settle queue. */
  refresh(): Promise<void> {
    this.refreshing ??= this.enqueue(async () => { await this.load(); await this.loadFiles() }).finally(() => { this.refreshing = undefined })
    return this.refreshing
  }
  private async loadFiles(): Promise<void> {
    let names: string[]
    try { names = await readdir(this.directory) } catch (error) { if (isMissing(error)) return; throw error }
    const pending = new Map<string, PendingRecord>()
    for (const name of names.sort()) {
      if (!/^(?:[a-f0-9]{64}|incomplete-[a-f0-9]{64})\.json$/.test(name)) continue
      try {
        const parsed: unknown = JSON.parse(await readFile(join(this.directory, name), 'utf8'))
        if (name.startsWith('incomplete-')) {
          const marker = pendingOf(parsed)
          if (marker === undefined || name !== `incomplete-${pendingKey(marker)}.json`) throw new Error('invalid pending usage marker')
          pending.set(pendingKey(marker), marker)
        } else {
          const envelope = parsed as { version?: unknown; record?: unknown }
          const record = envelope?.version === 1 ? parseCliUsageRecord(envelope.record) : undefined
          if (record === undefined || name !== `${recordKey(record)}.json`) throw new Error('invalid usage journal record')
          const previous = this.records.get(recordKey(record))
          if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error('immutable usage record changed')
          this.records.set(recordKey(record), record)
        }
        this.corruptFiles.delete(name)
      } catch { this.corruptFiles.add(name) }
    }
    this.pending.clear()
    for (const [key, marker] of pending) this.pending.set(key, marker)
    // An interrupted marker cleanup cannot create a second charge.
    for (const record of this.records.values()) this.pending.delete(pendingKey(record))
  }
  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.serial.then(action)
    this.serial = result.catch(() => {})
    return result
  }
  begin(task: CliUsageTask): Promise<void> {
    return this.enqueue(async () => {
      await this.load()
      const marker: PendingRecord = { version: 1, taskId: task.id, cli: task.cli, model: task.model, startedAt: task.startedAt, ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }) }
      const key = pendingKey(marker)
      if (this.pending.has(key) || [...this.records.values()].some(record => pendingKey(record) === key)) return
      try { await commit(this.directory, `incomplete-${key}.json`, marker); this.pending.set(key, marker) }
      catch (error) { this.writeFailures++; throw error }
    })
  }
  settle(task: CliUsageTask): Promise<void> {
    return this.enqueue(async () => {
      await this.load()
      const record = cliUsageRecordOf(task)
      if (parseCliUsageRecord(record) === undefined) throw new Error('不可写入非终态或非法用量记录')
      const key = recordKey(record)
      try {
        await commit(this.directory, `${key}.json`, { version: 1, record })
        this.records.set(key, record)
        this.pending.delete(pendingKey(record))
        await unlink(join(this.directory, `incomplete-${pendingKey(record)}.json`)).catch(error => { if (!isMissing(error)) this.cleanupFailures++ })
      } catch (error) { this.writeFailures++; throw error }
    })
  }
  /** Every committed settlement, parent-agnostic; startup replay only. */
  allRecords(): readonly CliUsageRecord[] {
    return structuredClone([...this.records.values()])
  }
  /** Full parent-scoped settlement history, isolated from canonical references. */
  recordsFor(sessionId: string): readonly CliUsageRecord[] {
    return structuredClone([...this.records.values()].filter(record => record.sessionId === sessionId)
      .sort((a, b) => a.startedAt - b.startedAt || cliUsageIdentityOf(a).localeCompare(cliUsageIdentityOf(b))))
  }
  /** Explicitly parent-scoped canonical read; no caller-supplied global fallback. */
  snapshot(sessionId: string): CliUsageState {
    let state = EMPTY_CLI_USAGE
    for (const record of [...this.records.values()].filter(record => record.sessionId === sessionId).sort((a, b) => a.startedAt - b.startedAt)) state = applyCliUsage(state, { type: CLI_USAGE_EVENT, data: record })
    return structuredClone(state)
  }
  /** Publishes a volatile display mirror, never a private Session event.
   * The canonical journal is durable; flushing native Session events cannot
   * acknowledge persistence of this mirror. Keep the optional argument for
   * callers compiled against the previous interface, but never invoke it.
   */
  async publish(session: unknown, sessionId: string, _flush?: (session: unknown) => Promise<boolean>): Promise<number> {
    await this.refresh()
    const target = sessionUsageAppendOf(session)
    if (target === undefined || typeof session !== 'object' || session === null) return 0
    const visibleId = (session as { id?: unknown }).id
    if (visibleId !== undefined && visibleId !== sessionId) throw new Error('用量重放目标不属于指定父会话')
    let delivered = this.delivered.get(session)
    if (delivered === undefined) { delivered = new Set(); this.delivered.set(session, delivered) }
    let published = 0
    for (const record of this.records.values()) {
      const key = recordKey(record)
      if (record.sessionId !== sessionId || delivered.has(key)) continue
      target.append(CLI_USAGE_EVENT, record)
      delivered.add(key); published++
    }
    if (published !== 0) this.hostFlushUnavailable++
    return published
  }
}
