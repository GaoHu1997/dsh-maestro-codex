/** The original Tasks graph/tree shell, with Maestro CLI rows bridged into it. */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { attachRows, buildSessionTree, collectTreeIds, type BoardCatalogEntry, type BoardTiming, type BoardTokenUsage } from './model.js'
import { jobsFaceOf, sessionsFaceOf, useBoardJobs, useCliDetail, useCliTasks, useNow, useSessionList, type BoardHost, type BoardSessionList } from './data.js'
import { boardCliUsage, boardJobRows, boardRendererInput, boardRootId, hasBoardTranscriptAside, jumpBoardAddress, jumpBoardNode, renderBoardNodes, withBoardNative } from './bridge.js'
import { CliNodePopover, CliOutputWindow } from './cli-detail.js'
import { useBoardNative } from './native.js'
import {
  AgentNodePopover, AnchoredPopover, JobsDrawer, JobOutputWindow, TasksGraph, TasksTree,
  WorkflowNodePopover, TeamBoard, TaskWindow, teamMembersOf, useNarrowViewport, t,
  type Context, type SidebarTeamTaskView, type TasksAgentNode, type TasksFoldNode, type TasksWorkflowNode,
} from './upstream/index.js'
import legacy from './upstream/client/SubagentView.module.css'

export const BOARD_TAB_ID = 'maestro-board'
export const BOARD_TAB_TITLE = '任务看板'
export interface BoardPrefs {
  readonly tasksViewMode: 'graph' | 'tree'
  readonly tasksAutoFoldSettled: boolean
  readonly tasksAutoFoldBranches: boolean
  readonly tasksAutoFoldIdle: boolean
  readonly jobsAutoCollapse: boolean
  readonly mobileDefaultTree: boolean
}
export interface BoardStore {
  getSnapshot(): { readonly prefs: Partial<BoardPrefs> }
  subscribe(listener: () => void): () => void
}
const DEFAULT_PREFS: BoardPrefs = {
  tasksViewMode: 'graph', tasksAutoFoldSettled: true, tasksAutoFoldBranches: true,
  tasksAutoFoldIdle: true, jobsAutoCollapse: true, mobileDefaultTree: true,
}
export interface BoardTabProps {
  readonly ctx: BoardHost
  readonly scope: { readonly sessionId: string; readonly cwd?: string }
  readonly visible?: boolean
  readonly store?: BoardStore
}
type BoardPopover = {
  readonly kind: 'node' | 'workflow' | 'task' | 'cli-output' | 'job'
  readonly id: string
  readonly anchor: HTMLElement
}

/** Keep topology rooted at the main ancestor when opening a child transcript. */
export function BoardTab(props: BoardTabProps): ReactNode {
  const locale = useMemo(() => props.ctx.get('locale') as {
    getSnapshot?(): { active?: string; revision?: number }
    subscribe?(listener: () => void): () => void
  } | undefined, [props.ctx])
  const subscribeLocale = useCallback((listener: () => void) => locale?.subscribe?.(listener) ?? (() => {}), [locale])
  const readLocale = useCallback(() => {
    const snapshot = locale?.getSnapshot?.()
    return `${snapshot?.active ?? ''}:${snapshot?.revision ?? 0}`
  }, [locale])
  useSyncExternalStore(subscribeLocale, readLocale, readLocale)
  const list = useSessionList(props.ctx)
  const rootId = boardRootId(props.scope.sessionId, list.byId)
  return <BoardPage key={rootId} {...props} rootId={rootId} list={list} />
}

function BoardPage(props: BoardTabProps & { readonly rootId: string; readonly list: BoardSessionList }): ReactNode {
  const { ctx, rootId, list, store } = props
  const active = props.visible !== false
  const now = useNow(active)
  const native = useBoardNative(ctx, rootId, active)
  // The original teamProjectionOf fold is precisely this lead-projection lookup.
  const team = useMemo(() => list.projectionsBySession?.[rootId]?.values.agentTeam, [list, rootId])
  const teamMembers = useMemo(() => teamMembersOf(team, native.live, list.byId), [team, native.live, list])
  const catalogs = useMemo(() => {
    const table: Record<string, readonly BoardCatalogEntry[]> = {}
    const tokens: Record<string, BoardTokenUsage> = {}
    const timings: Record<string, BoardTiming> = {}
    for (const [id, projection] of Object.entries(list.projectionsBySession ?? {})) {
      const values = projection?.values
      if (values?.subagentCatalog !== undefined) table[id] = values.subagentCatalog
      if (values?.tokenUsage !== undefined) tokens[id] = values.tokenUsage
      if (values?.subagentTiming !== undefined) timings[id] = values.subagentTiming
    }
    return { table, tokens, timings, usage: boardCliUsage(list) }
  }, [list])
  const sessionTree = useMemo(() => buildSessionTree({
    rootId, sessions: list.byId, catalogs: catalogs.table, tokens: catalogs.tokens, timings: catalogs.timings,
  }), [rootId, list, catalogs])
  const treeIds = useMemo(() => collectTreeIds(sessionTree).filter(id => id === rootId || list.byId[id] !== undefined), [sessionTree, list, rootId])
  const cli = useCliTasks(active, treeIds)
  const attached = useMemo(() => attachRows(sessionTree, { tasks: cli.tasks, usage: catalogs.usage }), [sessionTree, cli.tasks, catalogs.usage])
  const renderer = useMemo(() => withBoardNative(boardRendererInput(attached, props.scope.sessionId), list,
    native.live, native.runs, teamMembers, team?.tasks), [attached, props.scope.sessionId, list, native.live, native.runs, teamMembers, team])
  const subscribePrefs = useCallback((listener: () => void) => store?.subscribe(listener) ?? (() => {}), [store])
  const readPrefs = useCallback(() => store?.getSnapshot().prefs ?? DEFAULT_PREFS, [store])
  const prefs = useSyncExternalStore(subscribePrefs, readPrefs, readPrefs)
  const narrow = useNarrowViewport()
  const [modeOverride, setMode] = useState<'graph' | 'tree' | undefined>()
  const mode = modeOverride ?? (typeof window !== 'undefined' && narrow && (prefs.mobileDefaultTree ?? true) ? 'tree' : prefs.tasksViewMode ?? 'graph')
  const [foldOverride, setFolded] = useState<boolean | undefined>()
  const autoFoldSettled = foldOverride ?? prefs.tasksAutoFoldSettled ?? true
  const autoFoldBranches = foldOverride ?? prefs.tasksAutoFoldBranches ?? true
  const autoFoldIdle = foldOverride ?? prefs.tasksAutoFoldIdle ?? true
  const folded = autoFoldSettled || autoFoldBranches || autoFoldIdle
  const [foldedIds, setFoldedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [teamBoardCollapsed, setTeamBoardCollapsed] = useState(false)
  const [popover, setPopover] = useState<BoardPopover | null>(null)
  const nodes = useMemo(() => renderBoardNodes(renderer, { folded, autoFoldSettled, autoFoldBranches, autoFoldIdle, foldedIds, expandedGroups }),
    [renderer, folded, autoFoldSettled, autoFoldBranches, autoFoldIdle, foldedIds, expandedGroups])
  const jobs = useBoardJobs(ctx, treeIds, active, popover?.kind === 'job' ? popover.id : null)
  const jobsService = useMemo(() => jobsFaceOf(ctx), [ctx])
  const jobRows = useMemo(() => boardJobRows(jobs.rows, list), [jobs.rows, list])
  const selectedRow = popover?.kind === 'job' ? jobRows.find(row => row.job.id === popover.id) : undefined
  const selectedDomain = popover === null ? undefined : renderer.byNodeId.get(popover.id)
  const selectedNode = popover === null ? undefined : nodes.find(node => node.id === popover.id)
  const selectedTask = popover?.kind === 'task' ? team?.tasks.find(task => task.id === popover.id && task.status !== 'deleted') : undefined
  const detail = useCliDetail(popover?.kind === 'cli-output' ? selectedDomain?.task?.id ?? null : null, active, treeIds)
  const asideAvailable = useMemo(() => hasBoardTranscriptAside(ctx), [ctx])
  const closePopover = useCallback(() => { setPopover(null) }, [])
  useEffect(() => {
    if (popover === null) return
    const missing = popover.kind === 'job' ? selectedRow === undefined
      : popover.kind === 'task' ? team === undefined || (popover.id !== '' && selectedTask === undefined)
      : popover.kind === 'cli-output' ? selectedDomain?.task === undefined : selectedNode === undefined
    if (!active || missing) setPopover(null)
  }, [active, popover, selectedRow, selectedDomain, selectedNode, selectedTask, team])

  const onNodeInfo = useCallback((node: TasksAgentNode, anchor: HTMLElement): void => {
    setPopover({ kind: 'node', id: node.id, anchor })
  }, [])
  const onWorkflowInfo = useCallback((node: TasksWorkflowNode, anchor: HTMLElement): void => {
    setPopover({ kind: 'workflow', id: node.id, anchor })
  }, [])
  const onOpenTask = useCallback((id: string, anchor: HTMLElement): void => { setPopover({ kind: 'task', id, anchor }) }, [])
  const openTaskFromBoard = useCallback((task: SidebarTeamTaskView | undefined, anchor: HTMLElement): void => {
    setPopover({ kind: 'task', id: task?.id ?? '', anchor })
  }, [])
  const toggleFold = useCallback(() => {
    if (!folded) setExpandedGroups(new Set())
    setFolded(!folded)
  }, [folded])
  const foldNode = useCallback((node: TasksAgentNode) => { setFoldedIds(current => new Set([...current, node.id])) }, [])
  const expandGroup = useCallback((node: TasksFoldNode) => {
    setExpandedGroups(current => new Set([...current, node.id]))
    setFoldedIds(current => new Set([...current].filter(id => !node.memberIds.includes(id))))
  }, [])
  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next })
  }, [])
  const collapseAll = useCallback(() => {
    setCollapsedIds(new Set(nodes.flatMap(node => node.parentId === undefined ? [] : [node.parentId])))
  }, [nodes])
  const expandAll = useCallback(() => { setCollapsedIds(new Set()) }, [])
  const refresh = useCallback(() => {
    cli.refresh()
    native.refresh()
    const sessions = sessionsFaceOf(ctx) as {
      refreshProjections?(id: string): Promise<void>
      refreshSubagents?(id: string): Promise<void>
    } | undefined
    for (const id of treeIds) {
      const result = sessions?.refreshProjections !== undefined ? sessions.refreshProjections(id) : sessions?.refreshSubagents?.(id)
      void result?.catch(cause => { console.error('[dsh-maestro-codex] refresh catalog failed:', cause) })
    }
  }, [cli.refresh, native.refresh, ctx, treeIds])
  const jump = useCallback((node: TasksAgentNode, place: 'side' | 'main') => {
    const row = renderer.byNodeId.get(node.id)
    if (row !== undefined && (row.kind !== 'agent' || !row.hasSession)) return
    try { if (jumpBoardNode(ctx, node, place)) closePopover() }
    catch (cause) { console.error('[dsh-maestro-codex] open session failed:', cause) }
  }, [renderer, ctx, closePopover])
  const cancelSelected = useCallback(async (): Promise<string | undefined> => {
    const task = selectedDomain?.task
    return task === undefined ? '任务已离开当前会话树' : cli.cancel(task.id)
  }, [selectedDomain, cli.cancel])

  const descendants = [...renderer.byNodeId.values()].filter(row => row.id !== rootId)
  const runningCount = descendants.filter(row => row.task === undefined ? native.live[row.id]?.running ?? row.running : row.running).length
  const countLabel = descendants.length === 0 ? undefined : t(runningCount > 0 ? 'subagentCountRunning' : 'subagentCount', { count: descendants.length, running: runningCount })
  const rootSummary = list.byId[rootId]
  const rootProjection = list.projectionsBySession?.[rootId]
  const readyEmpty = rootProjection?.values.subagentCatalog?.length === 0
    && rootProjection.state !== 'loading' && rootProjection.state !== 'error'
    && descendants.length === 0 && native.runs.length === 0 && teamMembers.length === 0
  const loading = (rootProjection?.values.subagentCatalog === undefined || rootProjection.values.subagentCatalog.length === 0)
    && Object.values(list.byId).some(row => row.parentId === rootId)
  const failedParents = Object.values(renderer.input.catalogs).filter(catalog => catalog?.state === 'error')
  const common = { nodes, folded, loading, onNodeInfo, onWorkflowInfo, onOpenTask,
    onToggleFold: toggleFold, onExpandGroup: expandGroup, mode, onModeChange: setMode }
  return <div className={legacy.subagent} style={{ position: 'relative' }} data-maestro-board-root={rootId}>
    <div className={legacy.subagentHeader}>
      <span className={legacy.subagentHeading}>
        <span className={legacy.subagentTitle}>{t('subagent')}</span>
        {rootSummary?.displayTitle !== undefined && rootSummary.displayTitle !== '' && <>
          <span className={legacy.subagentSep} aria-hidden="true">·</span>
          <span className={legacy.subagentSubject} title={rootSummary.displayTitle}>{rootSummary.displayTitle}</span>
        </>}
      </span>
      {countLabel === undefined ? null : <span className={legacy.subagentCount}>{countLabel}</span>}
      <Button variant="ghost" size="sm" className={legacy.subagentRefresh}
        icon={<IconRefreshOutlineRegular size={14} />} aria-label={t('refresh')} title={t('refresh')} onClick={refresh} />
    </div>
    {team === undefined ? null : <TeamBoard rootId={rootId} members={teamMembers} tasks={team.tasks}
      onOpenTask={openTaskFromBoard} collapsed={teamBoardCollapsed} onToggleCollapsed={() => { setTeamBoardCollapsed(current => !current) }} />}
    {failedParents.length === 0 ? null : <div className={legacy.subagentError}>
      <span>{t('catalogLoadFailed', { count: failedParents.length })}</span>
      <Button variant="outline" size="sm" className={legacy.subagentErrorRetry}
        icon={<IconRefreshOutlineRegular size={14} />} onClick={refresh}>{t('retry')}</Button>
    </div>}
    {cli.error === undefined ? null : <div className={legacy.subagentError} role="alert">
      <span>{cli.error}</span><Button variant="outline" size="sm" className={legacy.subagentErrorRetry}
        icon={<IconRefreshOutlineRegular size={14} />} onClick={refresh}>{t('retry')}</Button>
    </div>}
    {readyEmpty ? <div className={legacy.subagentEmpty}>
      <div>{t('subagentEmpty')}</div><div className={legacy.subagentEmptyHint}>{t('subagentEmptyDesc')}</div>
    </div> : mode === 'graph'
      ? <TasksGraph {...common} rootId={rootId} onFoldNode={foldNode} />
      : <TasksTree {...common} collapsedIds={collapsedIds} onToggleCollapse={toggleCollapse} onCollapseAll={collapseAll} onExpandAll={expandAll} />}
    {jobs.available ? <JobsDrawer rows={jobRows} jobs={jobsService} autoCollapse={prefs.jobsAutoCollapse ?? true}
      observed={selectedRow === undefined ? undefined : jobs.observed[selectedRow.job.id]}
      agentCount={renderer.byNodeId.size} visible={active}
      {...(selectedRow === undefined ? {} : { openJobId: selectedRow.job.id })}
      onOpenOutput={(row, anchor) => { setPopover({ kind: 'job', id: row.job.id, anchor }) }} /> : null}
    {active && popover?.kind === 'task' && team !== undefined ? <TaskWindow key={popover.id || 'create'} rootId={rootId}
      task={selectedTask} members={teamMembers} ctx={ctx as unknown as Context} anchor={popover.anchor} onClose={closePopover} /> : null}
    {active && popover?.kind === 'job' && selectedRow !== undefined ? <JobOutputWindow
      jobs={jobsService} job={selectedRow.job} ownerSessionId={selectedRow.ownerSessionId}
      observed={jobs.observed[selectedRow.job.id]} anchor={popover.anchor} onClose={closePopover} /> : null}
    {active && popover?.kind === 'cli-output' && selectedDomain?.task !== undefined ? <CliOutputWindow
      node={selectedDomain} detail={detail} now={now} anchor={popover.anchor} onClose={closePopover} onCancel={cancelSelected} /> : null}
    {active && popover?.kind === 'workflow' && selectedNode?.kind === 'workflow' ? <AnchoredPopover anchor={popover.anchor} onClose={closePopover}>
      <WorkflowNodePopover node={selectedNode} onJumpMember={address => {
        try { if (jumpBoardAddress(ctx, address)) closePopover() }
        catch (cause) { console.error('[dsh-maestro-codex] open workflow member failed:', cause) }
      }} />
    </AnchoredPopover> : null}
    {active && popover?.kind === 'node' && selectedNode?.kind === 'agent' ? <AnchoredPopover anchor={popover.anchor} onClose={closePopover}>
      {selectedDomain?.task !== undefined
        ? <CliNodePopover node={selectedDomain} now={now} onCancel={cancelSelected} onOutput={() => { setPopover({ ...popover, kind: 'cli-output' }) }} />
        : <AgentNodePopover node={selectedNode} asideAvailable={asideAvailable} onJump={jump} onOpenTask={onOpenTask} onClose={closePopover} />}
    </AnchoredPopover> : null}
  </div>
}
