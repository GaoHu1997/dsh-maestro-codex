/** Adapt the scoped Maestro model to the original, unmodified Tasks renderer. */
import type { MaestroTaskSummary } from '../../wire.js'
import type { BoardHost, BoardSessionList } from './data.js'
import { interruptedStateLabel } from './copy.js'
import { type BoardNode, type BoardJobRow, type BoardSession, type BoardTokenUsage } from './model.js'
import { cliSessionAddress } from './session-tab.js'
import {
  buildTasksModel, orderJobs,
  type TasksAgentNode, type TasksModelInput, type TasksNode, type TasksNodeState,
  type SidebarSubagentAddress, type TreeJob,
} from './upstream/index.js'

/** Root at the durable ancestor while retaining the current-node marker. */
export function boardRootId(currentId: string, sessions: Readonly<Record<string, BoardSession | undefined>>): string {
  let id = currentId
  const seen = new Set<string>([id])
  while (true) {
    const parent = sessions[id]?.parentId
    if (parent === undefined || parent === '' || seen.has(parent) || sessions[parent] === undefined) return id
    seen.add(parent)
    id = parent
  }
}
function nativeMode(mode: string | undefined): SidebarSubagentAddress['mode'] {
  return mode === 'one-shot' || mode === 'continuable' ? mode : 'unknown'
}
function nativeState(node: BoardNode): TasksNodeState {
  switch (node.status) {
    case 'running':
    case 'queued': return 'running'
    case 'failed': return 'error'
    case 'idle': return 'idle'
    case 'done':
    case 'cancelled': return 'done'
  }
}
export interface BoardRendererInput {
  readonly input: TasksModelInput
  readonly byNodeId: ReadonlyMap<string, BoardNode>
}
/**
 * Reconstruct upstream catalog input from our already-attached tree. This keeps
 * attachRows' owner isolation and native-external deduplication authoritative,
 * while buildTasksModel owns preorder, group folds and current-ancestor guards.
 * CLI pseudo-catalog ids never become actual session navigation targets.
 */
export function boardRendererInput(tree: BoardNode, currentSessionId: string): BoardRendererInput {
  const byId: Record<string, TasksModelInput['byId'][string]> = {}
  const catalogs: Record<string, TasksModelInput['catalogs'][string]> = {}
  const metrics: Record<string, NonNullable<TasksModelInput['metrics']>[string]> = {}
  const live: Record<string, NonNullable<TasksModelInput['live'][string]>> = {}
  const domain = new Map<string, BoardNode>()
  const pending = [tree]
  while (pending.length > 0) {
    const row = pending.pop()
    if (row === undefined || domain.has(row.id)) continue
    domain.set(row.id, row)
    // 节点名就是任务名：CLI 行的 executor 徽标（renderBoardNodes 的 executor
    // 字段）已经标识了来源 CLI，名字里不再重复 `claude cli · ` 前缀；external
    // 幽灵行没有徽标，靠目录 label 里的 `cli · ` 前缀识别（见 tool.ts）。
    byId[row.id] = { id: row.id, displayTitle: row.title, running: row.running }
    catalogs[row.id] = {
      state: 'ready', error: null,
      entries: row.children.map(child => ({ id: child.id, createdAt: child.task?.startedAt ?? 0,
        mode: nativeMode(child.mode), label: child.title })),
    }
    if (row.tokens !== undefined || row.timing !== undefined) {
      metrics[row.id] = {
        ...(row.tokens === undefined ? {} : { usage: row.tokens }),
        ...(row.timing === undefined ? {} : { timing: row.timing }),
      }
    }
    if (row.task !== undefined) {
      // 卡片尾部的描述行：截断的完整输入（subtitle = inputPreview）；没有
      // 预览的旧任务退回「阶段 · 模型」。
      live[row.id] = { running: row.running,
        text: row.subtitle ?? `${row.task.phase} · ${row.task.model === '' ? '默认模型' : row.task.model}` }
    } else if (row.running && row.id !== tree.id) {
      // Keep a newly announced running child visible until the native live feed arrives.
      live[row.id] = { running: true }
    }
    for (let index = row.children.length - 1; index >= 0; index -= 1) {
      const child = row.children[index]
      if (child !== undefined) pending.push(child)
    }
  }
  return {
    byNodeId: domain,
    input: { byId, catalogs, metrics, live, rootId: tree.id, currentSessionId, runs: [], teamMembers: [], folded: false },
  }
}
/** Native facts remain authoritative; only CLI rows override the native live map. */
export function withBoardNative(
  source: BoardRendererInput,
  list: BoardSessionList,
  live: TasksModelInput['live'] = {},
  runs: TasksModelInput['runs'] = [],
  teamMembers: TasksModelInput['teamMembers'] = [],
  teamTasks: NonNullable<TasksModelInput['teamTasks']> = [],
): BoardRendererInput {
  const mergedLive = { ...source.input.live, ...live }
  for (const row of source.byNodeId.values()) {
    if (row.task !== undefined) mergedLive[row.id] = source.input.live[row.id]
  }
  /* 描述行（需求「把输入截断放到节点中间展示」）：标题是目录 label 的行，
   * 把降级的 displayTitle（截断的对话首句 / 输入预览）填进卡片尾部——但只在
   * 原生 live 没有文本可显示时，正在流式的真实文本永远优先。 */
  for (const row of source.byNodeId.values()) {
    if (row.task !== undefined || row.subtitle === undefined || row.id === source.input.rootId) continue
    const view = mergedLive[row.id]
    if (view?.text !== undefined) continue
    mergedLive[row.id] = { ...(view ?? {}), running: view?.running ?? row.running, text: row.subtitle }
  }
  const catalogs: Record<string, TasksModelInput['catalogs'][string]> = { ...source.input.catalogs }
  for (const [id, snapshot] of Object.entries(list.projectionsBySession ?? {})) {
    const catalog = catalogs[id]
    if (catalog === undefined || snapshot === undefined) continue
    const state = snapshot.state === 'idle'
      ? snapshot.values.subagentCatalog === undefined ? 'loading' : 'ready'
      : snapshot.state ?? 'ready'
    catalogs[id] = { ...catalog, state, error: snapshot.error ?? null }
  }
  return {
    byNodeId: source.byNodeId,
    input: { ...source.input, byId: { ...list.byId, ...source.input.byId }, catalogs,
      live: mergedLive, runs, teamMembers, teamTasks },
  }
}
/** Scoped CLI states enter original fold derivation; remaining enrichment follows it. */

export function renderBoardNodes(
  source: BoardRendererInput,
  folding: Pick<TasksModelInput, 'folded' | 'autoFoldSettled' | 'autoFoldBranches' | 'autoFoldIdle' | 'foldedIds' | 'expandedGroups'>,
): TasksNode[] {
  const cliStates = new Map<string, TasksNodeState>()
  for (const row of source.byNodeId.values()) {
    if (row.task?.phase === 'interrupted') cliStates.set(row.id, 'idle')
  }
  return buildTasksModel({ ...source.input, ...folding, cliStates }).map((node): TasksNode => {
    if (node.kind === 'workflow') return node
    if (node.kind === 'fold') {
      const errors = node.memberIds.filter(id => source.byNodeId.get(id)?.status === 'failed').length
      return errors === 0 ? node : { ...node, errorCount: errors, doneCount: node.doneCount - errors }
    }
    const row = source.byNodeId.get(node.id)
    if (row === undefined) return node
    // 「可续接 / 一次性」模式词按需求从看板移除：渲染节点上的 mode 整体剥掉，
    // 卡片 chip、meta 行与详情浮层的「模式」行同源消失；childAddress 内的
    // mode 不受影响，跳转语义不变。
    const { childAddress: address, mode: _mode, ...withoutMode } = node
    const navigable = row.kind === 'agent' && row.hasSession
    // 中断的 CLI 任务：上游四态挑不出「已中断」，占 idle 位——它不是进行中
    // （不转圈、不扫光），也不进 settled 折叠组（等人处理的任务不能藏起来）；
    // 状态词由 stateText 补上，卡片与详情浮层从此同词。
    const interrupted = row.task?.phase === 'interrupted'
    return {
      ...withoutMode,
      ...(row.task !== undefined || !row.hasSession
        ? { state: interrupted ? 'idle' : nativeState(row) }
        : {}),
      ...(interrupted ? { stateText: interruptedStateLabel() } : {}),
      ...(row.subtitle === undefined || (row.task === undefined && row.hasSession) ? {} : { title: row.subtitle }),
      // 右上角来源标识：CLI 行沿用 executor（claude/codex）；dsh 原生子智能体
      // 借同一徽标槽位显示 DSH（主智能体、external 幽灵行、折叠组不显示）。
      // 品牌色与 logo 由 accent.ts 样式表按 data-cli-executor 分配。
      ...(row.task !== undefined
        ? { executor: row.task.cli || 'CLI' }
        : row.hasSession && row.depth > 0
          ? { executor: 'DSH' }
          : {}),
      // 注意：返工链长度（replyCounts）不再渲染成「已续接 N 轮」徽标，返回时
      // 也不带 phase 槽——卡片上不标注续接历史。
      ...(navigable && address !== undefined ? { childAddress: address } : {}),
    }
  })
}
export function boardJobRows(rows: readonly BoardJobRow[], list: BoardSessionList): TreeJob[] {
  return orderJobs(rows.map(row => ({
    ...row, ownerTitle: list.byId[row.job.owner ?? row.ownerSessionId]?.displayTitle ?? row.ownerSessionId,
  })))
}
/**
 * 一个展开折叠组的可见成员 id（done 组 = done/error，idle 组 = idle）。
 *
 * 组展开后组卡片消失，「再收起」就落在成员卡片自己的收起箭头上：把这份
 * id 重新塞回手动折叠集、并删掉组的展开记录，整组就回到收起态（见 Board
 * 的 foldNode）。运行中/当前的卡片不在组里，天然不会被卷进来。
 */
export function groupMemberIds(nodes: readonly TasksNode[], node: TasksAgentNode): readonly string[] {
  return nodes
    .filter(child => child.kind === 'agent' && child.parentId === node.parentId
      && (node.state === 'idle' ? child.state === 'idle' : child.state === 'done' || child.state === 'error'))
    .map(child => child.id)
}
interface RightColumn { openResource?(address: string, options: { kind: string; preferNewPane: boolean }): void }
export function hasBoardTranscriptAside(ctx: BoardHost): boolean {
  try {
    const tabs = ctx.get('sidebarRightTabs') as { get?(kind: string): unknown } | undefined
    const right = ctx.get('sidebarRight') as RightColumn | undefined
    return tabs?.get?.('subagentchat') !== undefined && typeof right?.openResource === 'function'
  } catch { return false }
}
/**
 * 在侧边（右栏原生 `subagentchat`）打开一颗节点的子会话转录——看板的跳转
 * **只有这一条路**：任何入口都不得把主窗口从用户当前对话上引开，所以没有
 * 主窗口兜底，宿主没有侧栏座位（`hasBoardTranscriptAside` 为假）时就是无处
 * 可开、返回 false。
 */
export function jumpBoardNode(ctx: BoardHost, node: TasksAgentNode): boolean {
  const target = node.childAddress
  if (target === undefined || typeof target === 'string' || !hasBoardTranscriptAside(ctx)) return false
  const right = ctx.get('sidebarRight') as RightColumn
  const query = new URLSearchParams({ parent: target.parentSessionId, mode: target.mode })
  try {
    right.openResource?.(`dsh-resource://subagentchat/session/${encodeURIComponent(target.childSessionId)}?${query}`, {
      kind: 'subagentchat', preferNewPane: true,
    })
    return true
  } catch { /* Registered tabs can lack a mounted seat; nothing else to open into. */ }
  return false
}
/** Open a workflow's real member using the same native address transport. */
export function jumpBoardAddress(ctx: BoardHost, address: SidebarSubagentAddress): boolean {
  return jumpBoardNode(ctx, { kind: 'agent', id: address.childSessionId, parentId: address.parentSessionId,
    label: address.childSessionId, depth: 1, state: 'idle', activity: 'inactive', current: false,
    childAddress: address })
}
/** The CLI session tab kind + openResource face are both present (our own registration live). */
export function hasBoardCliSessionAside(ctx: BoardHost): boolean {
  try {
    const tabs = ctx.get('sidebarRightTabs') as { get?(kind: string): unknown } | undefined
    const right = ctx.get('sidebarRight') as RightColumn | undefined
    return tabs?.get?.('maestro-cli-chat') !== undefined && typeof right?.openResource === 'function'
  } catch { return false }
}
/**
 * 在侧边（右栏 `maestro-cli-chat`）打开一个 CLI 任务的会话页——CLI 子代理的
 * 「查看会话」从此与 dsh 子代理同一条侧边通道。宿主没有右栏 tab 面或我们的
 * 类型没注册上时返回 false，调用方回落面板内覆盖层。
 */
export function jumpBoardCliSession(ctx: BoardHost, task: MaestroTaskSummary, sessionIds?: readonly string[]): boolean {
  if (!hasBoardCliSessionAside(ctx)) return false
  const right = ctx.get('sidebarRight') as RightColumn
  try {
    right.openResource?.(cliSessionAddress({
      taskId: task.id, cli: task.cli, title: task.title,
      ...(sessionIds === undefined ? {} : { sessionIds }),
    }), {
      kind: 'maestro-cli-chat', preferNewPane: true,
    })
    return true
  } catch { /* Registered tabs can lack a mounted seat; the caller falls back. */ }
  return false
}
export function boardCliUsage(list: BoardSessionList): Record<string, BoardTokenUsage> {
  const usage: Record<string, BoardTokenUsage> = {}
  for (const projection of Object.values(list.projectionsBySession ?? {})) {
    for (const run of projection?.values.maestroCliUsage?.recent ?? []) {
      // The upstream graph contract cannot represent unknown buckets. Omit
      // its numeric projection instead of manufacturing zero/partial totals;
      // the CLI task details retain the original nullable usage record.
      if (run.inputTokens === null || run.outputTokens === null || run.cachedInputTokens === null || run.cacheWriteTokens === null) continue
      usage[run.taskId] = {
        uncachedInputTokens: run.inputTokens, outputTokens: run.outputTokens,
        cacheReadTokens: run.cachedInputTokens, cacheWriteTokens: run.cacheWriteTokens,
      }
    }
  }
  return usage
}
