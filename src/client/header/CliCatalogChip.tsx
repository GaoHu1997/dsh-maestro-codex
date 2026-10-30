/**
 * 会话页头的「N 个子智能体」替换版。
 *
 * 内核那颗 chip（`conversation.session.header.actions` 的 `subagent-catalog`）
 * 只渲染有本地 Session 的目录行：CLI 子代理是 `mode: 'external'`，没有子会话，
 * 所以既没有运行状态、也没有 token。目录投影本身不携带这些字段，改数据补不进去。
 *
 * 这里在同一个 slot 里注册一颗自己的 chip，并把内核那颗用 CSS 让位：
 *
 * - 直接子代理（本地）保留原名、运行点、token、耗时，点击还是打开会话；
 * - CLI 子代理合并显示阶段、耗时、token（`maestroCliUsage` 投影）；
 * - 计数把两类合在一起，页头因此看得到“现在总共几个子智能体、谁在跑”。
 *
 * 内核 DOM 一旦改结构，`:has(...)` 选择器会失效——失效的后果是两颗 chip 同时
 * 出现，而不是丢信息，所以不做更深的 DOM 改写。
 *
 * @module dsh-maestro-codex/client/header/CliCatalogChip
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { CLI_LABELS, type MaestroTaskSummary } from '../../wire.js'
import {
  formatDuration, formatTokens, taskDuration, timingSummary, tokenSummary,
  type BoardCatalogEntry, type BoardTokenUsage,
} from '../board/model.js'
import {
  sessionOpener, useCliTasks, useNow, useSessionList, type BoardHost,
} from '../board/data.js'

/** 页头 chip 的样式表 id（幂等注入）。 */
const HEADER_STYLE_ID = 'dsh-maestro-codex-header-styles'

/** 生效期间挂在 body 上，让 CSS 只隐藏内核 chip 而不影响其它页。 */
const BODY_FLAG = 'data-maestro-cli-header'

const HEADER_CSS = `
.dmch-wrap { display: inline-flex; align-items: center; min-width: 0; position: relative; }
.dmch-trigger {
  display: inline-flex; align-items: center; gap: 4px; min-height: 28px; padding: 3px 2px;
  border: 0; border-radius: var(--dsw-radius-sm, 6px); background: none; cursor: pointer;
  color: var(--dsw-alias-label-tertiary, var(--dsh-text-tertiary, #646d80));
  font: inherit; font-size: 12px; line-height: 18px; white-space: nowrap;
}
.dmch-trigger:hover, .dmch-trigger:focus-visible { color: var(--dsw-alias-label-primary, var(--dsh-text-primary, #1a1e26)); }
.dmch-trigger svg { flex: none; transition: transform .12s ease; }
.dmch-trigger-on svg.dmch-chevron { transform: rotate(180deg); }
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
.dmch-menu-body { display: flex; flex-direction: column; gap: 1px; overflow: auto; }
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
  flex: none; padding: 0 4px; border-radius: 3px; border: 1px solid var(--dsw-alias-border-l2, #dce0e8);
  font-size: 9.5px; line-height: 14px; font-weight: 600; color: var(--dsw-alias-label-tertiary, #646d80);
}
.dmch-badge-cli { color: #10a37f; border-color: color-mix(in srgb, #10a37f 45%, transparent); }
.dmch-sub { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary, #646d80); }
.dmch-metrics {
  flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 1px;
  font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary, #646d80);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.dmch-empty { padding: 12px 10px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #646d80); text-align: center; }
.dmch-foot { padding: 4px 8px 6px; font-size: 10px; color: var(--dsw-alias-label-tertiary, #646d80); }

/* 内核那颗 chip 只在 body 标记存在时让位；标记由下面的 effect 打在它的根节点上。
 * 选择器/标记失效的后果只是两颗并存，不会丢信息。第二行是兜底：直接把内核
 * 触发器按钮藏掉（自己的按钮带 data-dmc-trigger，不会被选中）。 */
body[${BODY_FLAG}] [data-maestro-core-chip] { display: none !important; }
body[${BODY_FLAG}] button[aria-haspopup="tree"][aria-label*="子智能体"]:not([data-dmc-trigger]),
body[${BODY_FLAG}] button[aria-haspopup="tree"][aria-label*="subagent" i]:not([data-dmc-trigger]) { display: none !important; }
`

/** 没有 host 时的稳定空壳（避免每次渲染新建对象导致订阅反复重建）。 */
const EMPTY_HOST: BoardHost = { get: () => undefined }

let headerStyleInjected = false
let bodyFlagUsers = 0

function useHeaderStyles(): void {
  useEffect(() => {
    if (headerStyleInjected) return
    headerStyleInjected = true
    if (document.querySelector(`style[data-maestro-header=${JSON.stringify(HEADER_STYLE_ID)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.maestroHeader = HEADER_STYLE_ID
      tag.textContent = HEADER_CSS
      document.head.appendChild(tag)
    }
  }, [])
}

function useBodyFlag(on: boolean): void {
  useEffect(() => {
    if (!on) return
    bodyFlagUsers += 1
    document.body.setAttribute(BODY_FLAG, '1')
    return () => {
      bodyFlagUsers -= 1
      if (bodyFlagUsers <= 0) document.body.removeAttribute(BODY_FLAG)
    }
  }, [on])
}

/** 页头一行：本地子代理、CLI 子代理、其它 external 目录行共用。 */
interface HeaderRow {
  readonly key: string
  readonly label: string
  readonly sub: string
  readonly running: boolean
  readonly failed: boolean
  readonly tokens?: BoardTokenUsage
  readonly usageMeasured?: boolean
  readonly durationMs?: number
  readonly target?: string
  readonly cli?: boolean
}

/** 一颗点。 */
function RowDot({ row }: { readonly row: HeaderRow }): ReactNode {
  const state = row.failed ? 'failed' : row.running ? 'running' : 'done'
  return <span className={`dmch-dot dmch-row-dot dmch-dot-${state}`} />
}

function totalOf(tokens: BoardTokenUsage | undefined): number {
  if (tokens === undefined) return 0
  return tokens.uncachedInputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
}

export function headerTokenText(tokens: BoardTokenUsage | undefined, options: { readonly cli?: boolean; readonly running?: boolean; readonly usageMeasured?: boolean } = {}): string {
  const total = totalOf(tokens)
  if (total > 0 || options.usageMeasured === true) return `${formatTokens(total)} tok`
  if (options.cli === true) return options.running === true ? '尚未收到用量' : '用量未采集'
  return ''
}

/**
 * 页头 chip 组件。
 *
 * slot 注入了 `host`（会话 feed 的入口），标准 props 带来当前的 `sessionId`。
 */
export function CliCatalogChip(props: { readonly sessionId?: string; readonly host?: BoardHost }): ReactNode {
  useHeaderStyles()
  const { sessionId, host } = props
  const [open, setOpen] = useState(false)
  const [menuAt, setMenuAt] = useState<{ left: number; top: number }>()
  const rootRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const list = useSessionList(host ?? EMPTY_HOST)
  const now = useNow(true)
  const tasks = useCliTasks(true, sessionId === undefined ? undefined : [sessionId])
  const opener = useMemo(() => (host === undefined ? undefined : sessionOpener(host)), [host])

  const session = sessionId === undefined ? undefined : list.byId[sessionId]
  const isChild = session?.origin === 'subagent'

  const rows = useMemo<HeaderRow[]>(() => {
    if (sessionId === undefined || list.byId[sessionId] === undefined) return []
    const projections = list.projectionsBySession ?? {}
    const catalog: readonly BoardCatalogEntry[] = projections[sessionId]?.values.subagentCatalog ?? []

    // CLI 任务的用量按 taskId 摊平（最近 20 次已结算的）。
    const usage: Record<string, BoardTokenUsage | undefined> = {}
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

    const cliTasks: readonly MaestroTaskSummary[] = tasks.tasks.filter(task => task.sessionId === sessionId)
    const cliIds = new Set(cliTasks.map(task => task.id))
    const out: HeaderRow[] = []

    for (const entry of catalog) {
      if (entry.mode === 'external') continue
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
        sub: [entry.mode === 'continuable' ? '可续接' : entry.mode === 'one-shot' ? '一次性' : entry.mode,
          timingSummary(timing, now)].filter((part): part is string => part !== undefined && part !== '').join(' · '),
        running,
        failed: false,
        ...(tokens === undefined ? {} : { tokens }),
        ...(durationMs === undefined ? {} : { durationMs }),
        target: entry.id,
      })
    }

    for (const task of cliTasks) {
      const tokens = task.usage ?? usage[task.id]
      out.push({
        key: `cli:${task.id}`,
        label: task.title,
        sub: [CLI_LABELS[task.cli], statusTextOf(task.phase), task.model === '' ? undefined : task.model]
          .filter((part): part is string => part !== undefined).join(' · '),
        running: task.phase === 'running' || task.phase === 'queued',
        failed: task.phase === 'failed' || task.phase === 'timeout',
        ...(tokens === undefined ? {} : { tokens }),
        durationMs: taskDuration(task, now),
        usageMeasured: task.usage !== undefined,
        cli: true,
      })
    }

    // 别的插件写的 external 目录行：没有 task 可合并，保留成不可点的叶子。
    for (const entry of catalog) {
      if (entry.mode !== 'external') continue
      // 插件自己写的 CLI 目录行 childId 就是 taskId（早期版本还用过 `cli-` 前缀）。
      const mirrored = cliIds.has(entry.id) || (entry.id.startsWith('cli-') && cliIds.has(entry.id.slice(4)))
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
  }, [sessionId, list, tasks.tasks, now])

  const runningCount = rows.filter(row => row.running).length
  /* 只有存在 CLI 子代理时才接管：纯本地子代理的会话保留内核那颗（它的菜单
   * 更完整，有会话预览和更细的 metrics）。这样覆盖范围最小，也避免两颗
   * 计数不同的 chip 同时出现。 */
  const hasCli = rows.some(row => row.cli === true)
  const visible = rows.length > 0 && hasCli && sessionId !== undefined && !isChild
  useBodyFlag(visible)

  /* 把内核那颗 chip 藏起来：slot 条目按 id 去重且先注册者胜，插件无法注销它，
   * 只能在自己的 chip 挂载后从 DOM 上让位。只认带「子智能体/subagent」的
   * aria-label 且不在本 chip 内的触发器，避免误伤作业、用量等其它页头按钮。 */
  useEffect(() => {
    if (!visible) return
    const slot = document.querySelector('[data-slot="conversation.session.header.actions"]')
    if (slot === null) return
    const marked = new Set<HTMLElement>()
    const apply = (): void => {
      for (const trigger of slot.querySelectorAll<HTMLElement>('button[aria-haspopup="tree"]')) {
        if (trigger.closest('[data-dmc-chip]') !== null) continue
        if (!/(个子智能体|subagent)/i.test(trigger.getAttribute('aria-label') ?? '')) continue
        const parent = trigger.parentElement
        // 根节点若还挂着别的按钮就不整块藏，只藏触发器本身。
        const target = parent !== null && parent.querySelectorAll('button').length === 1 ? parent : trigger
        target.setAttribute('data-maestro-core-chip', '1')
        marked.add(target)
      }
    }
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(slot, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      for (const element of marked) element.removeAttribute('data-maestro-core-chip')
    }
  }, [visible])

  const close = useCallback(() => { setOpen(false) }, [])
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

  if (!visible) return null

  const toggle = (): void => {
    if (open) { setOpen(false); return }
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
    <span className="dmch-wrap" ref={rootRef} data-dmc-chip="">
      <button
        type="button"
        className={`dmch-trigger${open ? ' dmch-trigger-on' : ''}`}
        data-dmc-trigger=""
        aria-haspopup="tree"
        aria-expanded={open}
        aria-label={`${String(rows.length)} 个子智能体`}
        onClick={toggle}
      >
        {runningCount > 0 ? <span className="dmch-dot dmch-dot-running" /> : undefined}
        <span>{rows.length} 个子智能体</span>
        <svg className="dmch-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && menuAt !== undefined
        ? createPortal(
          <div
            className="dmch-menu"
            ref={menuRef}
            style={{ left: menuAt.left, top: menuAt.top }}
            role="tree"
            aria-label="子智能体"
          >
            <div className="dmch-menu-head">
              <span>{runningCount > 0 ? `${String(runningCount)} 个运行中` : '全部已结束'}</span>
              <span>{rows.length} 个</span>
            </div>
            <div className="dmch-menu-body">
              {rows.map((row) => {
                const tokens = tokenSummary(row.tokens)
                return (
                  <button
                    key={row.key}
                    type="button"
                    role="treeitem"
                    className={`dmch-row${row.target === undefined ? '' : ' dmch-row-open'}`}
                    disabled={row.target === undefined}
                    onClick={row.target === undefined || opener === undefined ? undefined : () => { opener(row.target as string); close() }}
                    title={[row.label, tokens, row.durationMs === undefined ? undefined : formatDuration(row.durationMs)]
                      .filter((part): part is string => part !== undefined).join(' · ')}
                  >
                    <RowDot row={row} />
                    <span className="dmch-main">
                      <span className="dmch-line">
                        {row.cli === true ? <span className="dmch-badge dmch-badge-cli">CLI</span> : undefined}
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
            <div className="dmch-foot">显示已采集的 CLI 用量；未采集不代表零消耗</div>
          </div>,
          document.body,
        )
        : undefined}
    </span>
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
  }
}
