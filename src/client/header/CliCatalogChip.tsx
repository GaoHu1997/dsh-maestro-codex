/** Maestro-owned unified catalog: executor icons, state, usage and native CLI continuation. */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useCliAccess } from '../access.js'
import { createPortal } from 'react-dom'
import { SessionPage } from '../board/Session.js'
import { hasBoardTranscriptAside, jumpBoardAddress, jumpBoardCliSession } from '../board/bridge.js'
import type { SidebarSubagentAddress } from '../board/upstream/context-types.js'

import { TERMINAL_PHASES, type MaestroTaskSummary, type MaestroCliId } from '../../wire.js'
import {
  formatDuration, formatTokens, taskDuration, timingSummary,
  type BoardCatalogEntry, type BoardTokenUsage,
} from '../board/model.js'
import { injectBoardAccent, DSH_BADGE_TITLE, EXECUTOR_BRANDS } from '../board/accent.js'
import {
  useCliTasks, useNow, useSessionList, type BoardHost, type BoardSessionList,
} from '../board/data.js'

const HEADER_CSS = `
.dmch-wrap { display: inline-flex; align-items: center; min-width: 0; position: relative; }
.dmch-wrap.dmch-footer { display: block; width: 100%; }
.dmch-trigger {
  display: inline-flex; align-items: center; gap: 4px; min-height: 28px; padding: 3px 2px;
  border: 0; border-radius: var(--dsw-radius-sm, 6px); background: none; cursor: pointer;
  color: var(--dsw-alias-label-tertiary, var(--dsh-text-tertiary, #646d80));
  font: inherit; font-size: 12px; line-height: 18px; white-space: nowrap;
}
.dmch-trigger:hover, .dmch-trigger:focus-visible { color: var(--dsw-alias-label-primary, var(--dsh-text-primary, #1a1e26)); }
.dmch-trigger svg { flex: none; transition: transform .12s ease; }
.dmch-trigger-on svg.dmch-chevron { transform: rotate(180deg); }
.dmch-executors { display: inline-flex; align-items: center; gap: 6px; }
.dmch-executor-summary { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; font-variant-numeric: tabular-nums; }
.dmch-executor-icon { display: inline-block; flex: none; width: 12px; height: 12px; }
[data-dmc-chip] .dmch-badge[data-cli-executor]::before { content: none; }
.dmch-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #8e97a8); }
.dmch-dot-running { background: var(--dsw-alias-state-success-primary, #16a34a); animation: dmch-pulse 1.4s ease-in-out infinite; }
.dmch-dot-done { background: var(--dsw-alias-label-tertiary, #8e97a8); }
.dmch-dot-failed { background: var(--dsw-alias-state-error-primary, #d92d20); }
@keyframes dmch-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.dmch-menu {
  position: fixed; z-index: 120; box-sizing: border-box;
  width: 336px; max-width: calc(100vw - 24px); max-height: min(520px, 70vh);
  display: flex; flex-direction: column; padding: 4px; overflow: hidden;
  border-radius: var(--dsw-radius-lg, 10px);
  /* 主题的 menu-surface-fill 带 58%/45% 透明度（靠 backdrop blur 糊住），
   * 这里的浮层没有 blur，直接用实色，避免透出底下的对话文字。 */
  background: light-dark(#f8f9fa, #303136);
  border: .5px solid light-dark(#d9dde5, #4a4d55);
  box-shadow: 0 12px 32px light-dark(rgba(15, 23, 42, .18), rgba(0, 0, 0, .5));
  backdrop-filter: none;
}
.dmch-menu-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px 4px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #646d80); }
.dmch-menu-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; }
.dmch-menu-body { display: flex; flex-direction: column; gap: 1px; }
.dmch-row {
  display: flex; align-items: flex-start; gap: 6px; width: 100%; min-height: 42px;
  padding: 6px 7px 6px 9px; border: 0; border-radius: var(--dsw-radius-md, 8px);
  background: none; color: var(--dsw-alias-label-primary, var(--dsh-text-primary, #1a1e26));
  text-align: left; font: inherit;
}
.dmch-row-open { cursor: pointer; }
.dmch-row-open:hover, .dmch-row-open:focus-visible { background: var(--dsw-alias-interactive-bg-hover, var(--dsh-bg-hover, #edeff4)); }
.dmch-row:disabled { cursor: default; }
.dmch-row-dot { flex: none; margin-top: 5px; }
.dmch-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dmch-line { display: flex; align-items: center; gap: 5px; min-width: 0; }
.dmch-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 17px; }
.dmch-badge {
  flex: none; display: inline-flex; align-items: center; gap: 3px;
  padding: 0 4px; border-radius: 3px; border: 1px solid var(--dsw-alias-border-l2, #dce0e8);
  font-size: 9.5px; line-height: 14px; font-weight: 600; color: var(--dsw-alias-label-tertiary, #646d80);
}
/* 执行者徽标的品牌色与 logo 由 accent.ts 的样式表按 data-cli-executor 分配
 * （看板节点右上角同款），这里只保留无执行者时的中性底。 */
.dmch-sub { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary, #646d80); }
.dmch-metrics {
  flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 1px;
  font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary, #646d80);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.dmch-empty { padding: 12px 10px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #646d80); text-align: center; }
.dmch-foot { padding: 4px 8px 6px; font-size: 10px; color: var(--dsw-alias-label-tertiary, #646d80); }

.dmch-inline { position: static; z-index: auto; width: auto; max-width: none; max-height: none; padding: 4px 0 0; border: 0; box-shadow: none; background: none; }
.dmch-inline .dmch-menu-head { padding-inline: 7px; }
.dmch-inline .dmch-menu-body, .dmch-inline .dmch-menu-scroll { overflow: visible; }
`

/** 没有 host 时的稳定空壳（避免每次渲染新建对象导致订阅反复重建）。 */
const EMPTY_HOST: BoardHost = { get: () => undefined }

function useHeaderStyles(): void {
  useEffect(() => { injectBoardAccent() }, [])
}

/** 页头一行：本地子代理、CLI 子代理、其它 external 目录行共用。 */
interface HeaderRow {
  readonly key: string
  readonly label: string
  readonly sub: string
  readonly running: boolean
  readonly failed: boolean
  readonly tokens?: HeaderTokenUsage
  readonly usageMeasured?: boolean
  readonly durationMs?: number
  readonly target?: string
  readonly childAddress?: SidebarSubagentAddress
  readonly cli?: boolean
  readonly cliTask?: MaestroTaskSummary
  /**
   * 行头执行者徽标（看板节点右上角同款词汇表）：claude/codex = CLI 子代理，
   * DSH = dsh 原生子智能体；external 行不知道执行者，不给徽标。
   */
  readonly executor?: string
}

const EXECUTOR_NAMES: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex', grok: 'Grok', DSH: 'DSH' }
const EXECUTOR_ORDER = ['claude', 'codex', 'grok', 'DSH'] as const

/** Reuse licensed existing masks, with an explicit accessible icon node. */
export function ExecutorIcon({ executor }: { readonly executor: string }): ReactNode {
  const brand = Object.hasOwn(EXECUTOR_BRANDS, executor) ? EXECUTOR_BRANDS[executor] : undefined
  if (brand === undefined) return null
  const mask = `${brand.mask} center / contain no-repeat`
  return <span className="dmch-executor-icon" data-cli-icon={executor} role="img"
    aria-label={`${EXECUTOR_NAMES[executor] ?? executor} 图标`}
    style={{ color: brand.color, backgroundColor: 'currentColor', WebkitMask: mask, mask }} />
}

/** 一颗点。 */
function RowDot({ row }: { readonly row: HeaderRow }): ReactNode {
  const state = row.failed ? 'failed' : row.running ? 'running' : 'done'
  return <span className={`dmch-dot dmch-row-dot dmch-dot-${state}`} />
}

/** CLI 桶可未知；native tokenUsage 仍是数字。 */
type HeaderTokenUsage = { readonly [Key in keyof BoardTokenUsage]: number | null }
function totalOf(tokens: HeaderTokenUsage | undefined): { known: number; partial: boolean } {
  if (tokens === undefined) return { known: 0, partial: true }
  const values = [tokens.uncachedInputTokens, tokens.outputTokens, tokens.cacheReadTokens, tokens.cacheWriteTokens]
  return { known: values.reduce<number>((sum, value) => sum + (value ?? 0), 0), partial: values.some(value => value === null) }
}

export function headerTokenText(tokens: HeaderTokenUsage | undefined, options: { readonly cli?: boolean; readonly running?: boolean; readonly usageMeasured?: boolean } = {}): string {
  const total = totalOf(tokens)
  if (tokens !== undefined && total.partial) return total.known > 0 ? `已知 ${formatTokens(total.known)} tok · 部分未知` : '用量未知'
  if (total.known > 0 || (tokens !== undefined && options.usageMeasured === true)) return `${formatTokens(total.known)} tok`
  if (options.cli === true) return options.running === true ? '尚未收到用量' : '用量未采集'
  return ''
}

/**
 * 页头 chip 组件。
 *
 * slot 注入了 `host`（会话 feed 的入口），标准 props 带来当前的 `sessionId`。
 */
export function CliCatalogChip(props: {
  readonly sessionId?: string | undefined
  readonly host?: BoardHost | undefined
  readonly nativeCatalog?: boolean | undefined
  readonly addressedChild?: boolean | undefined
  readonly inline?: boolean | undefined
  readonly sessionList?: BoardSessionList | undefined
  readonly fallbackTask?: { readonly taskId: string; readonly cli?: MaestroCliId } | undefined
  readonly openCliFallback?: ((taskId: string, cli?: MaestroCliId) => void) | undefined
  readonly onCloseFallback?: (() => void) | undefined
  readonly footerAvailable?: boolean | undefined
  readonly renderFooter?: (() => ReactNode) | undefined
}): ReactNode {
  useHeaderStyles()
  const { sessionId, host, inline = false } = props
  const [open, setOpen] = useState(false)
  const [openError, setOpenError] = useState<string>()
  const [menuAt, setMenuAt] = useState<{ left: number; top: number }>()
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const rootList = useSessionList(props.sessionList === undefined ? host ?? EMPTY_HOST : EMPTY_HOST)
  const list = props.sessionList ?? rootList
  const access = useCliAccess(list, sessionId)
  const [sessionTask, setSessionTask] = useState<HeaderRow | undefined>(undefined)
  useEffect(() => { setSessionTask(undefined); setOpen(false); setOpenError(undefined); props.onCloseFallback?.() }, [sessionId, access?.token, props.onCloseFallback])
  const session = sessionId === undefined ? undefined : list.byId[sessionId]
  const isChild = props.addressedChild === true || session?.origin === 'subagent'
  const projection = sessionId === undefined ? undefined : list.projectionsBySession?.[sessionId]
  const catalogError = projection?.state === 'error'
  const catalogPending = projection?.state === 'loading' || projection?.state === 'idle'
  const catalogUnavailable = projection === undefined
  const catalogUncertain = catalogError || catalogPending || catalogUnavailable
  const active = sessionId !== undefined && !isChild
  const tasks = useCliTasks(active, sessionId === undefined ? undefined : [sessionId], access)
  const nativeAside = hasBoardTranscriptAside(host ?? EMPTY_HOST)

  // 只有真的在跑的任务/子会话才需要每秒推进耗时。空闲时完全停表：页头 chip
  // 常驻会话页，每秒 setState 一次会让整块 header 跟着重渲染，而打字也发生在
  // 同一个 renderer 主线程上。已结算的耗时是静态值，不依赖“现在”。
  const ticking = useMemo<boolean>(() => {
    if (!active) return false
    if (tasks.tasks.some(task => !(TERMINAL_PHASES as readonly string[]).includes(task.phase))) return true
    if (sessionId === undefined || inline) return false
    const projections = list.projectionsBySession ?? {}
    const catalog = projections[sessionId]?.values.subagentCatalog ?? []
    return catalog.some(entry => entry.mode !== 'external'
      && (list.byId[entry.id]?.running === true
        || projections[entry.id]?.values.subagentTiming?.active !== undefined))
  }, [tasks.tasks, list, sessionId, active, inline])
  const now = useNow(ticking)

  const rows = useMemo<HeaderRow[]>(() => {
    if (sessionId === undefined) return []
    const projections = list.projectionsBySession ?? {}
    const catalog: readonly BoardCatalogEntry[] = projections[sessionId]?.values.subagentCatalog ?? []

    // CLI 任务的用量按 taskId 摊平（最近 20 次已结算的）。
    const usage: Record<string, HeaderTokenUsage | undefined> = {}
    for (const projection of Object.values(projections)) {
      for (const run of projection?.values.maestroCliUsage?.recent ?? []) {
        usage[run.taskId] = {
          uncachedInputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          cacheReadTokens: run.cachedInputTokens,
          cacheWriteTokens: run.cacheWriteTokens,
        }
      }
    }

    const cliTasks: readonly MaestroTaskSummary[] = [...new Map(tasks.tasks.filter(task => task.sessionId === sessionId).map(task => [task.id, task])).values()]
    const cliIds = new Set(cliTasks.map(task => task.id))
    const out: HeaderRow[] = []
    const catalogEntries = [...new Map(catalog.map(entry => [entry.id, entry])).values()]

    for (const entry of catalogEntries) {
      if (entry.mode === 'external') continue
      const mirroredTaskId = entry.id.startsWith('cli-') ? entry.id.slice(4) : entry.id
      if (cliIds.has(mirroredTaskId)) continue
      if (entry.id.startsWith('cli-task-')) {
        out.push({ key: `cli:${mirroredTaskId}`, target: mirroredTaskId, cli: true, executor: 'CLI', label: entry.label ?? mirroredTaskId, sub: 'CLI 任务详情', running: false, failed: false })
        continue
      }
      const child = list.byId[entry.id]
      const timing = projections[entry.id]?.values.subagentTiming
      const running = child?.running === true
      const durationMs = timing?.active !== undefined
        ? Math.max(0, now - timing.active.since)
        : timing?.settledMs
      const tokens = projections[entry.id]?.values.tokenUsage
      out.push({
        key: `agent:${entry.id}`,
        label: entry.label ?? child?.displayTitle ?? entry.id,
        // 模式词（可续接/一次性）按要求去掉：行头徽标已说明执行者，副行只留
        // 耗时——没采到 timing 就是空副行。
        sub: timingSummary(timing, now) ?? '',
        running,
        failed: false,
        ...(tokens === undefined ? {} : { tokens }),
        ...(durationMs === undefined ? {} : { durationMs }),
        target: entry.id,
        childAddress: {
          parentSessionId: sessionId,
          childSessionId: entry.id,
          mode: entry.mode === 'one-shot' || entry.mode === 'continuable' ? entry.mode : 'unknown',
        },
        executor: 'DSH',
      })
    }

    for (const task of cliTasks) {
      const tokens = task.usage ?? usage[task.id]
      out.push({
        key: `cli:${task.id}`,
        label: task.title,
        // 执行者已在行头徽标里（claude/codex），副行不再重复 CLI 名。
        sub: [statusTextOf(task.phase), task.model === '' ? undefined : task.model]
          .filter((part): part is string => part !== undefined).join(' · '),
        running: task.phase === 'running' || task.phase === 'queued',
        failed: task.phase === 'failed' || task.phase === 'timeout',
        ...(tokens === undefined ? {} : { tokens }),
        durationMs: taskDuration(task, now),
        usageMeasured: task.usage !== undefined,
        cli: true,
        cliTask: task,
        target: task.id,
        executor: task.cli,
      })
    }

    // 别的插件写的 external 目录行：没有 task 可合并，保留成不可点的叶子。
    for (const entry of catalogEntries) {
      if (entry.mode !== 'external') continue
      const mirroredTaskId = entry.id.startsWith('cli-') ? entry.id.slice(4) : entry.id
      const mirrored = cliIds.has(mirroredTaskId) || out.some(row => row.key === `cli:${mirroredTaskId}`)
      if (mirrored) continue
      out.push({
        key: `external:${entry.id}`,
        label: entry.label ?? entry.id,
        sub: '外部任务',
        running: false,
        failed: false,
      })
    }

    return out.sort((left, right) => {
      if (left.running !== right.running) return left.running ? -1 : 1
      return left.label.localeCompare(right.label, 'zh-Hans-CN')
    })
  }, [sessionId, list, tasks.tasks, now, inline])

  const executorCounts = EXECUTOR_ORDER.map(executor => ({ executor, count: rows.filter(row => row.executor === executor).length })).filter(item => item.count > 0)
  const runningCount = rows.filter(row => row.running).length
  const hasFeedback = tasks.error !== undefined || tasks.loading
  const team = projection?.values.agentTeam as { readonly enabled?: boolean; readonly tasks?: readonly { readonly status?: string }[]; readonly failure?: unknown } | undefined
  const teamContent = props.footerAvailable === true && team?.enabled === true
    && (team.tasks?.some(task => task.status !== 'deleted') === true || team.failure !== undefined)
  const visible = (rows.length > 0 || hasFeedback || teamContent || catalogUncertain) && sessionId !== undefined && !isChild
  const title = rows.length > 0 ? `${String(rows.length)} 个${catalogUncertain ? '已知' : ''}子智能体` : '子智能体 / 协作'
  useEffect(() => {
    if (!visible) setOpen(false)
  }, [visible])

  const close = useCallback(() => {
    setOpen(false)
    if (!inline) rootRef.current?.querySelector<HTMLButtonElement>('[data-dmc-trigger]')?.focus()
  }, [inline])
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (rootRef.current?.contains(event.target) === true) return
      if (menuRef.current?.contains(event.target) === true) return
      close()
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  const fallbackId = props.fallbackTask?.taskId ?? sessionTask?.target
  const fallbackCli = props.fallbackTask?.cli ?? sessionTask?.cliTask?.cli
  const overlay = fallbackId === undefined ? null : createPortal(
    <div style={{ position: 'fixed', inset: 24, zIndex: 121 }}>
      <SessionPage taskId={fallbackId} {...(fallbackCli === undefined ? {} : { cli: fallbackCli })} {...(sessionId === undefined ? {} : { sessionIds: [sessionId] })} {...(access === undefined ? {} : { access })} onClose={() => { setSessionTask(undefined); props.onCloseFallback?.() }} />
    </div>, document.body)
  if (!visible) return overlay

  const toggle = (): void => {
    if (open) { setOpen(false); return }
    setOpenError(undefined)
    const trigger = rootRef.current?.querySelector('button')
    if (trigger === null || trigger === undefined) return
    const rect = trigger.getBoundingClientRect()
    setMenuAt({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 348)),
      top: rect.bottom + 6,
    })
    setOpen(true)
  }

  return (
    <div className={inline ? 'dmch-wrap dmch-footer' : 'dmch-wrap'} ref={rootRef} data-dmc-chip="">
      <style data-maestro-header="catalog">{HEADER_CSS}</style>
      {inline ? null : <button
        type="button"
        className={`dmch-trigger${open ? ' dmch-trigger-on' : ''}`}
        data-dmc-trigger=""
        aria-haspopup="tree"
        aria-expanded={open}
        aria-label={`${title}${executorCounts.length === 0 ? '' : `；${executorCounts.map(item => `${EXECUTOR_NAMES[item.executor]} ${item.count} 个`).join('，')}`}`}
        onClick={toggle}
      >
        {runningCount > 0 ? <span className="dmch-dot dmch-dot-running" /> : undefined}
        <span>{title}</span>
        <span className="dmch-executors" aria-hidden="true">
          {executorCounts.map(({ executor, count }) => <span key={executor} className="dmch-executor-summary" data-cli-summary={executor}
            title={`${EXECUTOR_NAMES[executor]} · ${String(count)} 个`}>
            <ExecutorIcon executor={executor} /><span>{count}</span>
          </span>)}
        </span>
        <svg className="dmch-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>}
      {inline || (open && menuAt !== undefined)
        ? ((panel: ReactNode) => inline ? panel : createPortal(panel, document.body))(
          <div
            className={inline ? 'dmch-menu dmch-inline' : 'dmch-menu'}
            ref={menuRef}
            style={inline ? undefined : { left: menuAt?.left, top: menuAt?.top }}
            role="tree"
            aria-label="子智能体"
            // 菜单 portal 到 body，脱离 wrap 的 data-dmc-chip 作用域；行头
            // 执行者徽标要靠这个属性拿到 accent.ts 的品牌色/logo。
            data-dmc-chip=""
          >
            <div className="dmch-menu-head">
              <span>{runningCount > 0 ? `${String(runningCount)} 个运行中` : '全部已结束'}</span>
              <span>{rows.length > 0 ? title : tasks.loading || catalogPending ? '读取中' : '列表不可用'}</span>
            </div>
            <div className="dmch-menu-scroll">
            <div className="dmch-menu-body">
              {rows.map((row) => {
                const tokens = headerTokenText(row.tokens, row)
                const missingNativeSeat = row.childAddress !== undefined && !nativeAside
                const canOpen = row.target !== undefined && !missingNativeSeat
                return (
                  <button
                    key={row.key}
                    type="button"
                    role="treeitem"
                    className={`dmch-row${canOpen ? ' dmch-row-open' : ''}`}
                    disabled={!canOpen}
                    onClick={!canOpen ? undefined : () => {
                      if (row.cli === true) {
                        if (row.cliTask === undefined || !jumpBoardCliSession(host ?? EMPTY_HOST, row.cliTask, sessionId === undefined ? undefined : [sessionId])) {
                          if (props.openCliFallback !== undefined && row.target !== undefined) props.openCliFallback(row.target, row.cliTask?.cli)
                          else setSessionTask(row)
                        }
                      } else if (row.childAddress === undefined || !jumpBoardAddress(host ?? EMPTY_HOST, row.childAddress)) {
                        setOpenError('无法打开 DSH 子会话，请确认右侧会话栏已加载后重试。')
                        return
                      }
                      close()
                    }}
                    title={[row.label, tokens, row.durationMs === undefined ? undefined : formatDuration(row.durationMs), missingNativeSeat ? '右侧 DSH 会话栏尚未加载' : undefined]
                      .filter((part): part is string => part !== undefined).join(' · ')}
                  >
                    <RowDot row={row} />
                    <span className="dmch-main">
                      <span className="dmch-line">
                        {row.executor === undefined ? undefined : (
                          <span className="dmch-badge" data-cli-executor={row.executor}
                            title={row.executor === 'DSH' ? DSH_BADGE_TITLE : `CLI · ${row.executor}`}>
                            <ExecutorIcon executor={row.executor} />
                            <span>{EXECUTOR_NAMES[row.executor] ?? row.executor}</span>
                          </span>
                        )}
                        <span className="dmch-label">{row.label}</span>
                      </span>
                      {row.sub === '' ? undefined : <span className="dmch-sub">{row.sub}</span>}
                    </span>
                    <span className="dmch-metrics">
                      <span>{headerTokenText(row.tokens, row)}</span>
                      <span>{row.durationMs === undefined ? '' : formatDuration(row.durationMs)}</span>
                    </span>
                  </button>
                )
              })}
            </div>
            {props.footerAvailable === true ? <div className="dmch-extension">{props.renderFooter?.()}</div> : null}
            </div>
            {catalogError ? <div className="dmch-foot" role="alert">DSH 子智能体目录读取失败；这里只显示已知条目，请刷新后重试。</div> : null}
            {catalogPending ? <div className="dmch-foot" role="status">DSH 子智能体目录尚未读取完成；这里只显示已知条目。</div> : null}
            {catalogUnavailable ? <div className="dmch-foot" role="status">DSH 子智能体目录信息暂不可用；这里只显示已知条目。</div> : null}
            {tasks.error === undefined ? null : <div className="dmch-foot" role="alert">CLI 任务列表无法读取：{tasks.error}</div>}
            {tasks.loading && rows.length === 0 ? <div className="dmch-foot" role="status">正在读取 CLI 任务</div> : null}
            {openError === undefined ? null : <div className="dmch-foot" role="alert">{openError}</div>}
            <div className="dmch-foot">图标标明执行器；同一任务去重显示，未采集用量不代表零消耗。</div>
          </div>,
        )
        : undefined}
      {overlay}
    </div>
  )
}

function statusTextOf(phase: MaestroTaskSummary['phase']): string {
  switch (phase) {
    case 'queued': return '排队中'
    case 'running': return '运行中'
    case 'done': return '已完成'
    case 'failed': return '失败'
    case 'timeout': return '超时'
    case 'cancelled': return '已取消'
    case 'interrupted': return '已中断'
  }
}
