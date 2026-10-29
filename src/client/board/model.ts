/**
 * 任务看板的数据模型：把三路客户端数据折成同一套行模型。
 *
 * 1. 会话列表 feed（`ctx.sessions.list`）—— 主任务、子代理会话、每会话的
 *    `subagentCatalog` / `tokenUsage` / `subagentTiming` 投影；
 * 2. 后台任务名册（`ctx.jobs`）—— 运行中/已结束的 job，含状态与输出；
 * 3. 本插件的 CLI 任务路由（`/plugin/dsh-maestro-codex/tasks`）。
 *
 * 纯函数、不 import React：单测直接跑模型，渲染层只负责把模型画出来。
 *
 * @module dsh-maestro-codex/client/board/model
 */

import type { MaestroPhase, MaestroTaskSummary } from '../../wire.js'

/** 看板行的统一状态；`idle` 表示“有会话但当前没跑”（主任务空闲）。 */
export type BoardStatus = 'running' | 'queued' | 'done' | 'failed' | 'cancelled' | 'idle'

/** 顶部筛选：全部 / 运行中 / 已结束 / 失败。 */
export type BoardFilter = 'all' | 'running' | 'done' | 'failed'

/** 一行会话（`ctx.sessions.list` 的 `byId` 值，只取看板要用的字段）。 */
export interface BoardSession {
  readonly id: string
  readonly displayTitle: string
  readonly cwd?: string
  readonly origin?: 'subagent'
  /** 耐久直系父会话 id（子代理行才有）。 */
  readonly parentId?: string
  /** 该会话的 agent 是否正在跑。 */
  readonly running?: boolean
}

/**
 * `subagentCatalog` 投影的一行（直系子级）。
 *
 * `mode` 在 DSH 里是四个值：`one-shot` / `continuable` / `unknown`，以及
 * 0.1.7 起外部 CLI 子代理写的 `external`——后者的子级没有本地 Session，
 * 因此会话列表里找不到它，只有这一行目录记录。
 */
export interface BoardCatalogEntry {
  readonly id: string
  readonly createdAt: number
  readonly mode: string
  readonly label?: string
}

/** `tokenUsage` 投影：四个互不重叠的桶。 */
export interface BoardTokenUsage {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** `subagentTiming` 投影：已结算的轮次耗时 + 正在进行的那一轮。 */
export interface BoardTiming {
  readonly settledMs: number
  readonly active?: { readonly since: number; readonly through: number }
}

/** 一行后台任务（`ctx.jobs` 名册里的 `JobView`）。 */
export interface BoardJob {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly owner?: string
  readonly status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  readonly progress?: string
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

/** 名册行 + 它是从哪个会话的 roster 里读到的（kill/observe 需要它）。 */
export interface BoardJobRow {
  readonly ownerSessionId: string
  readonly job: BoardJob
}

/** 任务树的一个节点。 */
export interface BoardNode {
  readonly id: string
  readonly title: string
  /** 根会话还是子代理。 */
  readonly depth: number
  readonly running: boolean
  /** 会话列表里有没有这个 id（external 子代理没有）。 */
  readonly hasSession: boolean
  /** 目录里的模式（one-shot/continuable/unknown/external），未知则 undefined。 */
  readonly mode?: string
  readonly status: BoardStatus
  readonly tokens?: BoardTokenUsage
  readonly timing?: BoardTiming
  readonly children: readonly BoardNode[]
}

/** 构造任务树需要的四张表。 */
export interface TreeInput {
  readonly rootId: string
  readonly sessions: Readonly<Record<string, BoardSession | undefined>>
  readonly catalogs?: Readonly<Record<string, readonly BoardCatalogEntry[] | undefined>>
  readonly tokens?: Readonly<Record<string, BoardTokenUsage | undefined>>
  readonly timings?: Readonly<Record<string, BoardTiming | undefined>>
}

/** 子级的排序键：目录里带创建时间，会话列表里没有，排在后面按标题。 */
interface ChildRef {
  readonly id: string
  readonly createdAt: number
  readonly mode?: string
}

function childrenOf(
  parentId: string,
  sessions: TreeInput['sessions'],
  catalogs: TreeInput['catalogs'],
): ChildRef[] {
  const seen = new Set<string>()
  const refs: ChildRef[] = []
  for (const entry of catalogs?.[parentId] ?? []) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    refs.push({ id: entry.id, createdAt: entry.createdAt, mode: entry.mode })
  }
  // 会话列表里的血缘是权威补充：continuable 子代理再开的子级未必在父目录里
  // （目录只记直系、且 external 行不进会话列表），所以两边取并集。
  const extra = Object.values(sessions)
    .filter((entry): entry is BoardSession => entry !== undefined && entry.parentId === parentId)
    .filter(entry => !seen.has(entry.id))
    .sort((left, right) => left.displayTitle.localeCompare(right.displayTitle, 'zh-Hans-CN'))
  // 目录在前、血缘补充在后：目录带着 createdAt，是更“原生”的顺序。
  for (const entry of extra) {
    seen.add(entry.id)
    refs.push({ id: entry.id, createdAt: 0 })
  }
  return refs
}

function statusOf(session: BoardSession | undefined, isRoot: boolean): BoardStatus {
  if (session?.running === true) return 'running'
  return isRoot ? 'idle' : 'done'
}

/**
 * 从根会话开始把子代理树铺开。
 *
 * external 子代理没有本地 Session，节点仍然生成（`hasSession: false`），
 * 并且**不会**递归它的子级——宿主对 external 行也返回空 children。
 *
 * @param input - 根会话 id 与四张投影表。
 * @returns 根节点（`children` 递归）。
 */
export function buildSessionTree(input: TreeInput): BoardNode {
  const { rootId, sessions, catalogs, tokens, timings } = input
  const rootSession = sessions[rootId]
  const visiting = new Set<string>()

  const build = (id: string, depth: number, session: BoardSession | undefined, mode: string | undefined): BoardNode => {
    const external = mode === 'external' || session === undefined
    /* external 子级不递归：宿主的 listDescendants 对它们返回空 children，
     * 这里保持同一语义，避免把“同名会话”误挂到外部子级下面。已在祖先链上的
     * id 也一并剪掉——血缘数据是宿主写的，但看板不能假设它一定无环。 */
    const childRefs = external
      ? []
      : childrenOf(id, sessions, catalogs).filter(ref => !visiting.has(ref.id))
    visiting.add(id)
    const children = childRefs.map((ref) => {
      const child = sessions[ref.id]
      return build(ref.id, depth + 1, child, ref.mode)
    })
    visiting.delete(id)
    return {
      id,
      title: session?.displayTitle ?? labelOf(id, session, catalogs),
      depth,
      running: session?.running === true,
      hasSession: session !== undefined,
      ...(mode === undefined ? {} : { mode }),
      status: statusOf(session, depth === 0),
      ...(tokens?.[id] === undefined ? {} : { tokens: tokens[id] }),
      ...(timings?.[id] === undefined ? {} : { timing: timings[id] }),
      children,
    }
  }

  const root = build(rootId, 0, rootSession, undefined)
  if (rootSession !== undefined) return root
  // 根会话还没出现在 feed 里（刚打开/正在加载）：仍然给出一张可渲染的根。
  return { ...root, title: '当前会话', status: 'idle' }
}

/** 目录行里带着 label，但 build 拿不到那条 entry，所以按 id 反查一次。 */
function labelOf(id: string, session: BoardSession | undefined, catalogs: TreeInput['catalogs']): string {
  if (session !== undefined) return session.displayTitle
  for (const entries of Object.values(catalogs ?? {})) {
    for (const entry of entries ?? []) {
      if (entry.id === id && entry.label !== undefined && entry.label !== '') return entry.label
    }
  }
  return id
}

/** 把树按先序摊平成带缩进的行。 */
export function flattenTree(node: BoardNode): BoardNode[] {
  const rows: BoardNode[] = [node]
  for (const child of node.children) rows.push(...flattenTree(child))
  return rows
}

/**
 * 按筛选条件剪枝：留下命中节点，以及“有后代命中”的祖先，否则树会断掉。
 *
 * @param node - 子树根。
 * @param filter - 顶部筛选。
 * @returns 剪枝后的树；整棵都不命中时 `undefined`。
 */
export function filterTree(node: BoardNode, filter: BoardFilter): BoardNode | undefined {
  if (filter === 'all') return node
  const children: BoardNode[] = []
  for (const child of node.children) {
    const kept = filterTree(child, filter)
    if (kept !== undefined) children.push(kept)
  }
  const hit = matchesFilter(node.status, filter)
  if (!hit && children.length === 0) return undefined
  if (children.length === node.children.length) return node
  return { ...node, children }
}

/** 树里所有会话 id（含根）：后台任务按这组 id 订阅名册。 */
export function collectTreeIds(node: BoardNode): string[] {
  const ids: string[] = []
  const walk = (entry: BoardNode): void => {
    ids.push(entry.id)
    for (const child of entry.children) walk(child)
  }
  walk(node)
  return ids
}

/** CLI 任务的阶段 → 看板状态。 */
export function cliStatusOf(phase: MaestroPhase): BoardStatus {
  switch (phase) {
    case 'queued': return 'queued'
    case 'running': return 'running'
    case 'done': return 'done'
    case 'failed':
    case 'timeout': return 'failed'
    case 'cancelled': return 'cancelled'
  }
}

/** 后台任务状态 → 看板状态。 */
export function jobStatusOf(status: BoardJob['status']): BoardStatus {
  switch (status) {
    case 'running':
    case 'stopping': return 'running'
    case 'completed': return 'done'
    case 'killed': return 'cancelled'
    case 'failed': return 'failed'
  }
}

/** 筛选命中判定（`done` 也收 `idle`：主任务空闲算“已结束”之外的中性态，仍归入非运行）。 */
export function matchesFilter(status: BoardStatus, filter: BoardFilter): boolean {
  switch (filter) {
    case 'all': return true
    case 'running': return status === 'running' || status === 'queued'
    case 'done': return status === 'done' || status === 'idle' || status === 'cancelled'
    case 'failed': return status === 'failed'
  }
}

/** 一组状态里“在跑”的条数（运行中 + 排队中）。 */
export function countActive(statuses: readonly BoardStatus[]): number {
  return statuses.filter(status => status === 'running' || status === 'queued').length
}

/** 毫秒 → `1h02m` / `3m12s` / `18s`；小于 1 秒给 `<1s`。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return '<1s'
  const total = Math.round(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${String(hours)}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${String(minutes)}m${String(seconds).padStart(2, '0')}s`
  return `${String(seconds)}s`
}

/** 时间戳 → `HH:MM:SS`（本地时区）。 */
export function formatClock(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—'
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** token 数 → `1.2k` / `3.4M`。 */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count < 1000) return String(Math.round(count))
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/** 一行 token 摘要：输入(未缓存) / 输出 / 缓存读。 */
export function tokenSummary(tokens: BoardTokenUsage | undefined): string | undefined {
  if (tokens === undefined) return undefined
  const total = tokens.uncachedInputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
  if (total <= 0) return undefined
  return `入 ${formatTokens(tokens.uncachedInputTokens)} · 出 ${formatTokens(tokens.outputTokens)} · 缓存 ${formatTokens(tokens.cacheReadTokens)}`
}

/** 子代理耗时摘要（`settledMs` 只算已结束轮次，`active` 是正在进行的那一轮）。 */
export function timingSummary(timing: BoardTiming | undefined, now: number): string | undefined {
  if (timing === undefined) return undefined
  if (timing.active !== undefined) {
    return `进行中 ${formatDuration(Math.max(0, now - timing.active.since))}`
  }
  if (timing.settledMs > 0) return `耗时 ${formatDuration(timing.settledMs)}`
  return undefined
}

/** CLI 任务的耗时（进行中用 now 补）。 */
export function taskDuration(task: MaestroTaskSummary, now: number): number {
  const end = task.endedAt ?? now
  return Math.max(0, end - task.startedAt)
}

/** CLI 任务是否还能取消。 */
export function taskCancellable(task: MaestroTaskSummary): boolean {
  return task.phase === 'queued' || task.phase === 'running'
}

/** 后台任务是否还能终止。 */
export function jobLive(job: BoardJob): boolean {
  return job.status === 'running' || job.status === 'stopping'
}
