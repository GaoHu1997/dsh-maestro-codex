/** Adapt the scoped Maestro model to the original, unmodified Tasks renderer. */
import { CLI_LABELS } from '../../wire.js'
import type { BoardHost, BoardSessionList } from './data.js'
import { type BoardNode, type BoardJobRow, type BoardSession, type BoardTokenUsage } from './model.js'
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
    const label = row.task === undefined ? row.title : `${CLI_LABELS[row.task.cli]} · ${row.title}`
    byId[row.id] = { id: row.id, displayTitle: label, running: row.running }
    catalogs[row.id] = {
      state: 'ready', error: null,
      entries: row.children.map(child => ({
        id: child.id, createdAt: child.task?.startedAt ?? 0,
        mode: nativeMode(child.mode),
        label: child.task === undefined ? child.title : `${CLI_LABELS[child.task.cli]} · ${child.title}`,
      })),
    }
    if (row.tokens !== undefined || row.timing !== undefined) {
      metrics[row.id] = {
        ...(row.tokens === undefined ? {} : { usage: row.tokens }),
        ...(row.timing === undefined ? {} : { timing: row.timing }),
      }
    }
    if (row.task !== undefined) {
      live[row.id] = { running: row.running, text: `${row.task.phase} · ${row.task.model === '' ? '默认模型' : row.task.model}` }
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
  live: TasksModelInput['live'],
  runs: TasksModelInput['runs'],
  teamMembers: TasksModelInput['teamMembers'] = [],
  teamTasks: NonNullable<TasksModelInput['teamTasks']> = [],
): BoardRendererInput {
  const mergedLive = { ...source.input.live, ...live }
  for (const row of source.byNodeId.values()) {
    if (row.task !== undefined) mergedLive[row.id] = source.input.live[row.id]
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
/** Genuine upstream folding, followed only by CLI/ghost status enrichment. */
export function renderBoardNodes(
  source: BoardRendererInput,
  folding: Pick<TasksModelInput, 'folded' | 'autoFoldSettled' | 'autoFoldBranches' | 'autoFoldIdle' | 'foldedIds' | 'expandedGroups'>,
): TasksNode[] {
  return buildTasksModel({ ...source.input, ...folding }).map((node): TasksNode => {
    if (node.kind === 'workflow') return node
    if (node.kind === 'fold') {
      const errors = node.memberIds.filter(id => source.byNodeId.get(id)?.status === 'failed').length
      return errors === 0 ? node : { ...node, errorCount: errors, doneCount: node.doneCount - errors }
    }
    const row = source.byNodeId.get(node.id)
    if (row === undefined) return node
    const { childAddress: address, ...withoutAddress } = node
    const navigable = row.kind === 'agent' && row.hasSession
    return {
      ...withoutAddress,
      ...(row.task !== undefined || !row.hasSession ? { state: nativeState(row) } : {}),
      ...(row.subtitle === undefined || (row.task === undefined && row.hasSession) ? {} : { title: row.subtitle }),
      ...(row.task === undefined ? {} : { executor: row.task.cli || 'CLI' }),
      ...(navigable && address !== undefined ? { childAddress: address } : {}),
    }
  })
}
export function boardJobRows(rows: readonly BoardJobRow[], list: BoardSessionList): TreeJob[] {
  return orderJobs(rows.map(row => ({
    ...row, ownerTitle: list.byId[row.job.owner ?? row.ownerSessionId]?.displayTitle ?? row.ownerSessionId,
  })))
}
interface NativeNavigation { openSession?(target: string | SidebarSubagentAddress): void }
interface RightColumn { openResource?(address: string, options: { kind: string; preferNewPane: boolean }): void }
export function hasBoardTranscriptAside(ctx: BoardHost): boolean {
  try {
    const tabs = ctx.get('sidebarRightTabs') as { get?(kind: string): unknown } | undefined
    const right = ctx.get('sidebarRight') as RightColumn | undefined
    return tabs?.get?.('subagentchat') !== undefined && typeof right?.openResource === 'function'
  } catch { return false }
}
/** Native address-aware navigation and pre-uiWorkspace host fallback. */
export function jumpBoardNode(ctx: BoardHost, node: TasksAgentNode, place: 'side' | 'main'): boolean {
  const target = node.childAddress ?? (node.parentId === undefined ? node.id : undefined)
  if (target === undefined) return false
  if (place === 'side' && typeof target !== 'string' && hasBoardTranscriptAside(ctx)) {
    const right = ctx.get('sidebarRight') as RightColumn
    const query = new URLSearchParams({ parent: target.parentSessionId, mode: target.mode })
    try {
      right.openResource?.(`dsh-resource://subagentchat/session/${encodeURIComponent(target.childSessionId)}?${query}`, {
        kind: 'subagentchat', preferNewPane: true,
      })
      return true
    } catch { /* Registered tabs can lack a mounted seat; fall back to main. */ }
  }
  for (const name of ['uiWorkspace', 'workspace']) {
    const navigation = ctx.get(name) as NativeNavigation | undefined
    if (typeof navigation?.openSession === 'function') { navigation.openSession(target); return true }
  }
  const sessions = ctx.get('sessions') as {
    open?(id: string): void
    openSubagent?(address: SidebarSubagentAddress): void
  } | undefined
  if (typeof target === 'string' && typeof sessions?.open === 'function') { sessions.open(target); return true }
  if (typeof target !== 'string' && typeof sessions?.openSubagent === 'function') { sessions.openSubagent(target); return true }
  if (typeof target !== 'string' && typeof sessions?.open === 'function') { sessions.open(target.childSessionId); return true }
  return false
}
/** Open a workflow's real member using the same native address transport. */
export function jumpBoardAddress(ctx: BoardHost, address: SidebarSubagentAddress, place: 'side' | 'main' = 'main'): boolean {
  return jumpBoardNode(ctx, { kind: 'agent', id: address.childSessionId, parentId: address.parentSessionId,
    label: address.childSessionId, depth: 1, state: 'idle', activity: 'inactive', current: false,
    childAddress: address }, place)
}
export function boardCliUsage(list: BoardSessionList): Record<string, BoardTokenUsage> {
  const usage: Record<string, BoardTokenUsage> = {}
  for (const projection of Object.values(list.projectionsBySession ?? {})) {
    for (const run of projection?.values.maestroCliUsage?.recent ?? []) {
      usage[run.taskId] = {
        uncachedInputTokens: run.inputTokens, outputTokens: run.outputTokens,
        cacheReadTokens: run.cachedInputTokens, cacheWriteTokens: run.cacheWriteTokens,
      }
    }
  }
  return usage
}
