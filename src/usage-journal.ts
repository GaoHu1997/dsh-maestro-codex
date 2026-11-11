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
interface PendingRecord { version: 1; taskId: string; cli: 'codex' | 'claude' | 'grok'; sessionId?: string | undefined; startedAt: number; model: string }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const pendingKey = (record: Pick<CliUsageRecord, 'sessionId' | 'cli' | 'taskId' | 'startedAt'>): string => digest([record.sessionId ?? null, record.cli, record.taskId, record.startedAt])
const recordKey = (record: CliUsageRecord): string => digest([record.sessionId ?? null, cliUsageIdentityOf(record)])
const isMissing = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
function pendingOf(value: unknown): PendingRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const data = value as Record<string, unknown>
  return data['version'] === 1 && typeof data['taskId'] === 'string' && data['taskId'] !== ''
    && (data['cli'] === 'codex' || data['cli'] === 'claude' || data['cli'] === 'grok') && typeof data['model'] === 'string'
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
  /** pendingKey → 标记文件名：增量刷新靠它判断标记是否已被 settle 删除。 */
  private readonly pendingFile = new Map<string, string>()
  private readonly delivered = new WeakMap<object, Set<string>>()
  /** 已处理过的文件名（已入库，或内容判定为不可修复的坏文件）。文件名就是内容
   * 摘要，commit 的 EEXIST 校验保证同名内容不可变，所以刷新只需要读新名字。 */
  private readonly seen = new Set<string>()
  private loading: Promise<void> | undefined
  private serial: Promise<void> = Promise.resolve()
  private refreshing: Promise<void> | undefined
  private scanning: Promise<void> | undefined
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
  /** Shared scan: `load()` and `refresh()` never race two directory walks. */
  private loadFiles(): Promise<void> {
    this.scanning ??= this.scanFiles().finally(() => { this.scanning = undefined })
    return this.scanning
  }
  /**
   * 只读还没见过的名字。journal 是 append-only，文件名就是自身内容摘要，
   * `commit` 的 EEXIST 校验又拒绝"同名不同内容"，所以已见名字的内容不可能变。
   * 全量重扫会每轮把 100+ 个文件重新 readFile + JSON.parse：在 108 个文件的
   * 本机 journal 上实测 31–40 ms/轮，而且是 host 事件循环上的同步阻塞。
   */
  private async scanFiles(): Promise<void> {
    let names: string[]
    try { names = await readdir(this.directory) } catch (error) { if (isMissing(error)) return; throw error }
    const present = new Set<string>()
    for (const name of names.sort()) {
      if (!/^(?:[a-f0-9]{64}|incomplete-[a-f0-9]{64})\.json$/.test(name)) continue
      present.add(name)
      if (this.seen.has(name)) continue
      try {
        const parsed: unknown = JSON.parse(await readFile(join(this.directory, name), 'utf8'))
        if (name.startsWith('incomplete-')) {
          const marker = pendingOf(parsed)
          if (marker === undefined || name !== `incomplete-${pendingKey(marker)}.json`) throw new Error('invalid pending usage marker')
          const key = pendingKey(marker)
          this.pending.set(key, marker)
          this.pendingFile.set(key, name)
        } else {
          const envelope = parsed as { version?: unknown; record?: unknown }
          const record = envelope?.version === 1 ? parseCliUsageRecord(envelope.record) : undefined
          if (record === undefined || name !== `${recordKey(record)}.json`) throw new Error('invalid usage journal record')
          const key = recordKey(record)
          const previous = this.records.get(key)
          if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error('immutable usage record changed')
          this.records.set(key, record)
          // 结算完成的记录不会再留标记：同轮兑现，别把它报成 incomplete。
          this.pending.delete(pendingKey(record))
          this.pendingFile.delete(pendingKey(record))
        }
        this.corruptFiles.delete(name)
        this.seen.add(name)
      } catch (error) {
        // 目录与读取之间被删掉是一次竞态，不是坏文件：交给下一次目录扫描。
        if (isMissing(error)) continue
        this.corruptFiles.add(name)
        this.seen.add(name)
      }
    }
    // settle 会 unlink 标记文件；增量扫描读不到旧名字，用当前目录清单收尾。
    for (const [key, name] of [...this.pendingFile]) {
      if (present.has(name)) continue
      this.pending.delete(key)
      this.pendingFile.delete(key)
    }
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
      try {
        await commit(this.directory, `incomplete-${key}.json`, marker)
        this.pending.set(key, marker)
        this.pendingFile.set(key, `incomplete-${key}.json`)
        this.seen.add(`incomplete-${key}.json`)
      } catch (error) { this.writeFailures++; throw error }
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
        this.seen.add(`${key}.json`)
        this.pending.delete(pendingKey(record))
        this.pendingFile.delete(pendingKey(record))
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
