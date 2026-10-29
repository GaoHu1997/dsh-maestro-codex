/**
 * 任务看板（右侧栏 tab）——一个面板里同时看三类任务：
 *
 * 1. **DSH 会话树**：当前会话是根，`subagentCatalog` + 会话血缘铺开成可折叠的
 *    树（缩进 + 连接线）；external 子代理没有本地会话，作为叶子照样列出；
 *    点子节点标题跳到那个会话；
 * 2. **CLI 任务**：本插件派给 codex/claude cli 的任务，含阶段、耗时、退出码、
 *    可展开的实时日志与取消；
 * 3. **后台任务**：宿主 `ctx.jobs` 名册里的 job（bash/pwsh/subagent…），
 *    可观察输出、可强制终止、可跳到所属会话。
 *
 * 顶部的胶囊入口对应会话标题栏的「N 个子智能体 / N 个后台任务」，点一下跳到区块。
 *
 * 纯 React + 一份注入式样式表（web 壳没有 CSS 管线，面板要自带样式）。
 *
 * @module dsh-maestro-codex/client/board/Board
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { CLI_LABELS, cleanLogText, type MaestroTaskEvent, type MaestroTaskSummary } from '../../wire.js'
import {
  buildSessionTree, cliStatusOf, collectTreeIds, countActive, filterTree, flattenTree, formatClock, formatDuration,
  jobLive, jobStatusOf, matchesFilter, taskCancellable, taskDuration, timingSummary, tokenSummary,
  type BoardFilter, type BoardJobRow, type BoardNode, type BoardStatus,
} from './model.js'
import {
  killJob, sessionOpener, useBoardJobs, useCliDetail, useCliTasks, useNow, useSessionList,
  type BoardHost,
} from './data.js'

/** 面板 tab id（也是 better-sidebar 的 tab type）。 */
export const BOARD_TAB_ID = 'maestro-board'

/** 面板标题。 */
export const BOARD_TAB_TITLE = '任务看板'

/** better-sidebar 传进来的渲染属性（只取本面板要用的）。 */
export interface BoardTabProps {
  readonly ctx: BoardHost
  readonly scope: { readonly sessionId: string; readonly cwd?: string }
  /** tab 是否可见：不可见时停轮询、退订名册。 */
  readonly visible?: boolean
}

const STATUS_LABELS: Record<BoardStatus, string> = {
  running: '运行中', queued: '排队中', done: '已完成', failed: '失败', cancelled: '已取消', idle: '空闲',
}

const FILTERS: ReadonlyArray<{ id: BoardFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'running', label: '运行中' },
  { id: 'done', label: '已结束' },
  { id: 'failed', label: '失败' },
]

const BOARD_CSS = `
.dmb {
  --dmb-fg: var(--dsh-text-primary, light-dark(#1a1e26, #e9ebf0));
  --dmb-fg2: var(--dsh-text-secondary, light-dark(#3f4756, #b7bfcc));
  --dmb-fg3: var(--dsh-text-tertiary, light-dark(#646d80, #8e97a8));
  --dmb-accent: var(--dsh-accent, light-dark(#2f5fe0, #7292ff));
  --dmb-panel: var(--dsh-bg-secondary, light-dark(#f7f8fa, #20242e));
  --dmb-border: var(--dsh-border, light-dark(#dce0e8, #2e3440));
  --dmb-hover: var(--dsh-bg-hover, light-dark(#edeff4, #2a3040));
  --dmb-ok: light-dark(#0e8a55, #3ddc97);
  --dmb-warn: light-dark(#b45309, #fbbf24);
  --dmb-danger: light-dark(#d92d20, #ff7b72);
  --dmb-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 10px 14px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--dmb-fg);
}
.dmb, .dmb *, .dmb *::before, .dmb *::after { box-sizing: border-box; }

/* --- head --- */
.dmb-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.dmb-title { font-size: 14px; font-weight: 650; letter-spacing: -.01em; }
.dmb-sub { margin-top: 1px; font-size: 11px; color: var(--dmb-fg3); }
.dmb-headside { display: flex; align-items: center; gap: 6px; flex: none; }
.dmb-live { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; color: var(--dmb-accent); }
.dmb-live i { width: 6px; height: 6px; border-radius: 50%; background: var(--dmb-accent); animation: dmb-pulse 1.4s ease-in-out infinite; }
@keyframes dmb-pulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
.dmb-btn {
  font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 6px; cursor: pointer;
  color: var(--dmb-fg2); background: var(--dmb-panel); border: 1px solid var(--dmb-border);
}
.dmb-btn:hover { background: var(--dmb-hover); color: var(--dmb-fg); }
.dmb-btn:disabled { opacity: .5; cursor: default; }
.dmb-btn-danger { color: var(--dmb-danger); border-color: color-mix(in srgb, var(--dmb-danger) 40%, var(--dmb-border)); }

/* --- filters --- */
.dmb-filters { display: flex; flex-wrap: wrap; gap: 5px; }
.dmb-filter {
  font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 999px; cursor: pointer;
  color: var(--dmb-fg3); background: transparent; border: 1px solid var(--dmb-border);
  display: inline-flex; align-items: center; gap: 4px;
}
.dmb-filter:hover { color: var(--dmb-fg); background: var(--dmb-hover); }
.dmb-filter-on { color: var(--dmb-accent); border-color: color-mix(in srgb, var(--dmb-accent) 45%, transparent); background: color-mix(in srgb, var(--dmb-accent) 10%, transparent); }
.dmb-filter b { font-weight: 600; opacity: .75; }

/* --- sections --- */
.dmb-sec { display: flex; flex-direction: column; gap: 4px; }
.dmb-sechead { display: flex; align-items: center; gap: 6px; padding: 2px 2px 1px; }
.dmb-sectitle { font-size: 11px; font-weight: 650; letter-spacing: .03em; text-transform: uppercase; color: var(--dmb-fg3); }
.dmb-seccount { font-size: 10.5px; font-weight: 600; color: var(--dmb-fg3); background: var(--dmb-panel); border-radius: 999px; padding: 0 6px; }
.dmb-sechint { margin-left: auto; font-size: 10.5px; color: var(--dmb-fg3); }
.dmb-empty { margin: 0; padding: 6px 8px; font-size: 11.5px; color: var(--dmb-fg3); border: 1px dashed var(--dmb-border); border-radius: 7px; }

/* --- rows --- */
.dmb-row { border: 1px solid var(--dmb-border); border-radius: 8px; background: var(--dmb-panel); overflow: hidden; }
.dmb-row + .dmb-row { margin-top: 4px; }
.dmb-rowhead { display: flex; align-items: center; gap: 6px; padding: 6px 8px; min-width: 0; cursor: default; }
.dmb-rowhead-click { cursor: pointer; }
.dmb-rowhead-click:hover { background: var(--dmb-hover); }
.dmb-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--dmb-fg3); }
.dmb-dot-running { background: var(--dmb-accent); animation: dmb-pulse 1.4s ease-in-out infinite; }
.dmb-dot-queued { background: var(--dmb-warn); }
.dmb-dot-done { background: var(--dmb-ok); }
.dmb-dot-failed { background: var(--dmb-danger); }
.dmb-dot-cancelled, .dmb-dot-idle { background: var(--dmb-fg3); }
.dmb-rowtitle { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
.dmb-rowtitle-ghost { color: var(--dmb-fg2); font-style: italic; }
.dmb-rowmeta { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.dmb-meta { font-size: 10.5px; color: var(--dmb-fg3); white-space: nowrap; }
.dmb-meta-mono { font-family: var(--dmb-mono); }
.dmb-tag { font-size: 10px; font-weight: 600; padding: 0 5px; border-radius: 4px; border: 1px solid var(--dmb-border); color: var(--dmb-fg2); }
.dmb-tag-claude { color: #d97757; border-color: color-mix(in srgb, #d97757 45%, transparent); }
.dmb-tag-codex { color: #10a37f; border-color: color-mix(in srgb, #10a37f 45%, transparent); }
.dmb-rowright { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.dmb-indent { display: inline-block; flex: none; }

/* --- 顶部入口胶囊（对应原生的“N 个子智能体 / N 个后台任务”） --- */
.dmb-pills { display: flex; flex-wrap: wrap; gap: 5px; }
.dmb-pill {
  font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 999px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px;
  color: var(--dmb-fg2); background: var(--dmb-panel); border: 1px solid var(--dmb-border);
}
.dmb-pill:hover { color: var(--dmb-fg); background: var(--dmb-hover); }
.dmb-pill em { font-style: normal; color: var(--dmb-fg3); }

/* --- 任务树 --- */
.dmb-tree { display: flex; flex-direction: column; }
.dmb-node {
  display: flex; align-items: center; gap: 6px; min-width: 0;
  padding: 5px 6px; border-radius: 7px;
}
.dmb-node:hover { background: var(--dmb-hover); }
.dmb-node-jump { cursor: pointer; }
.dmb-node-root { background: var(--dmb-panel); border: 1px solid var(--dmb-border); }
.dmb-node-root:hover { background: var(--dmb-hover); }
.dmb-caret {
  flex: none; width: 14px; height: 14px; padding: 0; border: 0; border-radius: 3px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 9px; line-height: 1; color: var(--dmb-fg3); background: none; cursor: pointer;
}
button.dmb-caret:hover { color: var(--dmb-fg); background: var(--dmb-border); }
.dmb-caret-blank { cursor: default; }
.dmb-jump {
  flex: none; width: 16px; height: 16px; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; color: var(--dmb-fg3);
}
.dmb-node-jump:hover .dmb-jump { color: var(--dmb-accent); background: var(--dmb-panel); }
.dmb-kids { margin-left: 15px; padding-left: 8px; border-left: 1px solid var(--dmb-border); }
.dmb-nodebody { margin: 1px 0 3px 20px; }

/* --- detail body --- */
.dmb-body { border-top: 1px solid var(--dmb-border); padding: 6px 8px 8px; background: color-mix(in srgb, var(--dmb-fg) 2%, transparent); }
.dmb-kv { display: flex; flex-wrap: wrap; gap: 3px 10px; font-size: 11px; color: var(--dmb-fg3); }
.dmb-kv code { font-family: var(--dmb-mono); font-size: 10.5px; color: var(--dmb-fg2); }
.dmb-log {
  margin: 6px 0 0; padding: 6px 7px; max-height: 260px; overflow: auto;
  font-family: var(--dmb-mono); font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word;
  background: var(--dmb-input, light-dark(#ffffff, #171a21)); border: 1px solid var(--dmb-border); border-radius: 6px;
  color: var(--dmb-fg2);
}
.dmb-log-line-err { color: var(--dmb-danger); }
.dmb-log-line-note { color: var(--dmb-fg3); }
.dmb-log-line-result { color: var(--dmb-ok); }
.dmb-note { margin: 4px 0 0; font-size: 10.5px; color: var(--dmb-warn); }
.dmb-err { margin: 4px 0 0; font-size: 11px; color: var(--dmb-danger); }
.dmb-foot { margin-top: 2px; font-size: 10.5px; color: var(--dmb-fg3); text-align: center; }

/* --- skeleton --- */
.dmb-skel { height: 10px; border-radius: 4px; background: color-mix(in srgb, var(--dmb-fg3) 18%, transparent); animation: dmb-pulse 1.4s ease-in-out infinite; }
`

const STYLE_ID = 'dsh-maestro-codex-board-styles'

/** 注入看板样式表（按 id 幂等：多次挂载共享一份）。 */
function useBoardStyles(): void {
  useEffect(() => {
    if (document.getElementById(STYLE_ID) !== null) return
    const element = document.createElement('style')
    element.id = STYLE_ID
    element.textContent = BOARD_CSS
    document.head.appendChild(element)
  }, [])
}

/** 一行元信息小字。 */
function Meta(props: { children: ReactNode; mono?: boolean }): ReactNode {
  return <span className={`dmb-meta${props.mono === true ? ' dmb-meta-mono' : ''}`}>{props.children}</span>
}

/** 区块外壳：标题 + 计数 + 内容。 */
function Section(props: {
  title: string
  count: number
  hint?: string
  empty?: string
  children?: ReactNode
}): ReactNode {
  const empty = props.count === 0
  return (
    <section className="dmb-sec">
      <div className="dmb-sechead">
        <span className="dmb-sectitle">{props.title}</span>
        <span className="dmb-seccount">{props.count}</span>
        {props.hint === undefined ? undefined : <span className="dmb-sechint">{props.hint}</span>}
      </div>
      {empty
        ? <p className="dmb-empty">{props.empty ?? '暂无'}</p>
        : props.children}
    </section>
  )
}

/** 一行：状态点 + 标题 + 元信息 + 右侧动作（+ 可选展开体）。 */
function Row(props: {
  status: BoardStatus
  title: string
  ghost?: boolean
  depth?: number
  meta?: ReactNode
  right?: ReactNode
  open?: boolean
  onToggle?: () => void
  /** 点标题跳到别处时禁用展开手势。 */
  body?: ReactNode
  titleAttr?: string
}): ReactNode {
  const clickable = props.onToggle !== undefined || props.titleAttr !== undefined
  const head = (
    <div
      className={`dmb-rowhead${clickable ? ' dmb-rowhead-click' : ''}`}
      {...(clickable ? { role: 'button', tabIndex: 0 } : {})}
      {...(props.titleAttr === undefined ? {} : { title: props.titleAttr })}
      onClick={props.onToggle}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        props.onToggle?.()
      }}
    >
      <span className="dmb-indent" style={{ width: (props.depth ?? 0) * 10 }} />
      <span className={`dmb-dot dmb-dot-${props.status}`} />
      <span className={`dmb-rowtitle${props.ghost === true ? ' dmb-rowtitle-ghost' : ''}`}>{props.title}</span>
      {props.meta === undefined ? undefined : <span className="dmb-rowmeta">{props.meta}</span>}
      {props.right === undefined ? undefined : <span className="dmb-rowright">{props.right}</span>}
    </div>
  )
  return (
    <div className="dmb-row">
      {head}
      {props.body !== undefined && (props.open ?? true) ? <div className="dmb-body">{props.body}</div> : null}
    </div>
  )
}

/** 一个日志行：按事件种类上色。 */
function logLineClass(kind: MaestroTaskEvent['kind']): string {
  switch (kind) {
    case 'error': return 'dmb-log-line-err'
    case 'note': case 'phase': return 'dmb-log-line-note'
    case 'result': return 'dmb-log-line-result'
    case 'text': return ''
  }
}

/** 主组件。 */
export function BoardTab(props: BoardTabProps): ReactNode {
  useBoardStyles()
  const { ctx, scope } = props
  const active = props.visible !== false
  const now = useNow(active)

  const list = useSessionList(ctx)
  const rootId = scope.sessionId
  const catalogs = useMemo(() => {
    const table: Record<string, readonly { id: string; createdAt: number; mode: string; label?: string }[] | undefined> = {}
    const tokens: Record<string, { uncachedInputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined> = {}
    const timings: Record<string, { settledMs: number; active?: { since: number; through: number } } | undefined> = {}
    for (const [sessionId, projection] of Object.entries(list.projectionsBySession ?? {})) {
      if (projection === undefined) continue
      const values = projection.values
      if (values.subagentCatalog !== undefined) table[sessionId] = values.subagentCatalog
      if (values.tokenUsage !== undefined) tokens[sessionId] = values.tokenUsage
      if (values.subagentTiming !== undefined) timings[sessionId] = values.subagentTiming
    }
    return { table, tokens, timings }
  }, [list])

  const tree = useMemo(
    () => buildSessionTree({
      rootId,
      sessions: list.byId,
      catalogs: catalogs.table,
      tokens: catalogs.tokens,
      timings: catalogs.timings,
    }),
    [rootId, list, catalogs],
  )
  const rows = useMemo(() => flattenTree(tree), [tree])
  const treeIds = useMemo(() => collectTreeIds(tree), [tree])

  const [filter, setFilter] = useState<BoardFilter>('all')
  const [openCli, setOpenCli] = useState<string | null>(null)
  const [openJob, setOpenJob] = useState<string | null>(null)
  // 收起的节点 id 集合：默认全展开（树要一眼看到结构，再按需收）。
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set<string>())
  const treeSeat = useRef<HTMLDivElement | null>(null)
  const cliSeat = useRef<HTMLDivElement | null>(null)
  const jobsSeat = useRef<HTMLDivElement | null>(null)

  // CLI 任务按会话树隔离：只拉当前树触发的任务，与下面的 jobs 一致。
  const cli = useCliTasks(active, treeIds)
  const chips = useBoardJobs(ctx, treeIds, active, openJob)
  const detail = useCliDetail(openCli, active, treeIds)
  const opener = useMemo(() => sessionOpener(ctx), [ctx])

  const childRows = rows.filter(row => row.depth > 0)
  const statuses: BoardStatus[] = [
    tree.status,
    ...childRows.map(row => row.status),
    ...cli.tasks.map(task => cliStatusOf(task.phase)),
    ...chips.rows.map(row => jobStatusOf(row.job.status)),
  ]
  const activeCount = countActive(statuses)
  const filterCount = (id: BoardFilter): number => statuses.filter(status => matchesFilter(status, id)).length

  const refreshAll = useCallback(() => { cli.refresh() }, [cli])

  const expandCli = useCallback((id: string) => {
    setOpenCli(current => (current === id ? null : id))
  }, [])
  const expandJob = useCallback((id: string) => {
    setOpenJob(current => (current === id ? null : id))
  }, [])

  const fold = useCallback((id: string) => {
    setFolded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const unfoldAll = useCallback(() => { setFolded(new Set<string>()) }, [])
  const seatTo = useCallback((seat: { current: HTMLDivElement | null }) => {
    seat.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [])

  // 树按筛选剪枝后渲染：命中节点的祖先要留着，否则层级断掉。
  const visibleTree = useMemo(() => filterTree(tree, filter), [tree, filter])
  const visibleRows = useMemo(() => (visibleTree === undefined ? [] : flattenTree(visibleTree)), [visibleTree])
  /** 子代理总数（不含根）。 */
  const childCount = childRows.length
  const childrenRunning = childRows.some(row => row.status === 'running' || row.status === 'queued')
  const jobsRunning = chips.rows.some(row => jobStatusOf(row.job.status) === 'running')
  const cliRunning = cli.tasks.some(task => cliStatusOf(task.phase) === 'running')
  const visibleCli = cli.tasks.filter(task => matchesFilter(cliStatusOf(task.phase), filter))
  const visibleJobs = chips.rows.filter(row => matchesFilter(jobStatusOf(row.job.status), filter))

  const cancelCli = useCallback((task: MaestroTaskSummary) => {
    void cli.cancel(task.id)
  }, [cli])
  const killOne = useCallback((row: BoardJobRow) => {
    void killJob(ctx, row.ownerSessionId, row.job.id)
  }, [ctx])

  return (
    <div className="dmb">
      <div className="dmb-head">
        <div>
          <div className="dmb-title">{BOARD_TAB_TITLE}</div>
          <div className="dmb-sub">会话树 · CLI 子代理 · 后台任务</div>
        </div>
        <div className="dmb-headside">
          {activeCount > 0 ? <span className="dmb-live"><i />运行中 {activeCount}</span> : undefined}
          <button type="button" className="dmb-btn" onClick={refreshAll} title="重新拉取 CLI 任务列表">刷新</button>
        </div>
      </div>

      {/* 对应会话标题栏那两个入口：N 个子智能体 / N 个后台任务，点一下跳到区块。 */}
      <div className="dmb-pills">
        <button
          type="button"
          className="dmb-pill"
          title="展开子任务树并跳过去"
          onClick={() => { unfoldAll(); seatTo(treeSeat) }}
        >
          <span className={`dmb-dot dmb-dot-${childrenRunning ? 'running' : childCount > 0 ? 'idle' : 'done'}`} />
          {String(childCount)} 个子智能体<em>›</em>
        </button>
        <button type="button" className="dmb-pill" title="跳到后台任务区" onClick={() => { seatTo(jobsSeat) }}>
          <span className={`dmb-dot dmb-dot-${jobsRunning ? 'running' : chips.rows.length > 0 ? 'idle' : 'done'}`} />
          {String(chips.rows.length)} 个后台任务<em>›</em>
        </button>
        <button type="button" className="dmb-pill" title="跳到 CLI 任务区" onClick={() => { seatTo(cliSeat) }}>
          <span className={`dmb-dot dmb-dot-${cliRunning ? 'running' : cli.tasks.length > 0 ? 'idle' : 'done'}`} />
          {String(cli.tasks.length)} 个 CLI 任务<em>›</em>
        </button>
      </div>

      <div className="dmb-filters">
        {FILTERS.map(entry => (
          <button
            key={entry.id}
            type="button"
            className={`dmb-filter${filter === entry.id ? ' dmb-filter-on' : ''}`}
            onClick={() => { setFilter(entry.id) }}
          >
            {entry.label}<b>{filterCount(entry.id)}</b>
          </button>
        ))}
      </div>

      <div ref={treeSeat}>
        <Section
          title="DSH 会话树"
          count={visibleRows.length}
          empty={childCount === 0 ? '当前会话没有子代理' : '没有匹配的任务'}
        >
          {visibleTree === undefined
            ? undefined
            : (
              <TreeNode
                node={visibleTree}
                now={now}
                depth={0}
                folded={folded}
                onFold={fold}
                {...(opener === undefined ? {} : { onOpen: opener })}
                body={(
                  <div className="dmb-kv">
                    {scope.cwd === undefined || scope.cwd === '' ? undefined : <span><code>{scope.cwd}</code></span>}
                    {tokenSummary(tree.tokens) === undefined ? undefined : <span>{tokenSummary(tree.tokens)}</span>}
                    <span>会话 <code>{tree.id.slice(0, 12)}</code></span>
                  </div>
                )}
              />
            )}
        </Section>
      </div>

      <div ref={cliSeat}>
        <Section
          title="CLI 任务"
          count={visibleCli.length}
          hint={cli.error === undefined ? '本会话及其子会话' : cli.error}
          empty={cli.loading ? '读取中…' : filter === 'all' ? '还没有派发过 CLI 任务' : '没有匹配的 CLI 任务'}
        >
          {visibleCli.map(task => (
            <CliRow
              key={task.id}
              task={task}
              now={now}
              open={openCli === task.id}
              onToggle={() => { expandCli(task.id) }}
              onCancel={() => { cancelCli(task) }}
              detail={openCli === task.id ? detail : undefined}
            />
          ))}
        </Section>
      </div>

      <div ref={jobsSeat}>
        <Section
          title="后台任务"
          count={visibleJobs.length}
          empty={chips.available ? (filter === 'all' ? '没有后台任务' : '没有匹配的后台任务') : '当前部署没有后台作业服务'}
        >
          {visibleJobs.map(row => (
            <JobRow
              key={`${row.ownerSessionId}:${row.job.id}`}
              row={row}
              now={now}
              open={openJob === row.job.id}
              onToggle={() => { expandJob(row.job.id) }}
              onKill={() => { killOne(row) }}
              output={openJob === row.job.id ? chips.observed[row.job.id] : undefined}
              {...(opener === undefined ? {} : { onOpen: () => { opener(row.ownerSessionId) } })}
            />
          ))}
        </Section>
      </div>

      <div className="dmb-foot">更新于 {formatClock(now)}</div>
    </div>
  )
}

/** 一个节点的元信息：external 标记 / 子级数 / 耗时 / token 摘要。 */
function nodeMeta(node: BoardNode, now: number, depth: number): ReactNode {
  const meta: ReactNode[] = []
  // 根就是当前会话本身，不标 external（它可能是服务缺失时的占位节点）。
  if (depth > 0 && !node.hasSession) meta.push(<span className="dmb-tag" key="ext">external</span>)
  else if (node.mode !== undefined && node.mode !== 'external') meta.push(<span className="dmb-tag" key="mode">{node.mode}</span>)
  if (node.children.length > 0) meta.push(<Meta key="kids">子 {String(node.children.length)}</Meta>)
  const timing = timingSummary(node.timing, now)
  if (timing !== undefined) meta.push(<Meta key="time">{timing}</Meta>)
  const tokens = tokenSummary(node.tokens)
  if (tokens !== undefined) meta.push(<Meta key="tok">{tokens}</Meta>)
  if (meta.length === 0) meta.push(<span className="dmb-tag" key="state">{STATUS_LABELS[node.status]}</span>)
  return <>{meta}</>
}

/**
 * 树上的一个节点（递归渲染子级）。
 *
 * 折叠三角只动子树，标题整行是「进入会话」的手势——两个目标分开，避免
 * 想展开却把主对话切走了；external 子代理没有本地会话，行不可点。
 */
function TreeNode(props: {
  node: BoardNode
  now: number
  depth: number
  folded: ReadonlySet<string>
  onFold: (id: string) => void
  onOpen?: ((id: string) => void) | undefined
  body?: ReactNode
}): ReactNode {
  const { node, now, depth, folded, onFold, onOpen } = props
  const open = !folded.has(node.id)
  const hasKids = node.children.length > 0
  const jumpable = onOpen !== undefined && node.hasSession && depth > 0
  const jump = (): void => { onOpen?.(node.id) }
  return (
    <div className="dmb-tree">
      <div
        className={`dmb-node${depth === 0 ? ' dmb-node-root' : ''}${jumpable ? ' dmb-node-jump' : ''}`}
        {...(jumpable ? { role: 'button', tabIndex: 0, title: '打开这个子会话' } : {})}
        onClick={jumpable ? jump : undefined}
        onKeyDown={jumpable
          ? (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            jump()
          }
          : undefined}
      >
        {hasKids
          ? (
            <button
              type="button"
              className="dmb-caret"
              aria-expanded={open}
              title={open ? '收起子任务' : '展开子任务'}
              onClick={(event) => { event.stopPropagation(); onFold(node.id) }}
            >
              {open ? '▾' : '▸'}
            </button>
          )
          : <span className="dmb-caret dmb-caret-blank" />}
        <span className={`dmb-dot dmb-dot-${node.status}`} />
        <span className={`dmb-rowtitle${depth > 0 && !node.hasSession ? ' dmb-rowtitle-ghost' : ''}`}>{node.title}</span>
        <span className="dmb-rowmeta">{nodeMeta(node, now, depth)}</span>
        {jumpable ? <span className="dmb-jump" aria-hidden>↗</span> : undefined}
      </div>
      {props.body === undefined ? undefined : <div className="dmb-nodebody">{props.body}</div>}
      {open && hasKids
        ? (
          <div className="dmb-kids">
            {node.children.map(child => (
              <TreeNode
                key={child.id}
                node={child}
                now={now}
                depth={depth + 1}
                folded={folded}
                onFold={onFold}
                {...(onOpen === undefined ? {} : { onOpen })}
              />
            ))}
          </div>
        )
        : undefined}
    </div>
  )
}

/** 一个 CLI 任务行：展开后看实时日志，运行中可取消。 */
function CliRow(props: {
  task: MaestroTaskSummary
  now: number
  open: boolean
  onToggle: () => void
  onCancel: () => void
  detail: { summary: MaestroTaskSummary | undefined; events: readonly MaestroTaskEvent[]; error: string | undefined; failure: string | undefined } | undefined
}): ReactNode {
  const { task, now, open, detail } = props
  const status = cliStatusOf(task.phase)
  const logRef = useRef<HTMLPreElement | null>(null)
  const lineCount = detail?.events.length ?? 0
  useEffect(() => {
    if (!open) return
    const element = logRef.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
  }, [open, lineCount])

  const right: ReactNode[] = []
  if (taskCancellable(task)) {
    right.push(
      <button
        key="cancel"
        type="button"
        className="dmb-btn dmb-btn-danger"
        onClick={(event) => { event.stopPropagation(); props.onCancel() }}
      >
        取消
      </button>,
    )
  }

  return (
    <Row
      status={status}
      title={task.title}
      onToggle={props.onToggle}
      titleAttr={open ? '收起日志' : '展开日志'}
      meta={(
        <>
          <span className={`dmb-tag dmb-tag-${task.cli}`}>{CLI_LABELS[task.cli]}</span>
          <Meta>{STATUS_LABELS[status]}</Meta>
          <Meta>{formatDuration(taskDuration(task, now))}</Meta>
          {task.exitCode === undefined ? undefined : <Meta mono>退出 {String(task.exitCode)}</Meta>}
        </>
      )}
      right={<>{right}</>}
      open={open}
      body={(
        <>
          <div className="dmb-kv">
            <span>模型 <code>{task.model === '' ? '默认' : task.model}</code></span>
            <span>开始 <code>{formatClock(task.startedAt)}</code></span>
            {task.endedAt === undefined ? undefined : <span>结束 <code>{formatClock(task.endedAt)}</code></span>}
            {task.truncated === true ? <span>日志已截断</span> : undefined}
          </div>
          {detail?.error === undefined ? undefined : <p className="dmb-err">{detail.error}</p>}
          {detail?.failure === undefined ? undefined : <p className="dmb-err">{detail.failure}</p>}
          <pre className="dmb-log" ref={logRef}>
            {(detail?.events ?? []).map(event => (
              <span key={event.seq} className={logLineClass(event.kind)}>
                {cleanLogText(event.text)}{'\n'}
              </span>
            ))}
          </pre>
          {detail === undefined || detail.events.length > 0 ? undefined : <p className="dmb-note">等待输出…</p>}
        </>
      )}
    />
  )
}

/** 一个后台作业行：展开看保留输出，运行中可终止，可跳到所属会话。 */
function JobRow(props: {
  row: BoardJobRow
  now: number
  open: boolean
  onToggle: () => void
  onKill: () => void
  onOpen?: (() => void) | undefined
  output: { text: string; streaming: boolean; gapBefore: boolean; error?: string } | undefined
}): ReactNode {
  const { row, now, open, output } = props
  const { job } = row
  const status = jobStatusOf(job.status)
  const elapsed = (job.finishedAt ?? now) - job.startedAt
  const logRef = useRef<HTMLPreElement | null>(null)
  useEffect(() => {
    if (!open) return
    const element = logRef.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
  }, [open, output?.text])

  return (
    <Row
      status={status}
      title={job.label}
      onToggle={props.onToggle}
      titleAttr={open ? '收起输出' : '展开输出'}
      meta={(
        <>
          <span className="dmb-tag">{job.kind}</span>
          <Meta>{STATUS_LABELS[status]}</Meta>
          <Meta>{formatDuration(Math.max(0, elapsed))}</Meta>
          {job.progress === undefined ? undefined : <Meta mono>{job.progress}</Meta>}
        </>
      )}
      right={(
        <>
          {props.onOpen === undefined
            ? undefined
            : (
              <button
                type="button"
                className="dmb-btn"
                title="打开这个任务所属的会话"
                onClick={(event) => { event.stopPropagation(); props.onOpen?.() }}
              >
                ↗
              </button>
            )}
          {jobLive(job)
            ? (
              <button
                type="button"
                className="dmb-btn dmb-btn-danger"
                onClick={(event) => { event.stopPropagation(); props.onKill() }}
              >
                终止
              </button>
            )
            : undefined}
        </>
      )}
      open={open}
      body={(
        <>
          <div className="dmb-kv">
            <span>id <code>{job.id}</code></span>
            <span>所属会话 <code>{row.ownerSessionId.slice(0, 12)}</code></span>
            <span>开始 <code>{formatClock(job.startedAt)}</code></span>
            {job.finishedAt === undefined ? undefined : <span>结束 <code>{formatClock(job.finishedAt)}</code></span>}
            {job.detail === undefined ? undefined : <span>{job.detail}</span>}
          </div>
          {output?.error === undefined ? undefined : <p className="dmb-err">{output.error}</p>}
          {output?.gapBefore === true ? <p className="dmb-note">中间有输出被丢弃（观察开始得太晚）</p> : undefined}
          <pre className="dmb-log" ref={logRef}>{cleanLogText(output?.text ?? '')}</pre>
        </>
      )}
    />
  )
}
