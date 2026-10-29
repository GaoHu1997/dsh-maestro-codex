/**
 * 任务看板的数据层：订阅三路实时源，产出模型层要的输入。
 *
 * 全部走**客户端**服务，不新增宿主路由：
 * - `ctx.sessions.list` 是宿主推送的会话列表 + 每会话投影（catalog/token/timing）；
 * - `ctx.jobs` 是宿主的客户端作业服务（名册按 owner 会话授权，`watchRows`
 *   维持一个会话的名册，`observe` 读输出而不移动模型的消费游标，`kill` 终止）；
 * - CLI 任务用本插件已有的 `/plugin/dsh-maestro-codex/tasks` 路由轮询。
 *
 * 每个订阅都按 `active` 开合：tab 不可见时停轮询、退订名册，避免后台空转。
 *
 * @module dsh-maestro-codex/client/board/data
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { cancelTask, fetchTaskDetail, fetchTasks } from '../api.js'
import {
  TERMINAL_PHASES,
  type MaestroTaskDetail,
  type MaestroTaskEvent,
  type MaestroTaskSummary,
} from '../../wire.js'
import type {
  BoardCatalogEntry, BoardJob, BoardJobRow, BoardSession, BoardTiming, BoardTokenUsage,
} from './model.js'

/** CLI 任务列表的轮询间隔（毫秒）。 */
const TASKS_POLL_MS = 2500

/** 展开的任务日志轮询间隔（更密：日志是滚动看的）。 */
const DETAIL_POLL_MS = 900

/** 一个任务日志在内存里保留的最大行数。 */
const LOG_CAP = 600

/** 会话列表 feed 的一行（`ctx.sessions.list.getSnapshot()` 的 `byId` 值）。 */
export interface BoardSessionList {
  readonly byId: Record<string, BoardSession>
  readonly projectionsBySession?: Readonly<Record<string, BoardProjectionSnapshot | undefined>>
}

/** 一个会话的投影快照（只声明看板读的那三个 key）。 */
export interface BoardProjectionSnapshot {
  readonly values: {
    readonly subagentCatalog?: readonly BoardCatalogEntry[]
    readonly tokenUsage?: BoardTokenUsage
    readonly subagentTiming?: BoardTiming
  }
}

/** `ctx.sessions` 的结构化镜像（宿主包的声明不跨包可 import）。 */
export interface BoardSessionsFace {
  readonly list: {
    getSnapshot(): BoardSessionList
    subscribe(listener: () => void): () => void
  }
  /** 选中一个会话（跳到该子代理）——可选，宿主没提供时看板不画跳转。 */
  open?(id: string): void
}

/** 一行作业的输出（`observe` 推过来的保留文本）。 */
export interface BoardObservedJob {
  readonly text: string
  readonly gapBefore: boolean
  readonly streaming: boolean
  readonly error?: string
}

/** `ctx.jobs` 的结构化镜像。 */
export interface BoardJobsFace {
  readonly state: {
    getSnapshot(): { rows: Record<string, BoardJob[]>; observed: Record<string, BoardObservedJob | undefined> }
    subscribe(listener: () => void): () => void
  }
  watchRows(sessionId: string): () => void
  observe(sessionId: string | undefined, jobId: string): () => void
  kill(sessionId: string, jobId: string): Promise<void>
}

/** 一个客户端上下文里看板要用到的服务（都可缺省）。 */
export interface BoardHost {
  get(name: string): unknown
}

/** 空快照：部署里没有会话 feed 时永远返回它（引用稳定，避免重渲染）。 */
const EMPTY_LIST: BoardSessionList = { byId: {} }

/**
 * 取会话列表 feed；服务缺席时给稳定的空快照。
 * @param ctx - 客户端上下文。
 */
export function useSessionList(ctx: BoardHost): BoardSessionList {
  const sessions = useMemo(() => sessionsFaceOf(ctx), [ctx])
  const subscribe = useCallback(
    (listener: () => void) => (sessions === undefined ? () => {} : sessions.list.subscribe(listener)),
    [sessions],
  )
  const read = useCallback(
    () => (sessions === undefined ? EMPTY_LIST : sessions.list.getSnapshot()),
    [sessions],
  )
  // 第三个参数是 server snapshot：SSR/预渲染时没有订阅，直接读当前快照，
  // 这样组件在 node 里也能画出来（也顺手让单测可以 renderToStaticMarkup）。
  return useSyncExternalStore(subscribe, read, read)
}

/** 结构探测：`ctx.get('sessions')` 是宿主客户端会话服务。 */
export function sessionsFaceOf(ctx: BoardHost): BoardSessionsFace | undefined {
  const service = ctx.get('sessions') as Partial<BoardSessionsFace> | undefined
  if (service === undefined || service === null) return undefined
  const list = service.list
  if (list === undefined || typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return undefined
  return service as BoardSessionsFace
}

/** 结构探测：`ctx.get('jobs')` 是宿主的客户端作业服务。 */
export function jobsFaceOf(ctx: BoardHost): BoardJobsFace | undefined {
  const service = ctx.get('jobs') as Partial<BoardJobsFace> | undefined
  if (service === undefined || service === null) return undefined
  if (typeof service.watchRows !== 'function' || typeof service.observe !== 'function') return undefined
  if (typeof service.kill !== 'function' || service.state === undefined) return undefined
  return service as BoardJobsFace
}

/** 会话跳转（宿主没提供就返回 undefined）。 */
export function sessionOpener(ctx: BoardHost): ((id: string) => void) | undefined {
  const workspace = ctx.get('workspace') as { openSession?: (target: string) => void } | undefined
  if (workspace !== undefined && typeof workspace.openSession === 'function') {
    return (id: string) => { workspace.openSession?.(id) }
  }
  const sessions = sessionsFaceOf(ctx)
  if (sessions?.open !== undefined) return (id: string) => { sessions.open?.(id) }
  return undefined
}

/** 作业名册 + 观察结果的快照读取。 */
export interface BoardJobsState {
  readonly rows: readonly BoardJobRow[]
  readonly observed: Record<string, BoardObservedJob | undefined>
  /** 部署里有没有客户端作业服务。 */
  readonly available: boolean
}

/**
 * 订阅一棵会话树的后台作业名册，并（可选）观察一个作业的输出。
 * @param ctx - 客户端上下文。
 * @param sessionIds - 树上的会话 id（含根）。
 * @param active - tab 是否可见（不可见时退订）。
 * @param observedJobId - 要观察输出的作业 id。
 */
export function useBoardJobs(
  ctx: BoardHost,
  sessionIds: readonly string[],
  active: boolean,
  observedJobId: string | null,
): BoardJobsState {
  const jobs = useMemo(() => jobsFaceOf(ctx), [ctx])
  const key = sessionIds.join(',')
  const subscribe = useCallback(
    (listener: () => void) => (jobs === undefined ? () => {} : jobs.state.subscribe(listener)),
    [jobs],
  )
  const read = useCallback(
    () => (jobs === undefined ? EMPTY_JOBS : jobs.state.getSnapshot()),
    [jobs],
  )
  const snapshot = useSyncExternalStore(subscribe, read, read)
  const treeIds = useMemo(() => new Set(key === '' ? [] : key.split(',')), [key])
  const rows = useMemo(() => collectJobRows(snapshot.rows, treeIds), [snapshot, treeIds])

  // 名册维持：每个树上会话一条 watchRows，引用计数由宿主服务自己管。
  useEffect(() => {
    if (jobs === undefined || !active || treeIds.size === 0) return
    const releases = [...treeIds].map(sessionId => jobs.watchRows(sessionId))
    return () => { for (const release of releases) release() }
  }, [jobs, treeIds, active])

  // 观察一个作业的输出：终止/观察都要走“读到它的那个会话”。
  const observedOwner = useMemo(
    () => (observedJobId === null ? undefined : rows.find(row => row.job.id === observedJobId)?.ownerSessionId),
    [rows, observedJobId],
  )
  useEffect(() => {
    if (jobs === undefined || observedJobId === null || observedOwner === undefined || !active) return
    const release = jobs.observe(observedOwner, observedJobId)
    return () => { release() }
  }, [jobs, observedJobId, observedOwner, active])

  return { rows, observed: snapshot.observed, available: jobs !== undefined }
}

const EMPTY_JOBS: { rows: Record<string, BoardJob[]>; observed: Record<string, BoardObservedJob | undefined> } = {
  rows: {},
  observed: {},
}

/**
 * 把按会话分组的作业名册折成一串行。
 *
 * 无主作业任何会话的名册都能看见，所以并集里会重复：按作业 id 去重，并把它
 * 归给“读到它的那个会话”（观察与终止都走这个会话）。树外会话拥有的作业丢弃。
 */
export function collectJobRows(
  roster: Readonly<Record<string, readonly BoardJob[] | undefined>>,
  treeIds: ReadonlySet<string>,
): BoardJobRow[] {
  const rows: BoardJobRow[] = []
  const seen = new Set<string>()
  for (const [watched, jobs] of Object.entries(roster)) {
    for (const job of jobs ?? []) {
      if (seen.has(job.id)) continue
      if (job.owner !== undefined && !treeIds.has(job.owner)) continue
      seen.add(job.id)
      rows.push({ ownerSessionId: watched, job })
    }
  }
  rows.sort((left, right) => right.job.startedAt - left.job.startedAt)
  return rows
}

/** 终止一个后台作业。 */
export async function killJob(ctx: BoardHost, ownerSessionId: string, jobId: string): Promise<string | undefined> {
  const jobs = jobsFaceOf(ctx)
  if (jobs === undefined) return '当前部署没有后台作业服务'
  try {
    await jobs.kill(ownerSessionId, jobId)
    return undefined
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
}

/** CLI 任务列表的读取状态。 */
export interface BoardCliState {
  readonly tasks: readonly MaestroTaskSummary[]
  readonly loading: boolean
  readonly error: string | undefined
  readonly refresh: () => void
  readonly cancel: (id: string) => Promise<string | undefined>
}

/**
 * 轮询 CLI 任务列表（只读当前会话树的）。
 * @param active - tab 是否可见。
 * @param sessionIds - 当前会话树的会话 id；缺省则不过滤（运维视角）。
 */
export function useCliTasks(active: boolean, sessionIds?: readonly string[]): BoardCliState {
  const [tasks, setTasks] = useState<readonly MaestroTaskSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => { setNonce(value => value + 1) }, [])
  const scopeKey = sessionIdsKey(sessionIds)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let timer: number | undefined
    const load = async (): Promise<void> => {
      const result = await fetchTasks(scopeKey === '' ? undefined : scopeKey.split(','))
      if (cancelled) return
      if (result.ok) {
        setTasks(result.tasks)
        setError(undefined)
      } else {
        setError(result.error)
      }
      setLoading(false)
      timer = window.setTimeout(() => { void load() }, TASKS_POLL_MS)
    }
    void load()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [active, nonce, scopeKey])

  const cancel = useCallback(async (id: string): Promise<string | undefined> => {
    const result = await cancelTask(id, scopeKey === '' ? undefined : scopeKey.split(','))
    if (!result.ok) return result.error
    setNonce(value => value + 1)
    return undefined
  }, [scopeKey])

  return { tasks, loading, error, refresh, cancel }
}

/** 排序后拼成一个稳定的 effect 依赖（数组本身每次渲染都是新引用）。 */
function sessionIdsKey(sessionIds: readonly string[] | undefined): string {
  return sessionIds === undefined || sessionIds.length === 0 ? '' : [...sessionIds].sort().join(',')
}

/** 单个任务的日志读取状态。 */
export interface BoardCliDetailState {
  readonly summary: MaestroTaskSummary | undefined
  readonly events: readonly MaestroTaskEvent[]
  /** 路由/网络层错误（读不到详情）。 */
  readonly error: string | undefined
  /** 任务自身的失败原因（宿主写进 detail 的 `error` 字段）。 */
  readonly failure: string | undefined
}

const EMPTY_DETAIL: BoardCliDetailState = { summary: undefined, events: [], error: undefined, failure: undefined }

/**
 * 跟随式读取一个任务的详情与日志（带游标，只追加）。
 * @param id - 任务 id；`null` 表示没有展开任何任务。
 * @param active - tab 是否可见。
 * @param sessionIds - 当前会话树的会话 id；详情同样按它过滤。
 */
export function useCliDetail(id: string | null, active: boolean, sessionIds?: readonly string[]): BoardCliDetailState {
  const [state, setState] = useState<BoardCliDetailState>(EMPTY_DETAIL)
  const scopeKey = sessionIdsKey(sessionIds)
  useEffect(() => {
    if (id === null || !active) {
      setState(EMPTY_DETAIL)
      return
    }
    let cancelled = false
    let cursor = 0
    let events: MaestroTaskEvent[] = []
    let timer: number | undefined
    const load = async (): Promise<void> => {
      const result = await fetchTaskDetail(id, cursor, scopeKey === '' ? undefined : scopeKey.split(','))
      if (cancelled) return
      if (!result.ok) {
        setState({ summary: undefined, events, error: result.error, failure: undefined })
        return
      }
      const detail: MaestroTaskDetail = result
      cursor = detail.nextCursor
      events = [...events, ...detail.events].slice(-LOG_CAP)
      setState({ summary: detail.summary, events, error: undefined, failure: detail.error })
      if (!TERMINAL_PHASES.includes(detail.summary.phase)) {
        timer = window.setTimeout(() => { void load() }, DETAIL_POLL_MS)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      cursor = 0
    }
  }, [id, active, scopeKey])
  return state
}

/** 每秒走一次的“现在”，让耗时读数自己往前跑。 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [active])
  return now
}
