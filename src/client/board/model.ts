/**
 * 任务看板的数据模型：把三路客户端数据折成同一套行模型。
 *
 * 1. 会话列表 feed（`ctx.sessions.list`）—— 主任务、子代理会话、每会话的
 *    `subagentCatalog` / `tokenUsage` / `subagentTiming` 投影；
 * 2. 后台任务名册（`ctx.jobs`）—— 运行中/已结束的 job，含状态与输出；
 * 3. 本插件的 CLI 任务路由（`/plugin/dsh-maestro-codex/tasks`）。
 *
 * 会话树是骨架，CLI 任务按归属会话挂成那个会话的子节点（`attachRows`），所以
 * 「某个子代理派出去的 CLI 子代理」就长在它下面，而不是另起一段列表。后台
 * 作业**不进树**：渲染层把它们单独画在底部的固定高度任务列表里（见 Board）。
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

/** 节点种类：会话/子代理、CLI 子代理任务、后台作业、折叠组。 */
export type BoardNodeKind = 'agent' | 'cli' | 'job' | 'fold'

/** 任务树的一个节点。 */
export interface BoardNode {
  readonly kind: BoardNodeKind
  readonly id: string
  /** 一行标题：子代理的任务描述 / 会话标题 / CLI 任务名 / 作业名。 */
  readonly title: string
  /**
   * 标题的补充说明（卡片第二行）。
   *
   * 子代理的目录 label 是「这个子代理去做什么」，displayTitle 往往是被截断的
   * 对话首句；两者都有时把 label 当标题、displayTitle 降到这里当描述。
   */
  readonly subtitle?: string
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
  /** CLI 子代理任务（`kind === 'cli'` 时才有）。 */
  readonly task?: MaestroTaskSummary
  /** 后台作业行（`kind === 'job'` 时才有）。 */
  readonly jobRow?: BoardJobRow
  /** 折进这一行的成员（`kind === 'fold'` 时才有）。 */
  readonly members?: readonly BoardNode[]
  /** 折叠组挂在哪个父节点下（`kind === 'fold'` 时才有）。 */
  readonly foldParent?: string
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

/**
 * 一次扫描把「父 → 直系子级」索引建好，供整棵树的铺开共用。
 *
 * 逐节点全量扫会话表找子级是 O(会话数²)——会话上百后看板每 2.5s 的重建就
 * 开始发热了。语义保持原样：目录在前（去重）、血缘按标题序补后、两边去重。
 */
function childIndex(
  sessions: TreeInput['sessions'],
  catalogs: TreeInput['catalogs'],
): ReadonlyMap<string, readonly ChildRef[]> {
  const buckets = new Map<string, { refs: ChildRef[]; seen: Set<string> }>()
  const bucketOf = (parentId: string): { refs: ChildRef[]; seen: Set<string> } => {
    const bucket = buckets.get(parentId)
    if (bucket !== undefined) return bucket
    const fresh = { refs: [] as ChildRef[], seen: new Set<string>() }
    buckets.set(parentId, fresh)
    return fresh
  }
  for (const [parentId, entries] of Object.entries(catalogs ?? {})) {
    const bucket = bucketOf(parentId)
    for (const entry of entries ?? []) {
      if (bucket.seen.has(entry.id)) continue
      bucket.seen.add(entry.id)
      bucket.refs.push({ id: entry.id, createdAt: entry.createdAt, mode: entry.mode })
    }
  }
  const extra: Array<{ parentId: string; session: BoardSession }> = []
  for (const entry of Object.values(sessions)) {
    if (entry === undefined || entry.parentId === undefined || entry.parentId === '') continue
    extra.push({ parentId: entry.parentId, session: entry })
  }
  extra.sort((left, right) => left.session.displayTitle.localeCompare(right.session.displayTitle, 'zh-Hans-CN'))
  for (const { parentId, session } of extra) {
    const bucket = bucketOf(parentId)
    if (bucket.seen.has(session.id)) continue
    bucket.seen.add(session.id)
    bucket.refs.push({ id: session.id, createdAt: 0 })
  }
  return new Map([...buckets].map(([parentId, bucket]) => [parentId, bucket.refs]))
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
  const childrenByParent = childIndex(sessions, catalogs)
  // 目录行里带着 label，但 build 拿不到那条 entry；一次反查建好索引，
  // external 幽灵节点取名不再每个节点扫一遍全部目录。
  const labelById = new Map<string, string>()
  for (const entries of Object.values(catalogs ?? {})) {
    for (const entry of entries ?? []) {
      if ((entry.label ?? '') !== '' && !labelById.has(entry.id)) labelById.set(entry.id, entry.label ?? '')
    }
  }

  const build = (id: string, depth: number, session: BoardSession | undefined, mode: string | undefined): BoardNode => {
    const external = mode === 'external' || session === undefined
    /* external 子级不递归：宿主的 listDescendants 对它们返回空 children，
     * 这里保持同一语义，避免把“同名会话”误挂到外部子级下面。已在祖先链上的
     * id 也一并剪掉——血缘数据是宿主写的，但看板不能假设它一定无环。 */
    const childRefs = external
      ? []
      : (childrenByParent.get(id) ?? []).filter(ref => !visiting.has(ref.id))
    visiting.add(id)
    const children = childRefs.map((ref) => {
      const child = sessions[ref.id]
      return build(ref.id, depth + 1, child, ref.mode)
    })
    visiting.delete(id)
    /* 子代理节点优先用目录 label：那是宿主在创建时拿到的“任务描述”
     * （工具参数 description），比被截断的对话首句更像一个任务名。根会话
     * 没有目录行，继续用 displayTitle。两者都有时 displayTitle 退成描述。 */
    const label = labelById.get(id)
    const title = label ?? session?.displayTitle ?? id
    // 目录里的 label 是任务描述，displayTitle 只是对话开头；两者相同就别重复。
    const subtitle = label !== undefined && session !== undefined && session.displayTitle !== label
      ? session.displayTitle
      : undefined
    return {
      kind: 'agent',
      id,
      title,
      ...(subtitle === undefined || subtitle === '' ? {} : { subtitle }),
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

/** 把树按先序摊平成带缩进的行（`depth` 按实际位置重算：挂上来的行原本没有深度）。 */
export function flattenTree(node: BoardNode): BoardNode[] {
  const rows: BoardNode[] = []
  const walk = (entry: BoardNode, depth: number): void => {
    rows.push(entry.depth === depth ? entry : { ...entry, depth })
    for (const child of entry.children) walk(child, depth + 1)
  }
  walk(node, 0)
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

/**
 * 树里所有**会话** id（含根）。
 *
 * 只收 `kind === 'agent'`：挂上来的 CLI/作业节点 id 带前缀，不是会话 id，
 * 混进来会让 `watchRows` 与 CLI 任务的会话过滤都查错。
 */
export function collectTreeIds(node: BoardNode): string[] {
  const ids: string[] = []
  const walk = (entry: BoardNode): void => {
    if (entry.kind === 'agent') ids.push(entry.id)
    for (const child of entry.children) walk(child)
  }
  walk(node)
  return ids
}

/** 折叠组节点的 id 前缀。 */
export const FOLD_NODE_PREFIX = 'fold:'

/** 结束态：已经跑完的节点，可以在兄弟层收成一行。 */
function isSettled(node: BoardNode): boolean {
  return node.status === 'done' || node.status === 'cancelled' || node.status === 'idle'
}

/**
 * 整棵子树都结束了吗。
 *
 * 只看自己不够：一个会话可能自己已结束、底下还挂着在跑的子代理或 CLI 任务，
 * 收起来就把活的东西藏了——那种节点必须留在明面上。
 */
function quiet(node: BoardNode): boolean {
  return isSettled(node) && node.children.every(child => quiet(child))
}

/** 一个折叠组（把同层已结束的兄弟收成一行）。 */
function foldNode(id: string, parentId: string, members: readonly BoardNode[]): BoardNode {
  const first = members[0]
  const rest = members.length - 1
  return {
    kind: 'fold',
    id,
    /* 折叠组不是一个“任务”，标题用组内第一件事，数量放进副标题/徽标：
     * 截图里的折叠卡就是「✓ 1 已完成 / 复核同步配置的保存边界」。 */
    title: first?.title ?? `已完成 ${String(members.length)}`,
    ...(rest > 0
      ? { subtitle: `还有 ${String(rest)} 个已完成节点` }
      : first?.subtitle === undefined || first.subtitle === ''
        ? {}
        : { subtitle: first.subtitle }),
    depth: 0,
    running: false,
    hasSession: false,
    status: 'done',
    members,
    foldParent: parentId,
    // 默认收起；展开由 expandFolds 把 members 塞进 children。
    children: [],
  }
}

/** 折叠选项。 */
export interface FoldOptions {
  /** 至少几个已结束的兄弟才值得收起来（默认 2：只剩一个时不收，收了反而多点一次）。 */
  readonly minMembers?: number
}

/**
 * 把同层**已结束**的兄弟节点收成一个折叠组，运行中的照旧平铺。
 *
 * 层里节点一多（一次跑十几个子代理），已完成的会淹没还在跑的那几个；收成
 * 一行「已完成 N」后，视线就落在活着的事情上。失败的不收——出错要一眼看见。
 *
 * 折叠组本身是个节点（`kind === 'fold'`），`members` 存着被收起来的原节点，
 * 默认 `children` 为空（收起）。要展开就再过一遍 `expandFolds`。
 *
 * @param node - 子树根。
 * @param options - 阈值。
 * @returns 新树；没有任何分组被折时原样返回 `node`（引用稳定）。
 */
export function foldFinished(node: BoardNode, options: FoldOptions = {}): BoardNode {
  const min = options.minMembers ?? 2
  let touched = false
  const walk = (entry: BoardNode): BoardNode => {
    const children = entry.children.map(walk)
    const live: BoardNode[] = []
    const settled: BoardNode[] = []
    for (const child of children) {
      if (quiet(child)) settled.push(child)
      else live.push(child)
    }
    const next = settled.length >= min
      ? [...live, foldNode(`${FOLD_NODE_PREFIX}${entry.id}`, entry.id, settled)]
      : [...live, ...settled]
    const unchanged = next.length === entry.children.length
      && next.every((child, index) => child === entry.children[index])
    if (unchanged) return entry
    touched = true
    return { ...entry, children: next }
  }
  const result = walk(node)
  return touched ? result : node
}

/**
 * 把 `expanded` 里的折叠组摊开成它的成员。
 *
 * 分组在 `foldFinished` 里一次算好，展开只是把 `members` 塞回 `children`——
 * 单独一趟，避免每次点开都重算整棵树的分组。
 *
 * @param node - 子树根。
 * @param expanded - 要展开的折叠组 id。
 * @returns 新树；没有折叠组需要展开时原样返回 `node`（引用稳定）。
 */
export function expandFolds(node: BoardNode, expanded: ReadonlySet<string>): BoardNode {
  if (node.kind === 'fold') {
    if (!expanded.has(node.id)) return node
    const members = node.members ?? []
    if (members.length === 0 || node.children.length > 0) return node
    return { ...node, children: members }
  }
  let touched = false
  const children = node.children.map((child) => {
    const next = expandFolds(child, expanded)
    if (next !== child) touched = true
    return next
  })
  return touched ? { ...node, children } : node
}

/** CLI 任务节点的 id 前缀（避免与会话 id 撞）。 */
export const CLI_NODE_PREFIX = 'cli:'

/** 后台作业节点的 id 前缀。 */
export const JOB_NODE_PREFIX = 'job:'

/** 挂载到树上的外部行（CLI 任务）。 */
export interface AttachInput {
  readonly tasks?: readonly MaestroTaskSummary[]
  /**
   * 任务 id → 已结算的 token 用量。
   *
   * CLI 不是本地会话，宿主的 `tokenUsage` 投影里没有它；这些数字来自本插件
   * 自己的 `maestroCliUsage` 投影（`src/usage.ts`），由看板按 taskId 挂上来。
   * 只覆盖已经结束并上报过用量的任务，运行中的行没有这一项。
   */
  readonly usage?: Readonly<Record<string, BoardTokenUsage | undefined>>
}

/**
 * 把 CLI 子代理任务挂进会话树。
 *
 * 挂载点是任务的**归属会话**（`task.sessionId`）：CLI 子代理是某个会话派出
 * 去的，所以它天然是那个会话的子级，而不是旁边另开一段列表——这正是「树里
 * 能看到 CLI 子代理」的关键。后台作业不在这里挂（渲染层单独成面板）。
 *
 * 没有归属会话的任务（`sessionId === undefined`，比如配置页手工触发）挂在根上；
 * 归属会话不在树上时丢弃（树外的会话不属于这个看板的视野）。
 *
 * @param root - 会话树根。
 * @param input - 要挂上去的 CLI 任务。
 * @returns 新树；没有可挂行时原样返回 `root`（引用稳定）。
 */
export function attachRows(root: BoardNode, input: AttachInput): BoardNode {
  const tasks = input.tasks ?? []
  if (tasks.length === 0) return root

  const known = new Set(collectTreeIds(root))
  const taskNodes = new Map<string, BoardNode[]>()
  for (const task of tasks) {
    const owner = task.sessionId === undefined || task.sessionId === '' ? root.id : task.sessionId
    if (!known.has(owner)) continue
    const bucket = taskNodes.get(owner) ?? []
    bucket.push(cliNode(task, input.usage?.[task.id]))
    taskNodes.set(owner, bucket)
  }
  if (taskNodes.size === 0) return root

  const walk = (node: BoardNode): BoardNode => {
    const extra = taskNodes.get(node.id)
    // Native catalog mirrors use cli-${taskId}; older rows used taskId itself.
    // Match only this owner's direct, session-less external rows, never sessions.
    const mirroredIds = new Set<string>()
    for (const row of extra ?? []) {
      if (row.task === undefined) continue
      mirroredIds.add(row.task.id)
      mirroredIds.add(`cli-${row.task.id}`)
    }
    const children = node.children.filter(child =>
      child.mode !== 'external' || child.hasSession || !mirroredIds.has(child.id),
    ).map(walk)
    if (extra === undefined && children.every((child, index) => child === node.children[index])) return node
    return { ...node, children: [...children, ...(extra ?? [])] }
  }
  return walk(root)
}

/** 一个 CLI 子代理任务节点（叶子：它的日志在行内展开）。 */
export function cliNode(task: MaestroTaskSummary, tokens?: BoardTokenUsage): BoardNode {
  tokens = task.usage ?? tokens
  return {
    kind: 'cli',
    id: `${CLI_NODE_PREFIX}${task.id}`,
    title: task.title,
    depth: 0,
    running: task.phase === 'running' || task.phase === 'queued',
    hasSession: false,
    status: cliStatusOf(task.phase),
    ...(tokens === undefined ? {} : { tokens }),
    task,
    children: [],
  }
}

/**
 * 一个后台作业节点（叶子）。
 *
 * 作业不挂会话树——渲染层把它们单独画在底部的固定高度面板里；节点模型仍然
 * 共用 `BoardNode`，这样详情浮层、状态点、元信息行都不用另写一套。
 */
export function jobNode(row: BoardJobRow): BoardNode {
  return {
    kind: 'job',
    id: `${JOB_NODE_PREFIX}${row.ownerSessionId}:${row.job.id}`,
    title: row.job.label,
    depth: 0,
    running: jobLive(row.job),
    hasSession: false,
    status: jobStatusOf(row.job.status),
    jobRow: row,
    children: [],
  }
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
