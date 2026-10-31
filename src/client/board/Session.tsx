/**
 * CLI 子代理的「会话页」：把一个 CLI 任务的转录画成和 DSH 会话窗口一致的
 * 对话流——用户消息（任务文本）右侧气泡，CLI 的回答左侧气泡，工具调用与阶段
 * 折成细窄的系统行——底部带输入框，可以直接往这个 CLI 会话续发消息（claude
 * `--resume` / codex `exec resume`，服务端走 `/task/reply` 起一个新的回复任务，
 * 用 `replyTo` 链回原任务）。
 *
 * 页面从任务看板点「查看会话」打开，盖在看板之上；「←」退回看板。多轮回复
 * 链按 `replyTo` 串起来：打开的任务先沿链爬到根，再把每轮依次铺开。
 *
 * 模型列表**只来自 dsh 配置**（`/models` 路由的 llm-pi-ai 供应商目录，按 CLI
 * 协议过滤）——绝不读 CLI 自身配置的模型；思考档位同样来自所选模型在 dsh 里
 * 配置的 `reasoningEfforts`。
 *
 * 视觉沿用看板的做法：纯 React + 注入式样式表，颜色全部走 `--dsh-*` 主题变量。
 *
 * @module dsh-maestro-codex/client/board/Session
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { cancelTask, fetchModels, fetchTaskDetail, fetchTasks, replyTask } from '../api.js'
import {
  CLI_LABELS, TERMINAL_PHASES, type DshProviderModels, type MaestroCliId, type MaestroPhase,
  type MaestroTaskEvent, type MaestroTaskSummary,
} from '../../wire.js'
import { formatClock, formatDuration } from './model.js'

/** 回复轮询与详情轮询的间隔（毫秒）——详情是滚动阅读的主内容，跟得紧一点。 */
const DETAIL_POLL_MS = 900
/** 回复链发现（任务列表）的轮询间隔。 */
const CHAIN_POLL_MS = 2500
/** 一个轮次的转录在内存里保留的最大事件数（与看板日志一致）。 */
const EVENT_CAP = 800

/** 看板状态的中文短词（与 Board 共用一套口径）。 */
const STATUS_LABELS: Record<MaestroPhase, string> = {
  queued: '排队中', running: '运行中', done: '已完成', failed: '失败', cancelled: '已取消', timeout: '已超时',
}

const SESSION_CSS = `
.dms {
  --dms-fg: var(--dsh-text-primary, light-dark(#1a1e26, #e9ebf0));
  --dms-fg2: var(--dsh-text-secondary, light-dark(#3f4756, #b7bfcc));
  --dms-fg3: var(--dsh-text-tertiary, light-dark(#646d80, #8e97a8));
  --dms-accent: var(--dsh-accent, light-dark(#2f5fe0, #7292ff));
  --dms-panel: var(--dsh-bg-secondary, light-dark(#f7f8fa, #20242e));
  --dms-page: var(--dsh-bg-primary, light-dark(#ffffff, #171a21));
  --dms-input: var(--dsh-bg-input, light-dark(#ffffff, #262b37));
  --dms-border: var(--dsh-border, light-dark(#dce0e8, #2e3440));
  --dms-hover: var(--dsh-bg-hover, light-dark(#edeff4, #2a3040));
  --dms-ok: light-dark(#0e8a55, #3ddc97);
  --dms-danger: light-dark(#d92d20, #ff7b72);
  --dms-lake: light-dark(#0b87ab, #3ec9f0);
  --dms-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  position: absolute; inset: 0; z-index: 12;
  display: flex; flex-direction: column; min-height: 0;
  background: var(--dms-page); color: var(--dms-fg);
  font-size: 12.5px; line-height: 1.5;
  animation: dms-in .16s ease-out;
}
.dms, .dms *, .dms *::before, .dms *::after { box-sizing: border-box; }
@keyframes dms-in { from { opacity: 0; transform: translateY(6px); } }

/* --- head --- */
.dms-head {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 9px 12px; border-bottom: 1px solid var(--dms-border);
  background: var(--dms-panel);
}
.dms-back {
  flex: none; font: inherit; font-size: 11.5px; padding: 3px 9px; border-radius: 6px; cursor: pointer;
  color: var(--dms-fg2); background: transparent; border: 1px solid var(--dms-border);
  display: inline-flex; align-items: center; gap: 4px;
}
.dms-back:hover { background: var(--dms-hover); color: var(--dms-fg); }
.dms-headtext { flex: 1 1 auto; min-width: 0; }
.dms-title {
  display: flex; align-items: center; gap: 6px; min-width: 0;
  font-size: 13px; font-weight: 650; letter-spacing: -.01em;
}
.dms-title-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dms-sub {
  margin-top: 1px; font-size: 10.5px; color: var(--dms-fg3);
  display: flex; align-items: center; gap: 5px; min-width: 0;
}
.dms-sub > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dms-mono { font-family: var(--dms-mono); }
.dms-phase { display: inline-flex; align-items: center; gap: 4px; }
.dms-phase i {
  width: 6px; height: 6px; border-radius: 50%; background: var(--dms-fg3); flex: none;
}
.dms-phase-running i { background: var(--dms-accent); animation: dms-pulse 1.4s ease-in-out infinite; }
.dms-phase-done i { background: var(--dms-ok); }
.dms-phase-failed i, .dms-phase-timeout i { background: var(--dms-danger); }
.dms-phase-queued i { background: light-dark(#b45309, #fbbf24); }
@keyframes dms-pulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
.dms-chip {
  flex: none; max-width: 40%; font-size: 10px; font-weight: 650; padding: 0 6px; border-radius: 4px;
  color: var(--dms-lake); border: 1px solid color-mix(in srgb, var(--dms-lake) 45%, transparent);
  background: color-mix(in srgb, var(--dms-lake) 8%, transparent);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dms-btn {
  flex: none; font: inherit; font-size: 11px; padding: 3px 9px; border-radius: 6px; cursor: pointer;
  color: var(--dms-fg2); background: var(--dms-panel); border: 1px solid var(--dms-border);
}
.dms-btn:hover { background: var(--dms-hover); color: var(--dms-fg); }
.dms-btn:disabled { opacity: .5; cursor: default; }
.dms-btn-danger { color: var(--dms-danger); border-color: color-mix(in srgb, var(--dms-danger) 40%, var(--dms-border)); }
.dms-btn-primary {
  color: var(--dms-accent); border-color: color-mix(in srgb, var(--dms-accent) 45%, var(--dms-border));
  background: color-mix(in srgb, var(--dms-accent) 10%, transparent);
}

/* --- stream --- */
.dms-stream {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin;
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 12px 6px;
}
.dms-turn { display: flex; flex-direction: column; gap: 6px; }
.dms-turnmeta {
  display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
  font-size: 10px; color: var(--dms-fg3);
}
.dms-turnmeta > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dms-user { display: flex; justify-content: flex-end; }
.dms-bubble-user {
  max-width: 88%; padding: 7px 10px; border-radius: 12px 12px 4px 12px;
  background: color-mix(in srgb, var(--dms-accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--dms-accent) 26%, transparent);
  white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
}
.dms-bubble-user.dms-bubble-capped { max-height: 260px; overflow-y: auto; scrollbar-width: thin; }
.dms-agent { display: flex; justify-content: flex-start; }
.dms-agent-body { max-width: 92%; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.dms-role { font-size: 10px; font-weight: 650; color: var(--dms-lake); padding-left: 2px; }
.dms-bubble-agent {
  padding: 7px 10px; border-radius: 12px 12px 12px 4px;
  background: var(--dms-panel); border: 1px solid var(--dms-border);
  white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
  color: var(--dms-fg);
}
.dms-bubble-final { border-color: color-mix(in srgb, var(--dms-ok) 40%, var(--dms-border)); }
.dms-bubble-error {
  background: color-mix(in srgb, var(--dms-danger) 8%, transparent);
  border-color: color-mix(in srgb, var(--dms-danger) 40%, var(--dms-border));
  color: var(--dms-danger);
}
/* 工具调用 / 阶段：细窄的系统行，不抢对话的视线。 */
.dms-tool, .dms-stage {
  display: flex; align-items: baseline; gap: 6px; max-width: 92%;
  font-size: 10.5px; color: var(--dms-fg3); padding-left: 2px;
}
.dms-tool { font-family: var(--dms-mono); font-size: 10px; word-break: break-word; }
.dms-tool-mark, .dms-stage-mark { flex: none; opacity: .8; }
.dms-errline {
  display: flex; align-items: baseline; gap: 6px; max-width: 92%;
  font-size: 11px; color: var(--dms-danger); padding-left: 2px;
  white-space: pre-wrap; word-break: break-word;
}
.dms-stage { align-items: center; gap: 8px; color: var(--dms-fg3); font-size: 10px; min-width: 0; }
/* flex-basis 0：文本宽度由容器分给（内容长度不参与 sizing），长路径才会换行
 * 而不是把整行撑出面板。 */
.dms-stage .dms-stage-mark { flex: 1 1 0; min-width: 0; overflow-wrap: anywhere; word-break: break-word; white-space: normal; text-align: center; }
.dms-stage::before, .dms-stage::after { content: ''; flex: 0 1 24px; height: 1px; background: var(--dms-border); }
.dms-truncated { font-size: 10px; color: var(--dms-fg3); padding-left: 2px; }
.dms-typing { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--dms-fg3); padding-left: 2px; }
.dms-typing i {
  width: 4px; height: 4px; border-radius: 50%; background: var(--dms-accent);
  animation: dms-pulse 1.1s ease-in-out infinite;
}
.dms-typing i:nth-child(2) { animation-delay: .18s; }
.dms-typing i:nth-child(3) { animation-delay: .36s; }
.dms-empty { margin: auto; font-size: 11.5px; color: var(--dms-fg3); text-align: center; padding: 24px; }

/* --- composer --- */
.dms-composer {
  flex: none; display: flex; flex-direction: column; gap: 6px;
  padding: 9px 12px 11px; border-top: 1px solid var(--dms-border); background: var(--dms-panel);
}
.dms-composer-meta { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.dms-select {
  font: inherit; font-size: 10.5px; padding: 2px 6px; border-radius: 6px; max-width: 52%;
  color: var(--dms-fg2); background: var(--dms-input); border: 1px solid var(--dms-border);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dms-composer-hint { font-size: 10px; color: var(--dms-fg3); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dms-inputrow { display: flex; align-items: flex-end; gap: 7px; }
.dms-textarea {
  flex: 1 1 auto; min-width: 0; resize: none;
  font: inherit; font-size: 12.5px; line-height: 1.45; padding: 7px 9px;
  border-radius: 10px; border: 1px solid var(--dms-border); background: var(--dms-input); color: var(--dms-fg);
}
.dms-textarea::placeholder { color: var(--dms-fg3); }
.dms-textarea:focus-visible { outline: 2px solid color-mix(in srgb, var(--dms-accent) 55%, transparent); outline-offset: -1px; }
.dms-textarea:disabled { opacity: .6; }
.dms-send {
  flex: none; font: inherit; font-size: 12px; font-weight: 650; padding: 7px 14px; border-radius: 10px; cursor: pointer;
  color: var(--dms-page); background: var(--dms-accent); border: 1px solid transparent;
}
.dms-send:hover { filter: brightness(1.08); }
.dms-send:disabled { opacity: .45; cursor: default; filter: none; }
.dms-err { margin: 0; font-size: 11px; color: var(--dms-danger); }
`

const STYLE_ID = 'dsh-maestro-codex-session-styles'

/** 注入会话页样式表（按 id 幂等）。 */
function useSessionStyles(): void {
  useEffect(() => {
    if (document.getElementById(STYLE_ID) !== null) return
    const element = document.createElement('style')
    element.id = STYLE_ID
    element.textContent = SESSION_CSS
    document.head.appendChild(element)
  }, [])
}

/** 一个轮次的完整内容（detail 轮询的累积结果）。 */
interface TurnState {
  readonly summary: MaestroTaskSummary
  readonly prompt?: string
  readonly cwd?: string
  readonly finalText?: string
  readonly error?: string
  readonly events: readonly MaestroTaskEvent[]
}

/** 单个任务详情的跟随式轮询（带游标，只追加；终态后停表）。 */
function useTurnDetail(id: string, active: boolean, sessionIds?: readonly string[]): { turn: TurnState | undefined; error: string | undefined } {
  const [state, setState] = useState<{ turn: TurnState | undefined; error: string | undefined }>({ turn: undefined, error: undefined })
  const scopeKey = sessionIds === undefined || sessionIds.length === 0 ? '' : [...sessionIds].sort().join(',')
  useEffect(() => {
    if (!active) return
    let cancelled = false
    let cursor = 0
    let failures = 0
    let timer: number | undefined
    const load = async (): Promise<void> => {
      const result = await fetchTaskDetail(id, cursor, scopeKey === '' ? undefined : scopeKey.split(','))
      if (cancelled) return
      if (!result.ok) {
        // 一次抖动不该冻结整页：有界重试，任务真被剪掉才停下。
        failures += 1
        setState({ turn: undefined, error: result.error })
        if (failures < 5) timer = window.setTimeout(() => { void load() }, DETAIL_POLL_MS)
        return
      }
      failures = 0
      cursor = result.nextCursor
      setState((previous) => {
        const events = [...(previous.turn?.events ?? []), ...result.events].slice(-EVENT_CAP)
        return {
          error: undefined,
          turn: {
            summary: result.summary,
            ...(result.prompt === undefined ? {} : { prompt: result.prompt }),
            ...(result.cwd === undefined ? {} : { cwd: result.cwd }),
            ...(result.finalText === undefined ? {} : { finalText: result.finalText }),
            ...(result.error === undefined ? {} : { error: result.error }),
            events,
          },
        }
      })
      if (!TERMINAL_PHASES.includes(result.summary.phase)) {
        timer = window.setTimeout(() => { void load() }, DETAIL_POLL_MS)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [id, active, scopeKey])
  return state
}

/**
 * 把打开的任务沿 `replyTo` 爬到根，再顺着回复链铺回来。
 *
 * 摘要表里查不到的 id（打开的任务不在列表里，比如刚派发）就停在那里——
 * 它自己的轮次详情仍会去取。
 */
export function buildChain(rootId: string, summaries: Readonly<Record<string, MaestroTaskSummary>>): string[] {
  const byReplyTo = new Map<string, MaestroTaskSummary[]>()
  for (const task of Object.values(summaries)) {
    if (task.replyTo === undefined) continue
    const bucket = byReplyTo.get(task.replyTo) ?? []
    bucket.push(task)
    byReplyTo.set(task.replyTo, bucket)
  }
  for (const bucket of byReplyTo.values()) bucket.sort((left, right) => left.startedAt - right.startedAt)
  const chain: string[] = []
  const seen = new Set<string>()
  let current = rootId
  // 先向上爬（打开的可能本身是回复），再向下铺。
  const up = new Set<string>([current])
  for (;;) {
    const parent = summaries[current]?.replyTo
    if (parent === undefined || up.has(parent)) break
    current = parent
    up.add(current)
  }
  for (;;) {
    chain.push(current)
    seen.add(current)
    const next = byReplyTo.get(current)?.find(task => !seen.has(task.id))
    if (next === undefined) break
    current = next.id
  }
  return chain
}

/**
 * 续发的落点：从链尾往前找最近一个带 CLI 会话引用的轮次。
 *
 * 尾轮失败/超时常常没有 sessionRef（CLI 没走到结算），但更早的轮次引用还在
 * ——会话不该因为一次失败就再也续不上，claude/codex 都能从任一历史轮次
 * `--resume` / `exec resume` 接着聊。全部没有引用时返回 undefined（不可续发）。
 */
export function replyAnchorOf(chain: readonly string[], summaries: Readonly<Record<string, MaestroTaskSummary>>): string | undefined {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const id = chain[index]
    if (id !== undefined && (summaries[id]?.sessionRef ?? '') !== '') return id
  }
  return undefined
}

/** 事件行种类 → 渲染。文本/工具/错误/阶段四种画法。 */
function EventRow(props: { event: MaestroTaskEvent }): ReactNode {
  const { event } = props
  if (event.kind === 'text') {
    return (
      <div className="dms-agent">
        <div className="dms-agent-body">
          <span className="dms-bubble-agent">{event.text}</span>
        </div>
      </div>
    )
  }
  if (event.kind === 'note') {
    return (
      <div className="dms-tool">
        <span className="dms-tool-mark">▸</span>
        <span>{event.text}</span>
      </div>
    )
  }
  if (event.kind === 'error') {
    return (
      <div className="dms-errline">
        <span className="dms-tool-mark">✖</span>
        <span>{event.text}</span>
      </div>
    )
  }
  return (
    <div className="dms-stage">
      <span className="dms-stage-mark">{event.text}</span>
    </div>
  )
}

/**
 * finalText 是否已经被流式 text 事件说过（claude 的 result 帧与最后一条
 * assistant 文本、codex 的最后一条 agent_message 都会重复）。
 */
function finalTextDuplicate(finalText: string, events: readonly MaestroTaskEvent[]): boolean {
  const norm = (value: string): string => value.replace(/\s+/g, ' ').trim()
  const target = norm(finalText)
  if (target === '') return true
  const joined = norm(events.filter(event => event.kind === 'text').map(event => event.text).join('\n'))
  if (joined === '') return false
  return joined.includes(target) || target.includes(joined)
}

/** 一轮：轮次元信息 + 用户气泡 + 事件流 +（去重后的）最终结果 + 失败原因。 */
function TurnView(props: {
  id: string
  cli: MaestroCliId
  active: boolean
  sessionIds?: readonly string[]
  running: boolean
}): ReactNode {
  const { id, cli, active, sessionIds, running } = props
  const { turn, error } = useTurnDetail(id, active, sessionIds)
  if (error !== undefined) {
    return (
      <div className="dms-turn">
        <p className="dms-empty">这一轮读不到了：{error}</p>
      </div>
    )
  }
  if (turn === undefined) {
    return (
      <div className="dms-turn">
        <p className="dms-empty">正在载入这一轮…</p>
      </div>
    )
  }
  const summary = turn.summary
  const prompt = turn.prompt ?? summary.title
  const hasTextEvents = turn.events.some(event => event.kind === 'text')
  const firstTextSeq = turn.events.find(event => event.kind === 'text')?.seq
  const showFinal = turn.finalText !== undefined && turn.finalText.trim() !== ''
    && !finalTextDuplicate(turn.finalText, turn.events)
  return (
    <div className="dms-turn">
      <div className="dms-turnmeta">
        <span>{formatClock(summary.startedAt)}</span>
        {summary.model === '' ? undefined : <span>· 模型 {summary.model}</span>}
        {turn.cwd === undefined ? undefined : <span>· {turn.cwd}</span>}
        {summary.endedAt === undefined ? undefined : <span>· 耗时 {formatDuration(summary.endedAt - summary.startedAt)}</span>}
      </div>
      <div className="dms-user">
        <div className={`dms-bubble-user${prompt.length > 420 ? ' dms-bubble-capped' : ''}`}>{prompt}</div>
      </div>
      {summary.truncated === true ? <div className="dms-truncated">这一轮的事件环已截断，只保留最近的事件。</div> : undefined}
      {turn.events.map((event) => {
        if (event.kind === 'text') {
          return (
            <div className="dms-agent" key={event.seq}>
              <div className="dms-agent-body">
                {event.seq === firstTextSeq ? <span className="dms-role">{CLI_LABELS[cli]}</span> : undefined}
                <span className="dms-bubble-agent">{event.text}</span>
              </div>
            </div>
          )
        }
        return <EventRow key={event.seq} event={event} />
      })}
      {showFinal
        ? (
          <div className="dms-agent">
            <div className="dms-agent-body">
              {hasTextEvents ? undefined : <span className="dms-role">{CLI_LABELS[cli]}</span>}
              <span className="dms-bubble-agent dms-bubble-final">{turn.finalText}</span>
            </div>
          </div>
        )
        : undefined}
      {turn.error !== undefined && turn.error.trim() !== ''
        ? (
          <div className="dms-agent">
            <div className="dms-agent-body">
              <span className="dms-bubble-agent dms-bubble-error">{turn.error}</span>
            </div>
          </div>
        )
        : undefined}
      {running
        ? (
          <div className="dms-typing" aria-label="CLI 正在执行">
            <i /><i /><i />
            <span>{CLI_LABELS[cli]} 正在执行…</span>
          </div>
        )
        : undefined}
    </div>
  )
}

/** 会话页的模型选择：**只列 dsh 配置的、该 CLI 协议可映射的模型**。 */
function dshModelPickerData(cli: MaestroCliId, providers: readonly DshProviderModels[] | undefined): {
  mappable: DshProviderModels[]
  unusableCount: number
} {
  // 与配置页同一套协议口径：claude 只映射 anthropic-messages；codex 走 responses
  // 方言，openai-responses / openai-completions 都收（见 dispatch.protocolProblem）。
  const usableApis: readonly string[] = cli === 'claude'
    ? ['anthropic-messages']
    : ['openai-responses', 'openai-completions']
  const list = providers ?? []
  return {
    mappable: list.filter(provider => provider.mappable && usableApis.includes(provider.api)),
    unusableCount: list.filter(provider => provider.mappable && !usableApis.includes(provider.api)).length,
  }
}

/** 会话页主组件。 */
export function SessionPage(props: {
  /** 打开时点中的任务（可以是链上任何一轮）。 */
  taskId: string
  /** 打开时那颗节点的 CLI——链的首轮还没被任务列表看到前，页面先用它标注。 */
  cli?: MaestroCliId
  /** 任务路由的会话范围（与看板一致）。 */
  sessionIds?: readonly string[]
  onClose: () => void
}): ReactNode {
  useSessionStyles()
  const { taskId, cli: cliHint, sessionIds, onClose } = props
  const scopeKey = sessionIds === undefined || sessionIds.length === 0 ? '' : [...sessionIds].sort().join(',')

  // 回复链发现：轮询任务列表，用 replyTo 把链串起来。
  const [summaries, setSummaries] = useState<Record<string, MaestroTaskSummary>>({})
  const [listError, setListError] = useState<string | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const load = async (): Promise<void> => {
      const result = await fetchTasks(scopeKey === '' ? undefined : scopeKey.split(','))
      if (cancelled) return
      if (result.ok) {
        setSummaries(previous => {
          const next = { ...previous }
          for (const task of result.tasks) next[task.id] = task
          return next
        })
        setListError(undefined)
      } else {
        setListError(result.error)
      }
      timer = window.setTimeout(() => { void load() }, CHAIN_POLL_MS)
    }
    void load()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [scopeKey])

  // 刚发出、还没被任务列表轮到的回复：按 id 先行挂上链尾并锁定输入——列表
  // 轮询（2.5s）的空档里再点一次发送，就是同一会话上的两条并发 resume。
  const [pendingReplyId, setPendingReplyId] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (pendingReplyId !== undefined && summaries[pendingReplyId] !== undefined) setPendingReplyId(undefined)
  }, [pendingReplyId, summaries])

  const chain = useMemo(() => {
    const base = buildChain(taskId, summaries)
    if (pendingReplyId !== undefined && !base.includes(pendingReplyId)) return [...base, pendingReplyId]
    return base
  }, [taskId, summaries, pendingReplyId])
  const rootId = chain[0] ?? taskId
  const lastId = chain[chain.length - 1] ?? taskId
  const rootSummary = summaries[rootId]
  const lastSummary = summaries[lastId]
  const cli: MaestroCliId = (rootSummary ?? lastSummary)?.cli ?? cliHint ?? 'claude'
  const lastRunning = pendingReplyId !== undefined
    || (lastSummary !== undefined && (lastSummary.phase === 'running' || lastSummary.phase === 'queued'))
  // 续发落点用 replyAnchorOf：尾轮失败/超时没有会话引用时退回更早的轮次。
  const replyAnchorId = replyAnchorOf(chain, summaries)

  // 模型目录：会话页的模型列表只来自 dsh 配置。
  const [providers, setProviders] = useState<DshProviderModels[] | undefined>(undefined)
  useEffect(() => {
    let disposed = false
    void fetchModels().then(result => {
      if (!disposed && result.ok) setProviders(result.providers)
    })
    return () => { disposed = true }
  }, [])
  const { mappable, unusableCount } = useMemo(() => dshModelPickerData(cli, providers), [cli, providers])
  const [model, setModel] = useState('')
  const [thinking, setThinking] = useState('')
  // 档位来自所选模型在 dsh 里配置的 reasoningEfforts；换模型后旧档位不一定还有效。
  const efforts = useMemo(() => {
    const at = model.indexOf('::')
    if (at <= 0) return []
    const provider = mappable.find(entry => entry.id === model.slice(0, at))
    return provider?.models.find(entry => entry.id === model.slice(at + 2))?.reasoningEfforts ?? []
  }, [model, mappable])
  useEffect(() => {
    if (thinking !== '' && !efforts.includes(thinking)) setThinking('')
  }, [efforts, thinking])

  // 输入框与发送。
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | undefined>(undefined)
  const submit = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (text === '' || sending || lastRunning || replyAnchorId === undefined) return
    setSending(true)
    setSendError(undefined)
    const result = await replyTask(replyAnchorId, text, {
      ...(scopeKey === '' ? {} : { sessionIds: scopeKey.split(',') }),
      ...(model === '' ? {} : { model }),
      ...(thinking === '' ? {} : { thinking }),
    })
    setSending(false)
    if (!result.ok) {
      setSendError(result.error)
      return
    }
    setPendingReplyId(result.id)
    setDraft('')
  }, [draft, sending, lastRunning, replyAnchorId, scopeKey, model, thinking])

  const cancelLast = useCallback(() => {
    void cancelTask(lastId, scopeKey === '' ? undefined : scopeKey.split(','))
  }, [lastId, scopeKey])

  // 滚动跟随：贴底时新内容一到就滚到底；用户往上翻了就不打扰。
  const streamRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  const onScroll = useCallback(() => {
    const element = streamRef.current
    if (element === null) return
    pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
  }, [])
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => { setTick(value => value + 1) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    const element = streamRef.current
    if (element === null || !pinnedRef.current) return
    element.scrollTop = element.scrollHeight
  }, [chain.length, tick])

  // 刚发出的回复还没有摘要：头部状态按运行中显示。
  const phase = pendingReplyId !== undefined ? 'running' : lastSummary?.phase
  return (
    <div className="dms" role="dialog" aria-label="CLI 会话">
      <div className="dms-head">
        <button type="button" className="dms-back" onClick={onClose} title="退回任务看板">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M10 3L5 8l5 5" />
          </svg>
          看板
        </button>
        <div className="dms-headtext">
          <div className="dms-title">
            <span className="dms-title-text">{rootSummary?.title ?? 'CLI 会话'}</span>
            <span className="dms-chip">{CLI_LABELS[cli]}</span>
          </div>
          <div className="dms-sub">
            <span className={`dms-phase${phase === undefined ? '' : ` dms-phase-${phase}`}`}>
              <i />{phase === undefined ? '载入中' : STATUS_LABELS[phase]}
            </span>
            {(lastSummary?.model ?? '') !== '' ? <span>· {lastSummary?.model}</span> : undefined}
            {(lastSummary?.sessionRef ?? '') !== '' ? <span className="dms-mono">· {lastSummary?.sessionRef?.slice(0, 12)}</span> : undefined}
            {listError !== undefined ? <span>· 任务列表读取失败：{listError}</span> : undefined}
          </div>
        </div>
        {lastRunning
          ? <button type="button" className="dms-btn dms-btn-danger" onClick={cancelLast}>取消</button>
          : undefined}
      </div>

      <div className="dms-stream" ref={streamRef} onScroll={onScroll}>
        {chain.map(id => (
          <TurnView
            key={id}
            id={id}
            cli={cli}
            active
            {...(sessionIds === undefined ? {} : { sessionIds })}
            running={lastRunning && id === lastId}
          />
        ))}
      </div>

      <div className="dms-composer">
        <div className="dms-composer-meta">
          <select
            className="dms-select"
            value={model}
            onChange={event => { setModel(event.target.value) }}
            title={`模型列表来自 dsh 配置${unusableCount > 0 ? `（另有 ${String(unusableCount)} 个协议不匹配的供应商未列出）` : ''}`}
          >
            <option value="">模型：沿用配置页模型</option>
            {mappable.map(provider => (
              <optgroup key={provider.id} label={`${provider.displayName}（${provider.api}）`}>
                {provider.models.map(entry => (
                  <option key={`${provider.id}::${entry.id}`} value={`${provider.id}::${entry.id}`}>{entry.id}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <select
            className="dms-select"
            value={thinking}
            onChange={event => { setThinking(event.target.value) }}
            title="思考档位来自所选模型配置的 reasoningEfforts"
          >
            <option value="">思考：默认</option>
            {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
          </select>
          <span className="dms-composer-hint">
            {lastRunning
              ? pendingReplyId !== undefined
                ? '回复已发出，等这一轮结束'
                : '这一轮还在执行，结束后可以继续发消息'
              : replyAnchorId !== undefined
                ? 'Enter 发送 · Shift+Enter 换行'
                : '这个会话里没有可续接的 CLI 会话引用，无法续发（重新派发一个可续接的任务吧）'}
          </span>
        </div>
        {sendError !== undefined ? <p className="dms-err">{sendError}</p> : undefined}
        <div className="dms-inputrow">
          <textarea
            className="dms-textarea"
            rows={2}
            placeholder={lastRunning ? '等待这一轮结束…' : '给这个 CLI 会话发一条后续指令…'}
            value={draft}
            disabled={lastRunning || replyAnchorId === undefined}
            onChange={event => { setDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void submit()
              }
            }}
          />
          <button
            type="button"
            className="dms-send"
            disabled={lastRunning || replyAnchorId === undefined || sending || draft.trim() === ''}
            onClick={() => { void submit() }}
          >
            {sending ? '发送中' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}
