/**
 * 启动恢复：上一进程没走完的派发会在副作用队列里留下一条 `launch` 行。
 * 这里把每一行还原成 registry 里的 `interrupted` 任务——它既不是 `failed`
 * （没有失败原因，也没拿到结论），也不是 `done`（根本没跑完）。要不要重跑
 * 由人决定：看板把它放在"等你回话"，面板上能看到原来的任务名与目录。
 *
 * 只做标记，不自动重跑：外部世界可能已经被动过一半，自动重来会重复副作用。
 */

import type { EffectRow } from './effects.js'
import type { MaestroCliId, MaestroPhase } from './wire.js'
import type { TaskRegistry } from './task-registry.js'

/** 一条 launch 行还原出来的恢复种子（只保留重建任务所需的字段）。 */
export interface InterruptedSeed {
  taskId: string
  cli: MaestroCliId
  taskName: string
  prompt: string
  cwd: string
  model: string
  sessionId?: string | undefined
  replyTo?: string | undefined
  replySessionIds?: readonly string[] | undefined
  startedAt?: number | undefined
}

/** 恢复任务的说明：写进事件流，人一眼能看出"这不是它自己失败的"。 */
export const INTERRUPTED_NOTE = '上次宿主退出时这个任务还没跑完：没有结论，也没有失败原因。确认后可以重新派发，或传 resume 续接原会话。'

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function seedOf(row: EffectRow): InterruptedSeed | undefined {
  if (row.kind !== 'launch') return undefined
  const value = row.value
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const taskId = textOf(record['taskId']) ?? textOf(row.key)
  const cli = record['cli']
  if (taskId === undefined || (cli !== 'claude' && cli !== 'codex')) return undefined
  return {
    taskId,
    cli,
    taskName: textOf(record['taskName']) ?? 'CLI 任务',
    prompt: typeof record['prompt'] === 'string' ? record['prompt'] : '',
    cwd: textOf(record['cwd']) ?? '',
    model: typeof record['model'] === 'string' ? record['model'] : '',
    ...(textOf(record['sessionId']) === undefined ? {} : { sessionId: textOf(record['sessionId']) }),
    ...(textOf(record['replyTo']) === undefined ? {} : { replyTo: textOf(record['replyTo']) }),
    ...(Array.isArray(record['replySessionIds']) ? { replySessionIds: record['replySessionIds'].filter((id): id is string => typeof id === 'string') } : {}),
    ...(typeof record['startedAt'] === 'number' ? { startedAt: record['startedAt'] } : {}),
  }
}

/** 从队列行里挑出可恢复的种子（坏行直接跳过，恢复是 best effort）。 */
export function seedsOf(rows: readonly EffectRow[]): InterruptedSeed[] {
  const seeds: InterruptedSeed[] = []
  for (const row of rows) {
    const seed = seedOf(row)
    if (seed !== undefined) seeds.push(seed)
  }
  return seeds
}

/**
 * 把种子写成 `interrupted` 任务；已存在的 id 跳过（持久化历史可能已经
 * 先一步恢复了它）。返回真正新建的 id 列表，调用方据此清掉队列行。
 */
export function restoreInterrupted(registry: TaskRegistry, rows: readonly EffectRow[]): string[] {
  const restored: string[] = []
  for (const seed of seedsOf(rows)) {
    if (registry.get(seed.taskId) !== undefined) continue
    const phase: MaestroPhase = 'interrupted'
    registry.create({
      id: seed.taskId,
      cli: seed.cli,
      title: seed.taskName,
      prompt: seed.prompt,
      cwd: seed.cwd,
      model: seed.model,
      phase,
      note: INTERRUPTED_NOTE,
      ...(seed.sessionId === undefined ? {} : { sessionId: seed.sessionId }),
      ...(seed.replyTo === undefined ? {} : { replyTo: seed.replyTo }),
      ...(seed.replySessionIds === undefined ? {} : { replySessionIds: seed.replySessionIds }),
    })
    restored.push(seed.taskId)
  }
  return restored
}
