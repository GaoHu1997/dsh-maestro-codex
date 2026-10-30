/**
 * 任务看板（右侧栏 tab）——**一棵树**里看全部正在进行的事。
 *
 * 骨架是 DSH 会话树（当前会话是根，`subagentCatalog` + 会话血缘铺开子代理），
 * 再把另外两类任务按**归属会话**挂成那个会话的子节点：
 *
 * - **CLI 子代理**：本插件 `dispatch_cli_task` 派出去的 claude/codex cli 任务，
 *   挂在派发它的会话下面（`MaestroTaskSummary.sessionId`），阶段/耗时/退出码
 *   在行内可见，点开能看实时日志、能取消；
 * - **后台任务**：宿主 `ctx.jobs` 名册里的 job（bash/pwsh/subagent…），**不进
 *   会话树**——单独画在底部的固定高度列表里（占面板总高度的 1/5），可看保留
 *   输出、可终止、可跳到所属会话。
 *
 * 视觉照 `dsh-better-sidebar` 的 Tasks 树，提供两套画法（底栏切换，默认「图」）：
 *
 * - **图**：按层级折成「带」，父在上、子横排居中，带间用一条竖线连起来——就是
 *   截图里那种父子卡片树；面板窄，所以不做绝对定位的力导向布局。
 * - **树**：缩进 + 连接线的列表，需要逐行读细节时更省地方。
 *
 * 树的下方是一块**固定高度（总高度的 1/5）的后台任务列表**：作业不混进树，
 * 单独一行一个，点开仍是同一个「节点详情」浮层。
 *
 * 两套都用同一份节点数据：状态点 + 种类图标 + 标题（含模式 chip）+ 元信息行；
 * 点节点开「节点详情」浮层（状态 / 模式 / Token / 耗时 + 动作 + 转录），
 * 有子级时另有「收起 / 展开」手势，只收子树。
 *
 * 纯 React + 一份注入式样式表（web 壳没有 CSS 管线，面板要自带样式）。
 *
 * @module dsh-maestro-codex/client/board/Board
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { CLI_LABELS, cleanLogText, type MaestroTaskEvent, type MaestroTaskSummary } from '../../wire.js'
import {
  attachRows, buildSessionTree, cliStatusOf, collectTreeIds, countActive, expandFolds, filterTree, flattenTree,
  foldFinished, formatClock, formatDuration, jobLive, jobNode, jobStatusOf, matchesFilter, taskCancellable,
  taskDuration, timingSummary, tokenSummary, CLI_NODE_PREFIX, FOLD_NODE_PREFIX, JOB_NODE_PREFIX,
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

/** 子代理模式的短词（对应截图里「子代理可续接」那颗 chip）。 */
function modeChip(mode: string | undefined): string | undefined {
  switch (mode) {
    case 'continuable': return '可续接'
    case 'one-shot': return '一次性'
    case 'external': return '外部'
    default: return undefined
  }
}

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
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  padding: 10px 10px 8px;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--dmb-fg);
}
.dmb, .dmb *, .dmb *::before, .dmb *::after { box-sizing: border-box; }

/* --- head --- */
.dmb-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; flex: none; }
.dmb-headtitle { font-size: 14px; font-weight: 650; letter-spacing: -.01em; }
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
.dmb-btn-primary {
  color: var(--dmb-accent); border-color: color-mix(in srgb, var(--dmb-accent) 45%, var(--dmb-border));
  background: color-mix(in srgb, var(--dmb-accent) 10%, transparent);
}

/* --- filters --- */
.dmb-filters { display: flex; flex-wrap: wrap; gap: 5px; flex: none; }
.dmb-filter {
  font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 999px; cursor: pointer;
  color: var(--dmb-fg3); background: transparent; border: 1px solid var(--dmb-border);
  display: inline-flex; align-items: center; gap: 4px;
}
.dmb-filter:hover { color: var(--dmb-fg); background: var(--dmb-hover); }
.dmb-filter-on { color: var(--dmb-accent); border-color: color-mix(in srgb, var(--dmb-accent) 45%, transparent); background: color-mix(in srgb, var(--dmb-accent) 10%, transparent); }
.dmb-filter b { font-weight: 600; opacity: .75; }

/* --- 树 --- */
.dmb-tree {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
  display: flex; flex-direction: column; gap: 4px;
  padding: 2px 2px 6px;
  scrollbar-width: thin;
}
.dmb-node { position: relative; min-width: 0; }
.dmb-row {
  display: flex; align-items: flex-start; gap: 7px; min-width: 0;
  padding: 6px 8px; border-radius: 8px; cursor: pointer;
  background: var(--dmb-panel); border: 1px solid var(--dmb-border);
}
.dmb-row:hover { background: var(--dmb-hover); }
.dmb-row:focus-visible { outline: 2px solid color-mix(in srgb, var(--dmb-accent) 55%, transparent); outline-offset: -1px; }
.dmb-row-root { border-color: color-mix(in srgb, var(--dmb-accent) 32%, var(--dmb-border)); }
.dmb-row-on { border-color: color-mix(in srgb, var(--dmb-accent) 65%, var(--dmb-border)); }
.dmb-row-on::before {
  content: ''; position: absolute; left: 0; top: 6px; bottom: 6px; width: 2px; border-radius: 1px;
  background: var(--dmb-accent);
}
.dmb-row-settled { opacity: .68; }
.dmb-row-settled:hover { opacity: 1; }
/* 折叠组：虚线边框，跟真实节点区分开。 */
.dmb-row-fold, .dmb-gcard-fold { border-style: dashed; }
.dmb-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; margin-top: 6px; background: var(--dmb-fg3); }
.dmb-dot-running { background: var(--dmb-accent); animation: dmb-pulse 1.4s ease-in-out infinite; }
.dmb-dot-queued { background: var(--dmb-warn); }
.dmb-dot-done { background: var(--dmb-ok); }
.dmb-dot-failed { background: var(--dmb-danger); }
.dmb-dot-cancelled, .dmb-dot-idle { background: var(--dmb-fg3); }
.dmb-glyph { flex: none; display: inline-flex; align-items: center; margin-top: 2px; color: var(--dmb-fg3); }
.dmb-content { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dmb-titleline { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dmb-title {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12.5px; font-weight: 600;
}
.dmb-title-ghost { color: var(--dmb-fg2); font-style: italic; }
.dmb-chip {
  flex: none; max-width: 46%; font-size: 10px; font-weight: 600; padding: 0 5px; border-radius: 4px;
  border: 1px solid var(--dmb-border); color: var(--dmb-fg2); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.dmb-chip-claude { color: #d97757; border-color: color-mix(in srgb, #d97757 45%, transparent); }
.dmb-chip-codex { color: #10a37f; border-color: color-mix(in srgb, #10a37f 45%, transparent); }
.dmb-chip-fold { border-style: dashed; }
.dmb-meta {
  display: flex; align-items: center; gap: 5px; min-width: 0;
  font-size: 10.5px; color: var(--dmb-fg3);
}
.dmb-meta-mono { font-family: var(--dmb-mono); }
.dmb-meta > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dmb-sep { flex: none; opacity: .5; }
.dmb-disclosure {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; margin: 3px 0 0 auto; padding: 0;
  border: 0; border-radius: 3px; background: transparent; color: var(--dmb-fg3); cursor: pointer;
}
.dmb-disclosure:hover { color: var(--dmb-fg); background: var(--dmb-border); }
.dmb-kids { position: relative; margin-left: 11px; padding-left: 14px; margin-top: 4px; display: flex; flex-direction: column; gap: 4px; }
.dmb-kids::before { content: ''; position: absolute; left: 0; top: -4px; bottom: 12px; width: 1px; background: var(--dmb-border); }
.dmb-kids > .dmb-node::before { content: ''; position: absolute; left: -14px; top: 15px; width: 12px; height: 1px; background: var(--dmb-border); }
.dmb-empty { margin: 0; padding: 10px; font-size: 11.5px; color: var(--dmb-fg3); border: 1px dashed var(--dmb-border); border-radius: 8px; text-align: center; }

/* --- 节点详情浮层：贴着被点的节点，不再固定停在角落 --- */
.dmb-detail {
  position: absolute; z-index: 11;
  width: min(300px, calc(100% - 20px)); max-height: min(62%, 420px);
  display: flex; flex-direction: column; gap: 5px; overflow: hidden;
  padding: 9px 10px; border-radius: 10px;
  background: var(--dmb-panel); border: 1px solid var(--dmb-border);
  box-shadow: 0 10px 28px light-dark(rgba(15, 23, 42, .18), rgba(0, 0, 0, .55));
}
.dmb-detailhead { display: flex; align-items: center; gap: 6px; }
.dmb-detailtitle { font-size: 11px; font-weight: 650; letter-spacing: .03em; text-transform: uppercase; color: var(--dmb-fg3); }
.dmb-detailclose { margin-left: auto; padding: 1px 6px; font-size: 10.5px; }
.dmb-detailname { font-size: 12.5px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 键值对两列排布，省一半高度；值过长时换行而不是撑宽。 */
.dmb-kv { display: grid; grid-template-columns: auto 1fr; gap: 1px 8px; font-size: 10.5px; line-height: 1.5; }
.dmb-kvrow { display: contents; }
.dmb-kvkey { color: var(--dmb-fg3); white-space: nowrap; }
.dmb-kvval { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dmb-fg2); }
.dmb-kvval code { font-family: var(--dmb-mono); font-size: 10px; }
.dmb-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 1px; }
.dmb-actions .dmb-btn { font-size: 10.5px; padding: 1px 7px; }
.dmb-log {
  margin: 0; padding: 5px 6px; flex: 1 1 auto; min-height: 40px; max-height: 168px; overflow: auto;
  font-family: var(--dmb-mono); font-size: 10.5px; line-height: 1.4; white-space: pre-wrap; word-break: break-word;
  background: var(--dmb-input, light-dark(#ffffff, #171a21)); border: 1px solid var(--dmb-border); border-radius: 6px;
  color: var(--dmb-fg2);
}
.dmb-log-line-err { color: var(--dmb-danger); }
.dmb-log-line-note { color: var(--dmb-fg3); }
.dmb-log-line-result { color: var(--dmb-ok); }
.dmb-note { margin: 0; font-size: 10.5px; color: var(--dmb-warn); }
.dmb-err { margin: 0; font-size: 11px; color: var(--dmb-danger); }

/* --- 图视图（父子卡片 + 连接线，照 better-sidebar 的 graph） --- */
.dmb-graph {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  display: flex; flex-direction: column; gap: 18px;
  padding: 8px 4px 12px; scrollbar-width: thin;
}
.dmb-band { position: relative; display: flex; flex-wrap: wrap; align-items: stretch; justify-content: center; gap: 8px; }
.dmb-band:not(:first-child)::before {
  content: ''; position: absolute; left: 14%; right: 14%; top: -10px; height: 1px; background: var(--dmb-border);
}
.dmb-gcard {
  position: relative; flex: 0 1 168px; min-width: 136px; max-width: 100%;
  display: flex; flex-direction: column; gap: 4px; padding: 7px 9px; border-radius: 9px; cursor: pointer;
  background: var(--dmb-panel); border: 1px solid var(--dmb-border); text-align: left;
  font: inherit; color: inherit;
}
.dmb-gcard:hover { background: var(--dmb-hover); }
.dmb-gcard:focus-visible { outline: 2px solid color-mix(in srgb, var(--dmb-accent) 55%, transparent); outline-offset: -1px; }
.dmb-gcard:not(.dmb-gcard-root)::before {
  content: ''; position: absolute; left: 50%; top: -10px; width: 1px; height: 10px; background: var(--dmb-border);
}
.dmb-gcard-root { flex: 0 1 210px; border-color: color-mix(in srgb, var(--dmb-accent) 32%, var(--dmb-border)); }
.dmb-gcard-on { border-color: color-mix(in srgb, var(--dmb-accent) 65%, var(--dmb-border)); }
.dmb-gcard-settled { opacity: .72; }
.dmb-gcard-settled:hover { opacity: 1; }
.dmb-gcard-head { display: flex; align-items: center; gap: 5px; min-width: 0; }
.dmb-gcard-head .dmb-dot { margin-top: 0; }
.dmb-gcard-title {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; font-weight: 650;
}
.dmb-gcard-title-ghost { color: var(--dmb-fg2); font-style: italic; }
.dmb-gcard-meta { display: flex; align-items: center; gap: 4px; min-width: 0; font-size: 10px; color: var(--dmb-fg3); }
.dmb-gcard-meta > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dmb-gcard-foot { display: flex; align-items: center; gap: 4px; min-width: 0; font-size: 10px; color: var(--dmb-fg3); }
.dmb-gcard-chipline { display: flex; min-width: 0; }
.dmb-gcard-foot .dmb-chip { max-width: 100%; }
.dmb-gcard-kids { margin-left: auto; flex: none; font-size: 10px; color: var(--dmb-fg3); }

/* --- 后台任务面板：固定占面板总高度的 1/5，作业单独在这里列（不进树） --- */
.dmb-jobs {
  flex: 0 0 20%; min-height: 0;
  display: flex; flex-direction: column;
  background: var(--dmb-panel); border: 1px solid var(--dmb-border); border-radius: 8px;
  overflow: hidden;
}
.dmb-jobs-head {
  flex: none; display: flex; align-items: center; gap: 5px;
  padding: 3px 8px; font-size: 11px; font-weight: 650; color: var(--dmb-fg2);
  border-bottom: 1px solid var(--dmb-border);
}
.dmb-jobs-head .dmb-glyph { margin-top: 0; }
.dmb-jobs-count { font-weight: 600; font-size: 10.5px; color: var(--dmb-fg3); }
.dmb-jobs-list {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin;
  display: flex; flex-direction: column; gap: 2px; padding: 3px 4px;
}
.dmb-jobs-empty { margin: 0; padding: 8px; font-size: 11px; color: var(--dmb-fg3); text-align: center; }
.dmb-jrow {
  flex: none; display: flex; align-items: center; gap: 7px; min-width: 0;
  padding: 3px 6px; border-radius: 6px; cursor: pointer;
}
.dmb-jrow:hover, .dmb-jrow-on { background: var(--dmb-hover); }
.dmb-jrow:focus-visible { outline: 2px solid color-mix(in srgb, var(--dmb-accent) 55%, transparent); outline-offset: -1px; }
.dmb-jrow .dmb-dot, .dmb-jrow .dmb-glyph { margin-top: 0; }
.dmb-jrow-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; font-weight: 600; }
.dmb-jrow .dmb-chip { max-width: 30%; }
.dmb-jrow-meta { margin-left: auto; flex: none; display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--dmb-fg3); white-space: nowrap; }
.dmb-jrow-kill { flex: none; font-size: 10px; padding: 0 6px; }

/* --- foot --- */
.dmb-foot { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 2px 6px; font-size: 10.5px; color: var(--dmb-fg3); }
.dmb-foot .dmb-spacer { flex: 1 1 auto; }
.dmb-foot button { font: inherit; font-size: 10.5px; padding: 0 4px; border: 0; background: none; color: var(--dmb-fg3); cursor: pointer; border-radius: 4px; }
.dmb-foot button:hover { color: var(--dmb-fg); background: var(--dmb-hover); }
.dmb-foot .dmb-viewon { color: var(--dmb-accent); font-weight: 650; }
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

/** 种类图标（16px 网格）：会话=人形、CLI=终端、作业=闪电。 */
function Glyph({ kind }: { kind: BoardNode['kind'] }): ReactNode {
  const common = { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (kind === 'cli') {
    return (
      <svg {...common} aria-hidden>
        <rect x="2" y="3" width="12" height="10" rx="2" />
        <path d="M5 7l2 2-2 2M9 11h2" />
      </svg>
    )
  }
  if (kind === 'job') {
    return (
      <svg {...common} aria-hidden>
        <path d="M9 2L4 9h3l-1 5 6-8H8.5z" />
      </svg>
    )
  }
  if (kind === 'fold') {
    return (
      <svg {...common} aria-hidden>
        <rect x="2.5" y="3.5" width="11" height="9" rx="2" />
        <path d="M5.5 8h5" />
      </svg>
    )
  }
  return (
    <svg {...common} aria-hidden>
      <rect x="3" y="5" width="10" height="8" rx="2.5" />
      <path d="M8 2.5v2.5M5.5 8.5h.01M10.5 8.5h.01" />
    </svg>
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

/** 元信息行里的一段：`<span>文字</span>`，可带分隔符。 */
function MetaBits({ parts }: { parts: readonly (string | undefined)[] }): ReactNode {
  const shown = parts.filter((part): part is string => part !== undefined && part !== '')
  if (shown.length === 0) return null
  return (
    <>
      {shown.map((part, index) => (
        <span key={part}>
          {index === 0 ? undefined : <span className="dmb-sep">·</span>}
          {index === 0 ? undefined : ' '}
          {part}
        </span>
      ))}
    </>
  )
}

/** 一个节点的元信息段：状态 · 模式 · 子级数 · 耗时 · token。 */
function metaParts(node: BoardNode, now: number): string[] {
  if (node.kind === 'fold') {
    const members = node.members ?? []
    const errors = members.filter(member => member.status === 'failed').length
    // 标题已经写了「已完成 N」，这里只在有出错时补一句，否则整行都是重复信息。
    return errors === 0 ? [] : [`出错 ${String(errors)}`]
  }
  const bits: string[] = [STATUS_LABELS[node.status]]
  if (node.kind === 'agent') {
    if (node.mode !== undefined && node.mode !== 'external') bits.push(node.mode)
    if (node.children.length > 0) bits.push(`子 ${String(node.children.length)}`)
    const timing = timingSummary(node.timing, now)
    if (timing !== undefined) bits.push(timing)
    const tokens = tokenSummary(node.tokens)
    if (tokens !== undefined) bits.push(tokens)
  } else if (node.kind === 'cli' && node.task !== undefined) {
    // CLI 名在 chip 里已经出现，meta 里就不重复了。
    bits.push(formatDuration(taskDuration(node.task, now)))
    if (node.task.exitCode !== undefined) bits.push(`退出 ${String(node.task.exitCode)}`)
  } else if (node.kind === 'job' && node.jobRow !== undefined) {
    const { job } = node.jobRow
    bits.push(formatDuration(Math.max(0, (job.finishedAt ?? now) - job.startedAt)))
    if (job.progress !== undefined) bits.push(job.progress)
  }
  return bits
}

/** 一个节点的元信息行。 */
function nodeMeta(node: BoardNode, now: number): ReactNode {
  const parts = metaParts(node, now)
  // 折叠行的标题已经说了「已完成 N」，没有额外信息时就不再占一行。
  if (parts.length === 0) return undefined
  return (
    <div className="dmb-meta">
      <MetaBits parts={parts} />
    </div>
  )
}

/** 标题行尾的模式 chip（会话=可续接/一次性；CLI=CLI 名；折叠组=成员预览）。 */
function nodeChip(node: BoardNode): ReactNode {
  if (node.kind === 'fold') {
    const members = node.members ?? []
    const names = members.slice(0, 2).map(member => member.title).join(' / ')
    const more = members.length > 2 ? ` +${String(members.length - 2)}` : ''
    return <span className="dmb-chip dmb-chip-fold">{names}{more}</span>
  }
  if (node.kind === 'cli' && node.task !== undefined) {
    return <span className={`dmb-chip dmb-chip-${node.task.cli}`}>{CLI_LABELS[node.task.cli]}</span>
  }
  if (node.kind === 'job' && node.jobRow !== undefined) {
    return <span className="dmb-chip">{node.jobRow.job.kind}</span>
  }
  const chip = modeChip(node.mode)
  if (chip === undefined) return null
  return <span className="dmb-chip">{chip}</span>
}

/** 详情浮层的锚点：相对面板左上角的坐标，`flip` 表示改画在节点上方。 */
interface DetailAnchor {
  readonly left: number
  /** 画在节点下方时用的 `top`（节点底边 + 间距）。 */
  readonly top: number
  /** 翻到节点上方时用的 `bottom`（面板底边到节点顶边的距离）。 */
  readonly bottom: number
  readonly flip: boolean
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

  // 骨架：会话树（只有 agent 节点）。
  const sessionTree = useMemo(
    () => buildSessionTree({
      rootId,
      sessions: list.byId,
      catalogs: catalogs.table,
      tokens: catalogs.tokens,
      timings: catalogs.timings,
    }),
    [rootId, list, catalogs],
  )
  const treeIds = useMemo(() => collectTreeIds(sessionTree), [sessionTree])

  const [filter, setFilter] = useState<BoardFilter>('all')
  // 默认「图」视图：父子卡片 + 连接线，一眼看清层级；需要读细节时切「树」。
  const [view, setView] = useState<'graph' | 'tree'>('graph')
  const [selected, setSelected] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  // 收起的节点 id 集合：默认全展开（树要一眼看到结构，再按需收）。
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set<string>())
  // 展开的「已完成 N」折叠组：默认全收起，点一下才摊开。
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set<string>())
  // 详情浮层的锚点（被点节点在面板里的位置），undefined = 还没点过。
  const [anchor, setAnchor] = useState<DetailAnchor | undefined>(undefined)
  const boardRef = useRef<HTMLDivElement | null>(null)

  // CLI 任务按会话树隔离：只拉当前树触发的任务，与 jobs 一致。
  const cli = useCliTasks(active, treeIds)
  const chips = useBoardJobs(ctx, treeIds, active, jobIdOf(selected))
  const selectedTask = selected !== null && selected.startsWith(CLI_NODE_PREFIX)
    ? selected.slice(CLI_NODE_PREFIX.length)
    : null
  const detail = useCliDetail(selectedTask, active, treeIds)
  const opener = useMemo(() => sessionOpener(ctx), [ctx])

  // 把 CLI 子代理挂到各自归属的会话下面；后台作业不进树，走底部的独立面板。
  const attached = useMemo(
    () => attachRows(sessionTree, { tasks: cli.tasks }),
    [sessionTree, cli.tasks],
  )
  // 后台作业折成同一套节点模型：面板行、计数、详情浮层共用。
  const jobNodes = useMemo(() => chips.rows.map(jobNode), [chips.rows])
  // 再把同层已结束的兄弟收成「已完成 N」一行，然后按 opened 摊开其中一部分。
  const tree = useMemo(
    () => expandFolds(foldFinished(attached), opened),
    [attached, opened],
  )
  const rows = useMemo(() => flattenTree(tree), [tree])
  // 计数与详情查找走折叠前的树：折叠组会把成员藏起来，但统计不该少算。
  const allRows = useMemo(() => flattenTree(attached), [attached])

  const agentRows = allRows.filter(row => row.depth > 0 && row.kind === 'agent')
  const cliNodes = allRows.filter(row => row.kind === 'cli')
  // 筛选计数覆盖整个看板：树上的行 + 面板里的后台作业。
  const statuses = [...allRows.map(row => row.status), ...jobNodes.map(node => node.status)]
  const activeCount = countActive(statuses)
  const filterCount = (id: BoardFilter): number => statuses.filter(status => matchesFilter(status, id)).length

  const refreshAll = useCallback(() => { cli.refresh() }, [cli])

  /** 点节点：开/关详情浮层，并把锚点定在刚点的那个节点上。 */
  const select = useCallback((id: string, element: HTMLElement | null) => {
    const board = boardRef.current
    setSelected(current => (current === id ? null : id))
    setShowLog(false)
    if (board === null || element === null) { setAnchor(undefined); return }
    const box = board.getBoundingClientRect()
    const rect = element.getBoundingClientRect()
    const top = rect.bottom - box.top + 6
    setAnchor({
      left: Math.max(6, Math.min(rect.left - box.left, box.width - 312)),
      top,
      // 翻到节点上方：浮层的底边贴着节点顶边。
      bottom: box.height - (rect.top - box.top) + 6,
      // 下方空间不够时翻上去，避免浮层被面板底边裁掉。
      flip: top > box.height * 0.52,
    })
  }, [])
  const closeDetail = useCallback(() => { setSelected(null); setShowLog(false); setAnchor(undefined) }, [])

  /** 收起/展开：折叠组走 `opened`，普通节点走 `folded`。 */
  const fold = useCallback((id: string) => {
    if (id.startsWith(FOLD_NODE_PREFIX)) {
      setOpened((current) => {
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      return
    }
    setFolded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const unfoldAll = useCallback(() => {
    setFolded(new Set<string>())
    setOpened(new Set<string>())
  }, [])
  /** 全收起：只留根，以及被选中的那个节点的祖先链（否则详情浮层失去锚点）。 */
  const foldAll = useCallback(() => {
    setFolded(new Set(rows.filter(row => row.depth === 0 || row.id === selected).map(row => row.id)))
    setOpened(new Set<string>())
  }, [rows, selected])

  // 树按筛选剪枝后渲染：命中节点的祖先要留着，否则层级断掉。
  const visibleTree = useMemo(() => filterTree(tree, filter), [tree, filter])

  const cancelCli = useCallback((task: MaestroTaskSummary) => {
    void cli.cancel(task.id)
  }, [cli])
  const killOne = useCallback((row: BoardJobRow) => {
    void killJob(ctx, row.ownerSessionId, row.job.id)
  }, [ctx])

  // 先找当前树（含折叠行本身），再回退到折叠前的树，最后是面板里的作业——
  // 被收进折叠组的成员仍然要能开详情，作业节点不在树里，也走同一份浮层。
  const selectedNode = useMemo(() => {
    if (selected === null) return undefined
    return rows.find(row => row.id === selected)
      ?? allRows.find(row => row.id === selected)
      ?? jobNodes.find(node => node.id === selected)
  }, [rows, allRows, jobNodes, selected])

  // 面板里的作业按当前筛选走（计数口径一致）；宿主没有 jobs 服务就不占那 1/5。
  const visibleJobs = useMemo(
    () => jobNodes.filter(node => matchesFilter(node.status, filter)),
    [jobNodes, filter],
  )

  return (
    <div className="dmb" ref={boardRef}>
      <div className="dmb-head">
        <div>
          <div className="dmb-headtitle">{BOARD_TAB_TITLE}</div>
          <div className="dmb-sub">会话树 · CLI 子代理 · 后台任务</div>
        </div>
        <div className="dmb-headside">
          {activeCount > 0 ? <span className="dmb-live"><i />运行中 {activeCount}</span> : undefined}
          <button type="button" className="dmb-btn" onClick={refreshAll} title="重新拉取 CLI 任务列表">刷新</button>
        </div>
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

      <div className="dmb-tree" role="tree" aria-label="任务树">
        {visibleTree === undefined
          ? <p className="dmb-empty">没有匹配的任务</p>
          : view === 'graph'
            ? (
              <GraphView
                bands={collectBands(visibleTree, folded)}
                now={now}
                folded={folded}
                selected={selected}
                onFold={fold}
                onSelect={select}
              />
            )
            : (
              <TreeNode
                node={visibleTree}
                now={now}
                depth={0}
                folded={folded}
                selected={selected}
                onFold={fold}
                onSelect={select}
              />
            )}
      </div>

      {chips.available
        ? (
          <JobsPanel
            nodes={visibleJobs}
            total={chips.rows.length}
            now={now}
            selected={selected}
            onSelect={select}
            onKill={killOne}
          />
        )
        : undefined}

      <div className="dmb-foot">
        <span>{String(agentRows.length)} 个子智能体 · {String(cliNodes.length)} 个 CLI · {String(jobNodes.length)} 个作业</span>
        <span className="dmb-spacer" />
        <button
          type="button"
          className={view === 'graph' ? 'dmb-viewon' : undefined}
          onClick={() => { setView('graph') }}
          title="按层级铺开的卡片视图"
        >
          图
        </button>
        <button
          type="button"
          className={view === 'tree' ? 'dmb-viewon' : undefined}
          onClick={() => { setView('tree') }}
          title="缩进列表视图"
        >
          树
        </button>
        <button type="button" onClick={foldAll}>全部收起</button>
        <button type="button" onClick={unfoldAll}>全部展开</button>
        <span>{formatClock(now)}</span>
      </div>

      {selectedNode === undefined
        ? undefined
        : (
          <NodeDetail
            node={selectedNode}
            now={now}
            anchor={anchor}
            showLog={showLog}
            onToggleLog={() => { setShowLog(value => !value) }}
            onClose={closeDetail}
            onCancel={() => { if (selectedNode.task !== undefined) cancelCli(selectedNode.task) }}
            onKill={() => { if (selectedNode.jobRow !== undefined) killOne(selectedNode.jobRow) }}
            {...(opener === undefined ? {} : { onOpenSession: opener })}
            detail={detail}
            output={selectedNode.jobRow === undefined ? undefined : chips.observed[selectedNode.jobRow.job.id]}
          />
        )}
    </div>
  )
}

/** 从节点 id 反查后台作业 id（观察输出要它）。 */
function jobIdOf(nodeId: string | null): string | null {
  if (nodeId === null || !nodeId.startsWith(JOB_NODE_PREFIX)) return null
  const rest = nodeId.slice(JOB_NODE_PREFIX.length)
  const at = rest.indexOf(':')
  return at < 0 ? rest : rest.slice(at + 1)
}

/**
 * 底部的后台任务面板：固定占面板总高度的 1/5（`flex-basis: 20%`），内部滚动。
 *
 * 作业不混进会话树（树只讲「会话 + CLI 子代理」的层级故事），单独在这里一行
 * 一个；行还是同一套节点模型，点开同一个「节点详情」浮层（转录、终止都在）。
 */
function JobsPanel(props: {
  nodes: readonly BoardNode[]
  /** 筛选前的作业总数（被筛掉时头部计数显示 `N / M`）。 */
  total: number
  now: number
  selected: string | null
  onSelect: (id: string, element: HTMLElement | null) => void
  onKill: (row: BoardJobRow) => void
}): ReactNode {
  const { nodes, total, now, selected, onSelect, onKill } = props
  return (
    <section className="dmb-jobs" aria-label="后台任务列表">
      <div className="dmb-jobs-head">
        <span className="dmb-glyph"><Glyph kind="job" /></span>
        <span>后台任务</span>
        <b className="dmb-jobs-count">{nodes.length === total ? String(total) : `${String(nodes.length)} / ${String(total)}`}</b>
      </div>
      <div className="dmb-jobs-list" role="list">
        {nodes.length === 0
          ? <p className="dmb-jobs-empty">{total === 0 ? '没有后台任务' : '没有匹配的后台任务'}</p>
          : nodes.map(node => (
            <JobRow
              key={node.id}
              node={node}
              now={now}
              selected={selected === node.id}
              onSelect={onSelect}
              onKill={onKill}
            />
          ))}
      </div>
    </section>
  )
}

/** 面板里的一行：单行布局，点开详情浮层；还在跑的行尾直接给终止。 */
function JobRow(props: {
  node: BoardNode
  now: number
  selected: boolean
  onSelect: (id: string, element: HTMLElement | null) => void
  onKill: (row: BoardJobRow) => void
}): ReactNode {
  const { node, now, selected, onSelect, onKill } = props
  const row = node.jobRow
  if (row === undefined) return null
  const parts = metaParts(node, now)
  const activate = (element: HTMLElement | null): void => { onSelect(node.id, element) }
  return (
    <div
      className={`dmb-jrow${selected ? ' dmb-jrow-on' : ''}`}
      role="listitem"
      data-node={node.id}
      tabIndex={0}
      aria-selected={selected}
      title="查看任务详情"
      onClick={(event) => { activate(event.currentTarget) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(event.currentTarget) }
      }}
    >
      <span className={`dmb-dot dmb-dot-${node.status}`} />
      <span className="dmb-glyph"><Glyph kind="job" /></span>
      <span className="dmb-jrow-title">{node.title}</span>
      <span className="dmb-chip">{row.job.kind}</span>
      {parts.length === 0
        ? undefined
        : (
          <span className="dmb-jrow-meta">
            <MetaBits parts={parts} />
          </span>
        )}
      {jobLive(row.job)
        ? (
          <button
            type="button"
            className="dmb-btn dmb-btn-danger dmb-jrow-kill"
            title="终止这个后台任务"
            onClick={(event) => { event.stopPropagation(); onKill(row) }}
          >
            终止
          </button>
        )
        : undefined}
    </div>
  )
}

/**
 * 把树按层折成「带」：第一层是根，第二层是它的子级，依此类推。
 *
 * 图视图不做绝对定位的力导向布局（面板宽度只有两三百像素，斜线会把节点压
 * 成一团），而是**每层一行、层与层之间画一条竖线**——这正是截图里那种
 * 「父在上、子横排」的观感，且在窄栏里不会重叠。收起的节点不再往下展开。
 */
export function collectBands(node: BoardNode, folded: ReadonlySet<string>): BoardNode[][] {
  const bands: BoardNode[][] = []
  const walk = (entries: readonly BoardNode[]): void => {
    if (entries.length === 0) return
    bands.push([...entries])
    const next: BoardNode[] = []
    for (const entry of entries) {
      if (folded.has(entry.id)) continue
      next.push(...entry.children)
    }
    walk(next)
  }
  walk([node])
  return bands
}

/** 图视图：逐层的父子卡片，层间用一条竖线连起来。 */
function GraphView(props: {
  bands: readonly (readonly BoardNode[])[]
  now: number
  folded: ReadonlySet<string>
  selected: string | null
  onFold: (id: string) => void
  onSelect: (id: string, element: HTMLElement | null) => void
}): ReactNode {
  const { bands, now, folded, selected, onSelect } = props
  return (
    <div className="dmb-graph">
      {bands.map((band, index) => (
        <div className="dmb-band" key={index === 0 ? 'root' : `band-${String(index)}`}>
          {band.map(node => (
            <GraphCard
              key={node.id}
              node={node}
              now={now}
              depth={index}
              open={node.kind === 'fold' ? node.children.length > 0 : !folded.has(node.id)}
              selected={selected === node.id}
              onFold={props.onFold}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** 图视图里的一张卡片。 */
function GraphCard(props: {
  node: BoardNode
  now: number
  depth: number
  open: boolean
  selected: boolean
  onFold: (id: string) => void
  onSelect: (id: string, element: HTMLElement | null) => void
}): ReactNode {
  const { node, now, depth, open, selected, onFold, onSelect } = props
  const hasKids = node.children.length > 0
  // 收起的折叠组 children 是空的，但它有成员可以摊开——按钮照样要出现。
  const expandable = hasKids || (node.members?.length ?? 0) > 0
  const settled = node.status === 'done' || node.status === 'cancelled' || node.status === 'idle'
  const ghost = node.kind === 'agent' && depth > 0 && !node.hasSession
  const activate = (element: HTMLElement | null): void => { onSelect(node.id, element) }
  return (
    <div
      className={`dmb-gcard${depth === 0 ? ' dmb-gcard-root' : ''}${selected ? ' dmb-gcard-on' : ''}${settled ? ' dmb-gcard-settled' : ''}${node.kind === 'fold' ? ' dmb-gcard-fold' : ''}`}
      role="treeitem"
      tabIndex={0}
      data-node={node.id}
      aria-level={depth + 1}
      aria-expanded={expandable ? open : undefined}
      aria-selected={selected}
      title="查看节点详情"
      onClick={(event) => { activate(event.currentTarget) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(event.currentTarget) }
      }}
    >
      <span className="dmb-gcard-head">
        <span className={`dmb-dot dmb-dot-${node.status}`} />
        <span className="dmb-glyph"><Glyph kind={node.kind} /></span>
        <span className={`dmb-gcard-title${ghost ? ' dmb-gcard-title-ghost' : ''}`}>{node.title}</span>
      </span>
      {metaParts(node, now).length === 0
        ? undefined
        : (
          <span className="dmb-gcard-meta">
            <MetaBits parts={metaParts(node, now)} />
          </span>
        )}
      <span className="dmb-gcard-foot">
        <span className="dmb-gcard-chipline">{nodeChip(node)}</span>
        {expandable
          ? (
            <button
              type="button"
              className="dmb-gcard-kids"
              aria-expanded={open}
              title={open ? '收起子任务' : `展开 ${String(node.children.length > 0 ? node.children.length : (node.members?.length ?? 0))} 个子任务`}
              onClick={(event) => { event.stopPropagation(); onFold(node.id) }}
            >
              {open ? '收起' : `展开 ${String(node.children.length > 0 ? node.children.length : (node.members?.length ?? 0))}`}
            </button>
          )
          : undefined}
      </span>
    </div>
  )
}

/**
 * 树上的一个节点（递归渲染子级）。
 *
 * 整行是「开节点详情」的手势；行尾三角只收子树——两个目标分开，避免想展开
 * 却把浮层打开了。
 */
function TreeNode(props: {
  node: BoardNode
  now: number
  depth: number
  folded: ReadonlySet<string>
  selected: string | null
  onFold: (id: string) => void
  onSelect: (id: string, element: HTMLElement | null) => void
}): ReactNode {
  const { node, now, depth, folded, selected, onFold, onSelect } = props
  // 折叠组的开合由「成员是否已摊进 children」表达（见 expandFolds），不看 folded。
  const open = node.kind === 'fold' ? node.children.length > 0 : !folded.has(node.id)
  const hasKids = node.children.length > 0
  // 收起的折叠组 children 是空的，但它有成员可以摊开——三角照样要出现。
  const expandable = hasKids || (node.members?.length ?? 0) > 0
  const isSelected = selected === node.id
  const settled = node.status === 'done' || node.status === 'cancelled' || node.status === 'idle'
  const ghost = node.kind === 'agent' && depth > 0 && !node.hasSession
  const activate = (element: HTMLElement | null): void => { onSelect(node.id, element) }
  return (
    <div className="dmb-node">
      <div
        className={`dmb-row${depth === 0 ? ' dmb-row-root' : ''}${isSelected ? ' dmb-row-on' : ''}${settled ? ' dmb-row-settled' : ''}${node.kind === 'fold' ? ' dmb-row-fold' : ''}`}
        role="treeitem"
        tabIndex={0}
        data-node={node.id}
        aria-level={depth + 1}
        aria-expanded={expandable ? open : undefined}
        aria-selected={isSelected}
        title="查看节点详情"
        onClick={(event) => { activate(event.currentTarget) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            activate(event.currentTarget)
            return
          }
          if (event.key === 'ArrowRight' && expandable && !open) { event.preventDefault(); onFold(node.id); return }
          if (event.key === 'ArrowLeft' && expandable && open) { event.preventDefault(); onFold(node.id) }
        }}
      >
        <span className={`dmb-dot dmb-dot-${node.status}`} />
        <span className="dmb-glyph"><Glyph kind={node.kind} /></span>
        <span className="dmb-content">
          <span className="dmb-titleline">
            <span className={`dmb-title${ghost ? ' dmb-title-ghost' : ''}`}>{node.title}</span>
            {nodeChip(node)}
          </span>
          {nodeMeta(node, now)}
        </span>
        {expandable
          ? (
            <button
              type="button"
              className="dmb-disclosure"
              aria-expanded={open}
              title={open ? '收起子任务' : '展开子任务'}
              onClick={(event) => { event.stopPropagation(); onFold(node.id) }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {open ? <path d="M4 6l4 4 4-4" /> : <path d="M6 4l4 4-4 4" />}
              </svg>
            </button>
          )
          : undefined}
      </div>
      {open && hasKids
        ? (
          <div className="dmb-kids" role="group">
            {node.children.map(child => (
              <TreeNode
                key={child.id}
                node={child}
                now={now}
                depth={depth + 1}
                folded={folded}
                selected={selected}
                onFold={onFold}
                onSelect={onSelect}
              />
            ))}
          </div>
        )
        : undefined}
    </div>
  )
}

/** 节点详情浮层：状态 / 模式 / Token / 耗时 + 动作 + 转录。 */
function NodeDetail(props: {
  node: BoardNode
  now: number
  anchor: DetailAnchor | undefined
  showLog: boolean
  onToggleLog: () => void
  onClose: () => void
  onCancel: () => void
  onKill: () => void
  onOpenSession?: (id: string) => void
  detail: { summary: MaestroTaskSummary | undefined; events: readonly MaestroTaskEvent[]; error: string | undefined; failure: string | undefined }
  output: { text: string; streaming: boolean; gapBefore: boolean; error?: string } | undefined
}): ReactNode {
  const { node, now, detail, output, showLog, anchor } = props
  const logRef = useRef<HTMLPreElement | null>(null)
  const lineCount = detail.events.length
  useEffect(() => {
    if (!showLog) return
    const element = logRef.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
  }, [showLog, lineCount, output?.text])

  // 浮层贴着被点的节点：左右夹在面板内，下方空间不够就翻到节点上方。
  const placement = anchor === undefined
    ? undefined
    : {
      left: `${String(anchor.left)}px`,
      ...(anchor.flip
        ? { bottom: `${String(anchor.bottom)}px` }
        : { top: `${String(anchor.top)}px` }),
    }

  const kvs: Array<{ key: string; value: ReactNode }> = [{ key: '状态', value: STATUS_LABELS[node.status] }]
  const actions: ReactNode[] = []

  if (node.kind === 'agent') {
    const mode = node.mode === undefined ? (node.hasSession ? '会话' : '未知') : node.mode
    kvs.push({ key: '模式', value: mode })
    if (node.children.length > 0) kvs.push({ key: '子级', value: `${String(node.children.length)} 个` })
    kvs.push({ key: 'Token 用量', value: tokenSummary(node.tokens) ?? '—' })
    kvs.push({ key: '耗时', value: timingSummary(node.timing, now) ?? '—' })
    kvs.push({ key: '会话', value: <code>{node.id.slice(0, 16)}</code> })
    if (node.hasSession && props.onOpenSession !== undefined) {
      const open = props.onOpenSession
      actions.push(
        <button key="open" type="button" className="dmb-btn dmb-btn-primary" onClick={() => { open(node.id) }}>
          打开会话
        </button>,
      )
    }
  } else if (node.kind === 'cli' && node.task !== undefined) {
    const { task } = node
    kvs.push({ key: 'CLI', value: CLI_LABELS[task.cli] })
    kvs.push({ key: '模式', value: task.model === '' ? '默认模型' : task.model })
    kvs.push({ key: '开始', value: formatClock(task.startedAt) })
    if (task.endedAt !== undefined) kvs.push({ key: '结束', value: formatClock(task.endedAt) })
    kvs.push({ key: '耗时', value: formatDuration(taskDuration(task, now)) })
    if (task.exitCode !== undefined) kvs.push({ key: '退出码', value: String(task.exitCode) })
    if (task.truncated === true) kvs.push({ key: '日志', value: '已截断' })
    actions.push(
      <button key="log" type="button" className="dmb-btn" onClick={props.onToggleLog}>
        {showLog ? '收起转录' : '查看转录'}
      </button>,
    )
    if (taskCancellable(task)) {
      actions.push(<button key="cancel" type="button" className="dmb-btn dmb-btn-danger" onClick={props.onCancel}>取消</button>)
    }
  } else if (node.kind === 'job' && node.jobRow !== undefined) {
    const { job } = node.jobRow
    kvs.push({ key: '类型', value: job.kind })
    kvs.push({ key: '所属会话', value: <code>{node.jobRow.ownerSessionId.slice(0, 12)}</code> })
    kvs.push({ key: '开始', value: formatClock(job.startedAt) })
    if (job.finishedAt !== undefined) kvs.push({ key: '结束', value: formatClock(job.finishedAt) })
    kvs.push({ key: '耗时', value: formatDuration(Math.max(0, (job.finishedAt ?? now) - job.startedAt)) })
    if (job.detail !== undefined) kvs.push({ key: '说明', value: job.detail })
    actions.push(
      <button key="log" type="button" className="dmb-btn" onClick={props.onToggleLog}>
        {showLog ? '收起转录' : '查看转录'}
      </button>,
    )
    if (jobLive(job)) {
      actions.push(<button key="kill" type="button" className="dmb-btn dmb-btn-danger" onClick={props.onKill}>终止</button>)
    }
    if (props.onOpenSession !== undefined) {
      const open = props.onOpenSession
      const owner = node.jobRow.ownerSessionId
      actions.push(<button key="open" type="button" className="dmb-btn" title="打开这个任务所属的会话" onClick={() => { open(owner) }}>↗</button>)
    }
  }

  const transcript = (): ReactNode => {
    if (!showLog) return null
    if (node.kind === 'cli') {
      return (
        <>
          {detail.error === undefined ? undefined : <p className="dmb-err">{detail.error}</p>}
          {detail.failure === undefined ? undefined : <p className="dmb-err">{detail.failure}</p>}
          <pre className="dmb-log" ref={logRef}>
            {detail.events.map(event => (
              <span key={event.seq} className={logLineClass(event.kind)}>
                {cleanLogText(event.text)}{'\n'}
              </span>
            ))}
          </pre>
          {detail.events.length > 0 ? undefined : <p className="dmb-note">等待输出…</p>}
        </>
      )
    }
    if (node.kind === 'job') {
      return (
        <>
          {output?.error === undefined ? undefined : <p className="dmb-err">{output.error}</p>}
          {output?.gapBefore === true ? <p className="dmb-note">中间有输出被丢弃（观察开始得太晚）</p> : undefined}
          <pre className="dmb-log" ref={logRef}>{cleanLogText(output?.text ?? '')}</pre>
        </>
      )
    }
    return <p className="dmb-note">会话节点没有转录；点「打开会话」进去看。</p>
  }

  return (
    <div className="dmb-detail" role="dialog" aria-label="节点详情" style={placement}>
      <div className="dmb-detailhead">
        <span className="dmb-detailtitle">节点详情</span>
        <button type="button" className="dmb-btn dmb-detailclose" onClick={props.onClose}>关闭</button>
      </div>
      <div className="dmb-detailname">{node.title}</div>
      <div className="dmb-kv">
        {kvs.map(entry => (
          <div className="dmb-kvrow" key={entry.key}>
            <span className="dmb-kvkey">{entry.key}</span>
            <span className="dmb-kvval">{entry.value}</span>
          </div>
        ))}
      </div>
      {actions.length === 0 ? undefined : <div className="dmb-actions">{actions}</div>}
      {transcript()}
    </div>
  )
}
