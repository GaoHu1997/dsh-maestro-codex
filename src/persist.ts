/**
 * 任务结果落盘：registry 是内存的（60 条上限、随宿主进程消失），这里把每次
 * 派发结算的 CLI 任务（摘要 + 最终文本 + 事件尾）写到
 * `$DSH_HOME/maestro/tasks/<taskId>.json`，并在插件启动时把最近的一批读回来
 * 种进 TaskRegistry——重启后配置卡的「任务监视」仍能翻历史。
 *
 * 全程 best effort：任何 IO 失败都静默降级（落盘只是记录面，不是派发依赖），
 * 与 `usage.ts` 的报告语义一致。
 */

import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MaestroTaskEvent } from './wire.js'
import { TERMINAL_PHASES, type MaestroCliId, type MaestroPhase } from './wire.js'

/** dsh 主目录（与 mcp.ts / dsh-models.ts 同一解析规则）。 */
export function dshHomeOf(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const fromEnv = env['DSH_HOME']?.trim() ?? ''
  return fromEnv !== '' ? fromEnv : join(home, '.dsh')
}

/** The persisted-record directory under the dsh home. */
export function tasksDirOf(dshHome: string): string {
  return join(dshHome, 'maestro', 'tasks')
}

/** Events kept per persisted record (the registry ring is 800; disk keeps the tail). */
export const PERSIST_EVENT_TAIL = 200

/** Finished-task files kept on disk; persist prunes the oldest beyond this. */
export const PERSIST_KEEP = 200

/** One settled task as it travels to disk (and back into the registry). */
export interface PersistedTask {
  readonly id: string
  readonly cli: MaestroCliId
  readonly title: string
  readonly cwd?: string | undefined
  readonly model: string
  readonly sessionId?: string | undefined
  readonly phase: MaestroPhase
  readonly startedAt: number
  readonly endedAt?: number | undefined
  readonly exitCode?: number | undefined
  readonly error?: string | undefined
  readonly finalText?: string | undefined
  readonly stats?: Readonly<Record<string, string | number | boolean>> | undefined
  readonly truncated?: boolean | undefined
  readonly events: readonly MaestroTaskEvent[]
  readonly savedAt: number
}

/** The slice of a registry record the persister reads (MaestroTask satisfies it). */
export interface PersistInput {
  readonly id: string
  readonly cli: MaestroCliId
  readonly title: string
  readonly cwd?: string | undefined
  readonly model: string
  readonly sessionId?: string | undefined
  readonly phase: MaestroPhase
  readonly startedAt: number
  readonly endedAt?: number | undefined
  readonly exitCode?: number | undefined
  readonly error?: string | undefined
  readonly finalText?: string | undefined
  readonly stats?: Readonly<Record<string, string | number | boolean>> | undefined
  readonly truncated?: boolean | undefined
  readonly events: readonly MaestroTaskEvent[]
}

/** Fold one settled registry record into the JSON shape (pure; testable). */
export function persistedOf(task: PersistInput, savedAt: number, eventTail: number = PERSIST_EVENT_TAIL): PersistedTask {
  return {
    id: task.id,
    cli: task.cli,
    title: task.title,
    ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
    model: task.model,
    ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
    phase: task.phase,
    startedAt: task.startedAt,
    ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
    ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
    ...(task.error === undefined ? {} : { error: task.error }),
    ...(task.finalText === undefined ? {} : { finalText: task.finalText }),
    ...(task.stats === undefined ? {} : { stats: task.stats }),
    ...(task.truncated === true ? { truncated: true } : {}),
    // 只留事件尾：800 条满环最坏 3MB+，磁盘历史 200 条足够翻旧账。
    events: task.events.slice(-eventTail),
    savedAt,
  }
}

/**
 * Write one settled task to disk and prune the oldest beyond `keep`.
 * Never throws — a failing record store must not take the dispatch down.
 */
export async function persistTask(dshHome: string, task: PersistInput, options?: { keep?: number; eventTail?: number; now?: number }): Promise<void> {
  try {
    if (!(TERMINAL_PHASES as readonly string[]).includes(task.phase)) return
    if (!task.id.startsWith('task-')) return // npm 安装作业没有可回看的结果
    const dir = tasksDirOf(dshHome)
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${task.id}.json`)
    const payload = JSON.stringify(persistedOf(task, options?.now ?? Date.now(), options?.eventTail ?? PERSIST_EVENT_TAIL), null, 2)
    // 记录可能带代码片段与工作目录路径：与 mcp 临时配置同样收紧到 owner。
    await writeFile(file, payload, { encoding: 'utf8', mode: 0o600 })
    await prunePersisted(dir, options?.keep ?? PERSIST_KEEP)
  } catch { /* best effort — see module doc */ }
}

/** Delete the oldest task files beyond `keep` (best effort; mtime ≈ settle time). */
export async function prunePersisted(dir: string, keep: number): Promise<void> {
  try {
    const names = (await readdir(dir)).filter(name => name.endsWith('.json'))
    if (names.length <= keep) return
    const stamps = await Promise.all(names.map(async name => {
      try {
        const stats = await stat(join(dir, name))
        return { name, at: stats.mtimeMs }
      } catch {
        return { name, at: 0 }
      }
    }))
    stamps.sort((a, b) => a.at - b.at)
    for (const stamp of stamps.slice(0, names.length - keep)) {
      try { await unlink(join(dir, stamp.name)) } catch { /* gone already */ }
    }
  } catch { /* best effort */ }
}

function isPersistedRecord(value: unknown): value is PersistedTask {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['id'] === 'string' && record['id'].startsWith('task-')
    && (record['cli'] === 'claude' || record['cli'] === 'codex')
    && typeof record['phase'] === 'string'
    && (TERMINAL_PHASES as readonly string[]).includes(record['phase'])
    && typeof record['startedAt'] === 'number'
    && Array.isArray(record['events'])
}

/**
 * Read the persisted history, newest first, bounded to `limit`. Never throws —
 * a missing or corrupt directory just yields whatever could be read.
 */
export async function loadPersistedTasks(dshHome: string, limit: number = 40): Promise<PersistedTask[]> {
  try {
    const dir = tasksDirOf(dshHome)
    const names = (await readdir(dir)).filter(name => name.endsWith('.json'))
    const records: PersistedTask[] = []
    for (const name of names) {
      try {
        const parsed: unknown = JSON.parse(await readFile(join(dir, name), 'utf8'))
        if (isPersistedRecord(parsed)) records.push(parsed)
      } catch { /* one bad file never blocks the rest */ }
    }
    records.sort((a, b) => b.startedAt - a.startedAt)
    return records.slice(0, limit)
  } catch {
    return []
  }
}
