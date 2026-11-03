/**
 * CLI 子代理的「会话页」：把一个 CLI 任务的转录画成和 dsh 子智能体侧栏会话
 * 页一致的对话流——用户消息（任务文本）右侧气泡，CLI 的回答左侧走宿主自己的
 * Markdown 渲染器（`MarkdownText`，dsh 主会话的同款排版：标题/列表/表格/代码
 * 块复制/KaTeX），思考过程与工具调用折叠成宿主 DisclosureRow 同款的行（参考
 * jetbrains-cc-gui 的 ThinkingBlock/ToolBlock 画法）——底部是宿主 composer
 * 同款的圆角卡片输入区，可以直接往这个 CLI 会话续发消息（claude `--resume` /
 * codex `exec resume`，服务端走 `/task/reply` 起一个新的回复任务，用
 * `replyTo` 链回原任务）。模型与思考档位不在会话页改：续发沿用该 CLI 的
 * 服务端配置。
 *
 * 页面有两个落点（`place`）：默认 `panel` 是盖在看板之上的覆盖层（宿主没有
 * 右栏 tab 类型时的回落）；`tab` 渲染进宿主右栏的 `maestro-cli-chat` tab 座位
 * （见 session-tab.tsx），与 dsh 子代理「查看会话」同一条侧边通道，没有返回
 * 按钮（tab 的关闭/布局归宿主管）。多轮回复链按 `replyTo` 串起来：打开的
 * 任务先沿链爬到根，再把每轮依次铺开。
 *
 * 模型列表**只来自 dsh 配置**（`/models` 路由的 llm-pi-ai 供应商目录，按 CLI
 * 协议过滤）——绝不读 CLI 自身配置的模型；思考档位同样来自所选模型在 dsh 里
 * 配置的 `reasoningEfforts`。
 *
 * 视觉对齐宿主会话页（`dsh-client-ui-chat` 的 embedded 会话）：尺寸/颜色全部
 * 走宿主 `--dsw-*`/`--dsh-*` 设计变量，嵌入变量（`--dsh-chat-content-width`
 * 等）复制宿主 embedded 变体的取值。
 *
 * @module dsh-maestro-codex/client/board/Session
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import * as uiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconCodeOutlineRegular, IconDatabaseOutlineRegular, IconGaugeOutlineRegular, MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'

import { cancelTask, fetchTaskDetail, fetchTasks, replyTask } from '../api.js'
import {
  CLI_LABELS, TERMINAL_PHASES, type MaestroCliId,
  type MaestroTaskEvent, type MaestroTaskSummary, type MaestroSessionAccess,
} from '../../wire.js'
import { EXECUTOR_BRANDS } from './accent.js'
import { formatClock, formatDuration, formatTokens } from './model.js'
import { chatT } from './upstream/client/locales.js'

/** 回复轮询与详情轮询的间隔（毫秒）——详情是滚动阅读的主内容，跟得紧一点。 */
const DETAIL_POLL_MS = 900
/** 回复链发现（任务列表）的轮询间隔。 */
const CHAIN_POLL_MS = 2500
/** 一个轮次的转录在内存里保留的最大事件数（与看板日志一致）。 */
const EVENT_CAP = 800


/**
 * 宿主 embedded 会话的同款变量面（`dsh-client-ui-conversation` 的
 * `embeddedBody`）+ 会话页自己的布局。颜色全部走宿主设计变量，宿主没给的
 * 才用字面量兜底——主题（浅/深）因此自动跟随。
 */
const SESSION_CSS = `
.dms {
  --dsh-chat-content-width: min(calc(100% - 32px), 920px);
  --dsh-composer-card-max-width: min(calc(100% - 16px), 952px);
  --dsh-composer-side-clearance: 8px;
  --dsh-composer-text-max-height: 336px;
  --dms-mono: var(--ds-font-family-code, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
  width: 100%; min-width: 0; height: 100%; min-height: 0;
  display: flex; flex-direction: column;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: var(--dsw-font-family, inherit);
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
}
.dms, .dms *, .dms *::before, .dms *::after { box-sizing: border-box; }
/* panel 落点（无右栏 tab 时的回落）：盖在看板之上。tab 落点不加这层——
 * 座位就是那个盒子。 */
.dms.dms-panel {
  position: absolute; inset: 0; z-index: 12;
  background: var(--dsw-alias-bg-base, var(--dsh-bg-primary, light-dark(#ffffff, #171a21)));
  animation: dms-in .16s ease-out;
}
@keyframes dms-in { from { opacity: 0; transform: translateY(6px); } }

/* --- panel 头（仅覆盖层落点） --- */
.dms-head {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 9px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, var(--dsh-border, #2e3440));
  background: var(--dsw-alias-bg-layer-1, var(--dsh-bg-secondary, #20242e));
}
.dms-back {
  flex: none; font: inherit; font-size: 11.5px; padding: 3px 9px; border-radius: 6px; cursor: pointer;
  color: var(--dsw-alias-label-secondary, inherit);
  background: transparent; border: 1px solid var(--dsw-alias-border-l1, var(--dsh-border, #2e3440));
  display: inline-flex; align-items: center; gap: 4px;
}
.dms-back:hover { background: var(--dsw-alias-interactive-bg-hover, transparent); }
.dms-title {
  display: flex; align-items: center; gap: 6px; min-width: 0;
  font-size: 13px; font-weight: 650; letter-spacing: -.01em;
}
.dms-title-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dms-chip {
  flex: none; max-width: 40%; font-size: 10px; font-weight: 650; padding: 0 6px; border-radius: 4px;
  color: var(--dsw-alias-label-primary-bluish, inherit);
  border: 1px solid color-mix(in srgb, var(--dsw-static-deepseek-400, #4b6bfb) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-static-deepseek-400, #4b6bfb) 8%, transparent);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* --- stream：宿主 ChatView 的 scroll/column 画法 --- */
.dms-stream {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin;
  padding: 16px calc(var(--dsh-composer-side-clearance) + 16px);
}
.dms-column {
  max-width: var(--dsh-chat-content-width); width: 100%; margin: 0 auto;
  display: flex; flex-direction: column; gap: var(--dsh-chat-flow-gap, 6px);
}
.dms-turn { display: flex; flex-direction: column; gap: 6px; }
.dms-turn + .dms-turn { --dsh-chat-flow-gap: 12px; }
.dms-turnmeta {
  display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(18px + var(--dsh-content-font-delta-secondary, 0px));
  color: var(--dsw-alias-label-tertiary, inherit);
}
.dms-turnmeta > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dms-user { display: flex; justify-content: flex-end; }
.dms-bubble-user {
  max-width: min(calc(var(--dsh-chat-content-width) * .702), 82%);
  padding: 10px 16px; border-radius: var(--dsw-radius-xl, 16px);
  background: var(--dsw-specific-bubble, color-mix(in srgb, var(--dsh-accent, #4b6bfb) 12%, transparent));
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(22px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-primary, inherit);
  white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
}
.dms-bubble-user.dms-bubble-capped { max-height: 260px; overflow-y: auto; scrollbar-width: thin; }
/* 助手正文：宿主 AssistantMarkdown 的根排版 + MarkdownText 的块间 16px。 */
.dms-agent { display: flex; justify-content: flex-start; min-width: 0; }
.dms-md {
  max-width: 100%; min-width: 0;
  display: flex; flex-direction: column; gap: 16px;
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-primary, inherit);
}
/* 工具调用 / 阶段：细窄的系统行，不抢对话的视线（宿主 secondary 字号）。 */
.dms-tool, .dms-stage {
  display: flex; align-items: baseline; gap: 6px; max-width: 100%; min-width: 0;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(18px + var(--dsh-content-font-delta-secondary, 0px));
  color: var(--dsw-alias-label-tertiary, inherit);
  padding: 0 2px;
}
.dms-tool { font-family: var(--dms-mono); font-size: 12px; word-break: break-word; }
.dms-tool-mark, .dms-stage-mark { flex: none; opacity: .8; }
.dms-errline {
  display: flex; align-items: baseline; gap: 6px; max-width: 100%; min-width: 0;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  color: var(--dsw-alias-state-error-primary, #d92d20); padding: 0 2px;
  white-space: pre-wrap; word-break: break-word;
}
.dms-stage { align-items: center; gap: 8px; min-width: 0; }
/* flex-basis 0：文本宽度由容器分给（内容长度不参与 sizing），长路径才会换行
 * 而不是把整行撑出面板。 */
.dms-stage .dms-stage-mark { flex: 1 1 0; min-width: 0; overflow-wrap: anywhere; word-break: break-word; white-space: normal; text-align: center; }
.dms-stage::before, .dms-stage::after { content: ''; flex: 0 1 24px; height: 1px; background: var(--dsw-alias-border-l1, var(--dsh-border, #2e3440)); }
/* 思考 / 工具折叠行：宿主 ReasoningRow 的画法 —— DisclosureRow 的 24px 行 +
 * secondary 摘要；展开正文缩进 22px（thinkBody 同款）。 */
.dms-flowrow { min-width: 0; max-width: 100%; }
/* 整轮过程只留一个汇总头；body 常驻，关闭时连命令标题也一并隐藏。 */
.dms-execution { min-width: 0; max-width: 100%; margin: 2px 0; }
.dms-execution[hidden] { display: none !important; }
.dms-execution > summary {
  display: flex; align-items: center; gap: 6px; min-width: 0; cursor: pointer;
  padding: 4px 2px; list-style: none;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
.dms-execution > summary::-webkit-details-marker { display: none; }
.dms-execution > summary:focus-visible { outline: 2px solid var(--dsh-accent, #4b6bfb); outline-offset: 2px; border-radius: 4px; }
.dms-execution-chevron { flex: none; transition: transform .16s ease; }
.dms-execution[open] > summary .dms-execution-chevron { transform: rotate(90deg); }
.dms-execution-count { min-width: 0; color: var(--dsw-alias-label-tertiary, inherit); white-space: nowrap; }
.dms-execution-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 4px 0 4px 14px; border-left: 1px solid var(--dsw-alias-border-l1, var(--dsh-border, #2e3440)); }
.dms-execution:not([open]) > .dms-execution-body { display: none !important; }
.dms-flowrow > summary { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.dms-flowrow .dms-flowsummary {
  min-width: 0; flex: auto; overflow: hidden;
  color: var(--dsw-alias-label-tertiary, inherit);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  white-space: nowrap; text-overflow: ellipsis;
}
.dms-flowrow .dms-flowname {
  font-family: var(--dms-mono); font-size: 12px;
  color: var(--dsw-alias-label-secondary, inherit);
}
.dms-flowbody {
  padding: 4px 0 4px calc(22px + var(--dsh-content-font-delta, 0px)); min-width: 0;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  color: var(--dsw-alias-label-secondary, inherit);
}
.dms-tooldetail {
  margin: 0; padding: 6px 8px; max-height: 280px; overflow-y: auto; scrollbar-width: thin;
  font-family: var(--dms-mono); font-size: 11.5px; line-height: 1.5;
  color: var(--dsw-alias-label-secondary, inherit);
  background: var(--dsw-alias-bg-layer-1, transparent);
  border-radius: var(--dsw-radius-sm, 6px);
  white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
}
.dms-truncated {
  font-size: var(--dsh-content-font-size-secondary, 13px);
  color: var(--dsw-alias-label-tertiary, inherit); padding: 0 2px;
}
.dms-typing {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  color: var(--dsw-alias-label-tertiary, inherit); padding: 0 2px;
}
.dms-typing i {
  width: 4px; height: 4px; border-radius: 50%; background: var(--dsw-alias-state-business-primary, var(--dsh-accent, #4b6bfb));
  animation: dms-pulse 1.1s ease-in-out infinite;
}
.dms-typing i:nth-child(2) { animation-delay: .18s; }
.dms-typing i:nth-child(3) { animation-delay: .36s; }
@keyframes dms-pulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
.dms-empty {
  margin: auto; font-size: var(--dsh-content-font-size-secondary, 13px);
  color: var(--dsw-alias-label-tertiary, inherit); text-align: center; padding: 24px;
}

/* --- composer：与宿主 InputBar 同构的三段 ---
 * 卡外 dock（notice）→ 卡片（输入行 + 工具行）→ 卡外 footer（状态 + 用量）。
 * CLI 续发只走文本通道（claude --resume / codex exec resume），所以工具行里
 * 不放附件、@ 引用、模型选择这些没有协议支撑的控件：左侧只读 CLI 徽标说明
 * 续发沿用的是哪套服务端配置，右侧是唯一的主操作（运行中 = 停止，否则 = 发送）。 */
.dms-composer {
  flex: none; display: flex; flex-direction: column; align-items: stretch; gap: 6px;
  width: 100%; padding: 0 var(--dsh-composer-side-clearance) 4px;
  container-type: inline-size; container-name: dms-composer;
}
/* 失败提示（宿主 notice 行）：贴在卡片上方，宽度与卡片对齐。 */
.dms-notice {
  width: 100%; max-width: var(--dsh-composer-card-max-width); align-self: center;
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-secondary, inherit);
  margin: 0; padding: 4px 8px; font-size: 12px; line-height: 18px;
}
.dms-notice-error { color: var(--dsw-alias-state-error-primary, #d92d20); }
.dms-card {
  width: 100%; max-width: var(--dsh-composer-card-max-width); align-self: center;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l2, var(--dsh-border, #2e3440));
  border-radius: var(--dsw-radius-panel, 28px);
  background: var(--dsw-specific-input-major, var(--dsh-bg-input, light-dark(#ffffff, #262b37)));
  box-shadow: var(--dsw-elevation-soft, 0 0 0 1px var(--dsw-elevation-stroke-color));
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  display: flex; flex-direction: column; gap: 0; padding-top: 8px;
}
.dms-inputrow { display: flex; align-items: flex-start; gap: 4px; min-width: 0; }
.dms-textarea {
  flex: 1 1 auto; min-width: 0; resize: none;
  min-height: 36px; max-height: var(--dsh-composer-text-max-height);
  font: inherit; line-height: inherit;
  padding: 4px 8px 0 14px; border: 0; outline: none;
  background: transparent; color: var(--dsw-alias-label-primary, inherit);
  caret-color: var(--dsw-alias-state-business-primary, var(--dsh-accent, #4b6bfb));
  scrollbar-width: thin; overflow-y: auto;
}
.dms-textarea::placeholder { color: var(--dsw-alias-label-caption, inherit); }
.dms-textarea:disabled { color: var(--dsw-alias-label-tertiary, inherit); cursor: not-allowed; }
/* 工具行：宿主 InputBar 的 row（左工具、右主操作，窄栏换行）。 */
.dms-toolrow {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 8px; min-width: 0; padding: 2px 8px 6px;
}
.dms-toolrow-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
/* 左下角那一格与宿主 InputBar 的 28px 圆钮同尺寸同底色，图标换成该 CLI 的
 * 品牌 logo（mask 上色，跟随亮/暗主题）。没有文字：宿主同位置也不带文字，
 * CLI 名在会话页头部 chip 和这里的 tooltip/aria-label 里。 */
.dms-cli-badge {
  display: grid; place-items: center; flex: none;
  width: 28px; height: 28px; border-radius: 999px; padding: 0;
  background: var(--dsw-specific-selector, var(--dsw-alias-interactive-bg-hover, transparent));
}
.dms-cli-logo {
  display: block; width: 15px; height: 15px;
  background: currentColor;
  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  -webkit-mask-position: center; mask-position: center;
  -webkit-mask-size: contain; mask-size: contain;
}
.dms-cli-badge[data-cli="claude"] { color: ${EXECUTOR_BRANDS['claude']!.color}; }
.dms-cli-badge[data-cli="claude"] .dms-cli-logo { -webkit-mask-image: ${EXECUTOR_BRANDS['claude']!.mask}; mask-image: ${EXECUTOR_BRANDS['claude']!.mask}; }
.dms-cli-badge[data-cli="codex"] { color: ${EXECUTOR_BRANDS['codex']!.color}; }
.dms-cli-badge[data-cli="codex"] .dms-cli-logo { -webkit-mask-image: ${EXECUTOR_BRANDS['codex']!.mask}; mask-image: ${EXECUTOR_BRANDS['codex']!.mask}; }
.dms-toolrow-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
/* 发送：宿主 InputBar 的 primary 圆钮（34px，上箭头）。 */
.dms-send {
  flex: none; width: 34px; height: 34px; border-radius: 999px; cursor: pointer;
  color: #fff; background: var(--dsw-alias-button-info-fill, var(--dsh-accent, #4b6bfb));
  border: 0; display: grid; place-items: center; padding: 0; transform: translateY(-2px);
}
.dms-send:hover { filter: brightness(1.08); }
.dms-send:disabled { opacity: .45; cursor: default; filter: none; }
/* 停止：运行中主操作换成宿主同位置的停止钮（同一个落点，不并列两个圆钮）。 */
.dms-stop {
  flex: none; width: 34px; height: 34px; border-radius: 999px; cursor: pointer;
  color: var(--dsw-alias-label-secondary, inherit);
  background: var(--dsw-specific-selector, var(--dsw-alias-interactive-bg-hover, transparent));
  border: 0; display: grid; place-items: center; padding: 0; transform: translateY(-2px);
}
.dms-stop:hover { color: var(--dsw-alias-state-error-primary, #d92d20); }
.dms-stop i { display: block; width: 10px; height: 10px; border-radius: 2px; background: currentColor; }
/* 卡外 footer：与宿主 conversation.composer.dock 的 StatsPills 同构。
 * 每个读数是「14px 图标 + label」的 pill（padding 1px 8px、radius sm、
 * label-tertiary、tabular-nums），pill 内部用 "·" 分隔符。没有数据的
 * pill 整个不渲染，所以不会留下孤立分隔符。 */
.dms-stats {
  width: 100%; max-width: var(--dsh-composer-card-max-width); align-self: center;
  display: flex; flex-wrap: wrap; align-items: center; justify-content: center; min-width: 0;
  padding: 0 4px; color: var(--dsw-alias-label-tertiary, inherit);
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
.dms-stat-pill {
  display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%;
  padding: 1px 8px; border-radius: var(--dsw-radius-sm, 6px);
  font: inherit; color: inherit; font-variant-numeric: tabular-nums; white-space: nowrap;
}
.dms-stat-pill svg { flex: none; width: 14px; height: 14px; }
.dms-stat-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dms-sep { color: var(--dsw-alias-separator-primary, var(--dsh-border, #2e3440)); margin: 0 6px; }
@container dms-composer (max-width: 560px) {
  .dms-toolrow { gap: 6px; }
}
`

const STYLE_ID = 'dsh-maestro-codex-session-styles'

/** 注入会话页样式表（按 id 幂等）。 */
function useSessionStyles(): void {
  useEffect(() => {
    const existing = document.getElementById(STYLE_ID)
    if (existing !== null) {
      // 插件刷新后复用节点，但必须换成新 CSS，不能继续保留旧折叠规则。
      if (existing.textContent !== SESSION_CSS) existing.textContent = SESSION_CSS
      return
    }
    const element = document.createElement('style')
    element.id = STYLE_ID
    element.textContent = SESSION_CSS
    document.head.appendChild(element)
  }, [])
}

/**
 * Markdown 代码块 chrome 的文案：直接读宿主 chat 词条（与主会话同一套字），
 * 宿主没挂上时退回本插件的中英文。字符串值作依赖 —— 文案不变则对象身份
 * 稳定，MarkdownText 的渲染缓存不被无谓丢弃。
 */
function useMarkdownLabels(): { code: { copyLabel: string; copiedLabel: string }; footnotes: string } {
  const copyLabel = chatT('copy') ?? '复制'
  const copiedLabel = chatT('copied') ?? '已复制'
  const footnotes = chatT('markdown.footnotes') ?? '脚注'
  return useMemo(() => ({
    code: { copyLabel, copiedLabel },
    footnotes,
  }), [copyLabel, copiedLabel, footnotes])
}

/** 一个轮次的完整内容（detail 轮询的累积结果）。 */
interface TurnState {
  readonly summary: MaestroTaskSummary
  readonly prompt?: string
  readonly cwd?: string
  readonly finalText?: string
  readonly error?: string
  readonly events: readonly MaestroTaskEvent[]
  readonly localTruncated?: boolean
}

/** 单个任务详情的跟随式轮询；请求错误和历史缓存独立保存。 */
function useTurnDetail(id: string, active: boolean, sessionIds?: readonly string[], access?: MaestroSessionAccess): {
  turn: TurnState | undefined; error: string | undefined; reload: () => void; restore: () => void
} {
  const scopeKey = sessionIds === undefined || sessionIds.length === 0 ? '' : [...sessionIds].sort().join(',')
  const cacheKey = JSON.stringify([id, scopeKey, access?.sessionId, access?.token])
  const [state, setState] = useState<{ key: string; turn: TurnState | undefined; error: string | undefined }>({ key: cacheKey, turn: undefined, error: undefined })
  const [nonce, setNonce] = useState(0)
  const fullHistory = useRef(false)
  const reload = useCallback(() => { setNonce(value => value + 1) }, [])
  const restore = useCallback(() => { fullHistory.current = true; reload() }, [reload])
  useEffect(() => {
    if (!active) return
    let cancelled = false
    let cursor = 0
    let failures = 0
    let timer: number | undefined
    setState(previous => previous.key === cacheKey ? previous : { key: cacheKey, turn: undefined, error: undefined })
    const load = async (): Promise<void> => {
      const result = await fetchTaskDetail(id, cursor, scopeKey === '' ? undefined : scopeKey.split(','), access)
      if (cancelled) return
      if (!result.ok) {
        failures += 1
        setState(previous => ({ key: cacheKey, turn: previous.key === cacheKey ? previous.turn : undefined, error: result.error }))
        if (failures < 5) timer = window.setTimeout(() => { void load() }, DETAIL_POLL_MS)
        return
      }
      failures = 0
      cursor = result.nextCursor
      setState((previous) => {
        const old = previous.key === cacheKey ? previous.turn : undefined
        // 重试/恢复从 0 重读，按 seq 去重，不能再次拼入已有事件。
        const bySeq = new Map((old?.events ?? []).map(event => [event.seq, event]))
        for (const event of result.events) bySeq.set(event.seq, event)
        const allEvents = [...bySeq.values()].sort((left, right) => left.seq - right.seq)
        const localTruncated = !fullHistory.current && (old?.localTruncated === true || allEvents.length > EVENT_CAP)
        return {
          key: cacheKey,
          error: undefined,
          turn: {
            summary: result.summary,
            ...(result.prompt === undefined ? {} : { prompt: result.prompt }),
            ...(result.cwd === undefined ? {} : { cwd: result.cwd }),
            ...(result.finalText === undefined ? {} : { finalText: result.finalText }),
            ...(result.error === undefined ? {} : { error: result.error }),
            localTruncated,
            events: fullHistory.current ? allEvents : allEvents.slice(-EVENT_CAP),
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
  }, [id, active, scopeKey, cacheKey, nonce])
  return { turn: state.key === cacheKey ? state.turn : undefined, error: state.key === cacheKey ? state.error : undefined, reload, restore }
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
  // 先保留选中节点的祖先路径，不能回到根后误选它的兄弟分支。
  const ancestors: string[] = [rootId]
  const seen = new Set<string>(ancestors)
  let current = rootId
  for (;;) {
    const parent = summaries[current]?.replyTo
    if (parent === undefined || seen.has(parent)) break
    ancestors.push(parent)
    seen.add(parent)
    current = parent
  }
  const chain = ancestors.reverse()
  current = rootId
  for (;;) {
    const next = byReplyTo.get(current)?.find(task => !seen.has(task.id))
    if (next === undefined) break
    chain.push(next.id)
    seen.add(next.id)
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

/** 事件行种类 → 渲染。文本走 MarkdownText；工具/错误/阶段是细窄系统行。 */
function EventRow(props: { event: MaestroTaskEvent; labels: ReturnType<typeof useMarkdownLabels> }): ReactNode {
  const { event, labels } = props
  if (event.kind === 'text') {
    return (
      <div className="dms-agent">
        <div className="dms-md"><MarkdownText text={event.text} labels={labels} /></div>
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
    // 工具失败的原因在 detail；复用可展开行，不能只留下工具名。
    if ((event.detail ?? '').trim() !== '') return <ToolRow event={event} />
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

/** 转录折叠块：连续 thinking 合成一个思考块；tool 各自成行；其余原样。 */
type FlowBlock =
  | { readonly kind: 'thinking'; readonly body: string; readonly seq: number }
  | { readonly kind: 'text'; readonly body: string; readonly seq: number }
  | { readonly kind: 'tool'; readonly event: MaestroTaskEvent }
  | { readonly kind: 'plain'; readonly event: MaestroTaskEvent }

/** 只合并相邻文本帧；工具/思考是逻辑边界，不破坏 Markdown 的真实换行。 */
export function flowBlocksOf(events: readonly MaestroTaskEvent[], finalText?: string): FlowBlock[] {
  let blocks: FlowBlock[] = []
  const errors = new Set<string>()
  for (const event of events) {
    const last = blocks[blocks.length - 1]
    if (event.kind === 'text') {
      if (last?.kind === 'text') blocks[blocks.length - 1] = { ...last, body: last.body + event.text }
      else blocks.push({ kind: 'text', body: event.text, seq: event.seq })
      continue
    }
    if (event.kind === 'thinking') {
      if (last?.kind === 'thinking') blocks[blocks.length - 1] = { ...last, body: `${last.body}\n\n${event.text}` }
      else blocks.push({ kind: 'thinking', body: event.text, seq: event.seq })
      continue
    }
    if (event.kind === 'tool' || event.kind === 'result') {
      blocks.push({ kind: 'tool', event })
      continue
    }
    if (event.kind === 'error') {
      // 同名工具可能有不同失败原因；只有摘要与详情都相同才去重。
      const key = JSON.stringify([event.text.trim(), event.detail?.trim() ?? ''])
      if (errors.has(key)) continue
      errors.add(key)
    }
    blocks.push({ kind: 'plain', event })
  }
  if (finalText === undefined || finalText.trim() === '') return blocks
  const streamed = blocks.filter((block): block is Extract<FlowBlock, { kind: 'text' }> => block.kind === 'text').map(block => block.body).join('')
  // 精确包含只能说明 final 已完整出现；反向包含必须显示 final 的新增内容。
  if (streamed !== '' && streamed.includes(finalText)) return blocks
  const textIndexes = blocks.flatMap((block, index) => block.kind === 'text' ? [index] : [])
  const lastIndex = textIndexes[textIndexes.length - 1]
  if (streamed !== '' && finalText.includes(streamed)) {
    // 最终快照覆盖全文时在最后正文的位置替换，工具/思考仍原序保留。
    blocks = blocks.flatMap<FlowBlock>((block, index) => block.kind !== 'text' ? [block]
      : index === lastIndex ? [{ ...block, body: finalText }] : [])
    return blocks
  }
  const lastText = lastIndex === undefined ? undefined : blocks[lastIndex]
  if (lastText?.kind === 'text') {
    if (lastText.body.includes(finalText)) return blocks
    if (finalText.includes(lastText.body)) {
      blocks[lastIndex as number] = { ...lastText, body: finalText }
      return blocks
    }
    // KMP 找正文尾部与 final 开头的精确重叠，线性复杂度，不抹掉 Markdown 空白。
    const prefix = new Array<number>(finalText.length).fill(0)
    for (let index = 1, matched = 0; index < finalText.length; index += 1) {
      while (matched > 0 && finalText[index] !== finalText[matched]) matched = prefix[matched - 1] ?? 0
      if (finalText[index] === finalText[matched]) matched += 1
      prefix[index] = matched
    }
    let overlap = 0
    for (let index = 0; index < lastText.body.length; index += 1) {
      const char = lastText.body[index]
      while (overlap > 0 && (overlap === finalText.length || char !== finalText[overlap])) overlap = prefix[overlap - 1] ?? 0
      if (char === finalText[overlap]) overlap += 1
    }
    if (overlap > 0) {
      blocks[lastIndex as number] = { ...lastText, body: lastText.body + finalText.slice(overlap) }
      return blocks
    }
  }
  blocks.push({ kind: 'text', body: finalText, seq: -1 })
  return blocks
}

/**
 * 展示层的阶段性文字折叠，不改变 CLI text 的语义或历史记录。
 * 最终答复精确覆盖的完整块、末尾原始回复及错误仍常显；找不到 final 就不折叠。
 */
export function processTextSeqs(blocks: readonly FlowBlock[], finalText?: string): ReadonlySet<number> {
  const folded = new Set<number>()
  if (finalText === undefined || finalText.trim() === '') return folded
  const texts = blocks.filter((block): block is Extract<FlowBlock, { kind: 'text' }> => block.kind === 'text')
  const finalAt = texts.map(block => block.body).join('').lastIndexOf(finalText)
  if (finalAt < 0) return folded
  // seq -1 是 flowBlocksOf 补出的快照；此前最后一段可能是截断但有效的答复。
  const lastOriginal = texts.filter(block => block.seq !== -1 && block.body.trim() !== '').pop()
  let offset = 0
  for (const block of texts) {
    const end = offset + block.body.length
    if (end <= finalAt && block !== lastOriginal && block.body.trim() !== ''
      && !block.body.includes(finalText) && !finalText.includes(block.body)) folded.add(block.seq)
    offset = end
  }
  return folded
}

/** 一段文本的首行（折叠摘要；宿主 ReasoningRow 的 firstLine 同款）。 */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return (newline === -1 ? text : text.slice(0, newline)).trim()
}

/** 本插件类型面里 MarkdownText 的 labels 形状（0.0.1 与 0.2 宿主同构）。 */
type MarkdownLabelsLike = { code: { copyLabel: string; copiedLabel: string }; footnotes: string }

/**
 * 宿主 0.2 primitives 才有的两个面：DisclosureRow（思考/工具折叠行的宿主
 * 皮肤）与 MarkdownText 的 `variant="compact"`。运行时都存在（宿主 chat 的
 * ReasoningRow 就在用），本插件打包面（0.0.1 类型）没有——按结构探测，缺了
 * 就退回朴素渲染。
 */
interface DisclosureRowPropsLike {
  icon: ReactNode
  title: string
  open: boolean
  expandable: boolean
  onToggle: () => void
  expandOnRowClick?: boolean | undefined
  collapsedContent?: ReactNode
  children?: ReactNode
}
const DisclosureRow = (uiPrimitives as typeof uiPrimitives & {
  DisclosureRow?: ComponentType<DisclosureRowPropsLike> | undefined
}).DisclosureRow
const MarkdownCompact = MarkdownText as unknown as ComponentType<{
  text: string; labels: MarkdownLabelsLike; variant?: 'body' | 'compact'
}>

/**
 * 思考图标：宿主 primitives 的 `IconThinkOutlineRegular`（本插件类型面没这个
 * 名字，运行时探测）；宿主没带上就退回内联四角星。
 */
const ThinkIcon = (uiPrimitives as { IconThinkOutlineRegular?: ComponentType<{ size?: number }> | undefined }).IconThinkOutlineRegular

function ThinkGlyph(props: { size?: number }): ReactNode {
  const Host = ThinkIcon
  if (Host !== undefined) return <Host size={props.size ?? 14} />
  return (
    <svg width={props.size ?? 14} height={props.size ?? 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden>
      <path d="M8 1.8l1.55 4.65L14.2 8l-4.65 1.55L8 14.2 6.45 9.55 1.8 8l4.65-1.55z" />
    </svg>
  )
}

/**
 * 「思考过程」折叠行（jetbrains-cc-gui 的 ThinkingBlock 画法 + 宿主
 * DisclosureRow 皮肤）：折叠时只露一行摘要，展开是 compact 排版的思考正文。
 */
function ThinkingRow(props: { body: string; running: boolean; labels: MarkdownLabelsLike; title?: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const title = props.title ?? (props.running ? '思考中' : chatT('message.think') ?? '思考过程')
  if (DisclosureRow === undefined) {
    return <details className="dms-flowrow">
      <summary className="dms-tool">{title}：{firstLine(props.body)}</summary>
      <div className="dms-flowbody"><MarkdownCompact text={props.body} labels={props.labels} variant="compact" /></div>
    </details>
  }
  return (
    <div className="dms-flowrow">
      <DisclosureRow
        icon={<ThinkGlyph size={14} />}
        title={title}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => { setOpen(value => !value) }}
        collapsedContent={<span className="dms-flowsummary">{firstLine(props.body)}</span>}
      >
        {open ? <div className="dms-flowbody"><MarkdownCompact text={props.body} labels={props.labels} variant="compact" /></div> : undefined}
      </DisclosureRow>
    </div>
  )
}

/**
 * 工具调用/失败折叠行：折叠 = [图标][工具名][一行摘要]；展开 = 参数与输出全文
 * （mono 卡片，超高滚动）。事件 detail 的第一行就是折叠摘要。
 */
function ToolRow(props: { event: MaestroTaskEvent }): ReactNode {
  const [open, setOpen] = useState(false)
  const detail = props.event.detail ?? ''
  const title = props.event.text
  const failed = props.event.kind === 'error'
  const icon = failed ? <span className="dms-errline" aria-label="工具失败">✖</span> : <IconCodeOutlineRegular size={14} />
  const preview = detail === '' ? (props.event.kind === 'result' ? '工具结果' : '无详细内容') : firstLine(detail)
  if (DisclosureRow === undefined) {
    return <details className="dms-flowrow">
      <summary className={failed ? 'dms-errline' : 'dms-tool'}>{failed ? icon : null}{title}：{preview}</summary>
      {detail === '' ? null : <pre className="dms-tooldetail">{detail}</pre>}
    </details>
  }
  return (
    <div className="dms-flowrow">
      <DisclosureRow
        icon={icon}
        title={props.event.text}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => { setOpen(value => !value) }}
        collapsedContent={<span className="dms-flowsummary">{firstLine(detail)}</span>}
      >
        {open && detail !== '' ? <pre className="dms-tooldetail">{detail}</pre> : undefined}
      </DisclosureRow>
    </div>
  )
}

/**
 * 每轮固定一个常驻过程容器：关闭时隐藏整个列表，不再平铺几十条命令标题。
 * 原生 details 保留 body/内行实例和用户展开状态，不随 final/phase 重挂载。
 * 过程内部与外显回复/错误各自保序；最终/有效部分回复/错误不进入外组。
 */
function TranscriptFlow(props: {
  blocks: readonly FlowBlock[]
  processTexts: ReadonlySet<number>
  running: boolean
  labels: MarkdownLabelsLike
}): ReactNode {
  const isProcess = (block: FlowBlock): boolean => block.kind === 'text' ? props.processTexts.has(block.seq)
    : block.kind !== 'plain' || block.event.kind !== 'error'
  const processBlocks = props.blocks.filter(isProcess)
  const visibleBlocks = props.blocks.filter(block => !isProcess(block))
  const renderBlock = (block: FlowBlock, process = false): ReactNode => {
    if (block.kind === 'thinking') return <ThinkingRow key={`thinking-${block.seq}`} body={block.body} running={props.running && block === props.blocks[props.blocks.length - 1]} labels={props.labels} />
    if (block.kind === 'tool') return <ToolRow key={`tool-${block.event.seq}`} event={block.event} />
    if (block.kind === 'text') {
      if (process) return <div key={`text-${block.seq}`} data-process-text=""><div className="dms-flowbody"><MarkdownCompact text={block.body} labels={props.labels} variant="compact" /></div></div>
      return <div className="dms-agent" key={`text-${block.seq}`}><div className="dms-md"><MarkdownText text={block.body} labels={props.labels} /></div></div>
    }
    return <EventRow key={`event-${block.event.seq}`} event={block.event} labels={props.labels} />
  }
  return (
    <>
      <details className="dms-execution" data-execution-process="" hidden={processBlocks.length === 0}>
        <summary>
          <svg className="dms-execution-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><path d="M6 3l5 5-5 5" /></svg>
          <ThinkGlyph size={14} />
          <span>思考与执行过程</span>
          <span className="dms-execution-count">· {processBlocks.length} 条记录{props.running ? ' · 运行中' : ''}</span>
        </summary>
        <div className="dms-execution-body">{processBlocks.map(block => renderBlock(block, true))}</div>
      </details>
      {visibleBlocks.map(block => renderBlock(block))}
    </>
  )
}

/** 一轮：轮次元信息 + 用户气泡 + 默认收起的过程 + 外显最终结果/失败原因。 */
function TurnView(props: {
  id: string
  active: boolean
  sessionIds?: readonly string[]
  access?: MaestroSessionAccess
  running: boolean
  labels: ReturnType<typeof useMarkdownLabels>
}): ReactNode {
  const { id, active, sessionIds, running, labels, access } = props
  const { turn, error, reload, restore } = useTurnDetail(id, active, sessionIds, access)
  // 载入态也必须稳定调用 hooks。
  const blocks = useMemo(() => flowBlocksOf(turn?.events ?? [], turn?.finalText), [turn])
  const processTexts = useMemo(() => turn?.summary.phase === 'done'
    ? processTextSeqs(blocks, turn.finalText) : new Set<number>(), [blocks, turn])
  if (turn === undefined && error !== undefined) {
    return (
      <div className="dms-turn">
        <p className="dms-empty">这一轮读不到了：{error} <button type="button" onClick={reload}>重试</button></p>
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
  return (
    <div className="dms-turn">
      <div className="dms-turnmeta">
        <span>{formatClock(summary.startedAt)}</span>
        {summary.model === '' ? undefined : <span>· {summary.model}</span>}
        {turn.cwd === undefined ? undefined : <span>· {turn.cwd}</span>}
        {summary.endedAt === undefined ? undefined : <span>· {formatDuration(summary.endedAt - summary.startedAt)}</span>}
      </div>
      <div className="dms-user">
        <div className={`dms-bubble-user${prompt.length > 420 ? ' dms-bubble-capped' : ''}`}>{prompt}</div>
      </div>
      {error === undefined ? null : <div className="dms-notice" role="alert">详情暂时读取失败，已保留历史：{error} <button type="button" onClick={reload}>重试</button></div>}
      {summary.truncated === true ? <div className="dms-truncated">服务端事件环已截断，较早事件已不在当前存档，无法从此接口恢复；最终回答仍会显示。</div> : undefined}
      {turn.localTruncated === true ? <div className="dms-truncated">本地仅显示最近 {EVENT_CAP} 个事件。<button type="button" onClick={restore}>恢复服务端保留的历史</button></div> : undefined}
      <TranscriptFlow blocks={blocks} processTexts={processTexts} running={running} labels={labels} />
      {turn.error !== undefined && turn.error.trim() !== '' && !turn.events.some(event => event.kind === 'error'
        && (event.text.trim() === turn.error?.trim() || event.detail?.trim() === turn.error?.trim()))
        ? (
          <div className="dms-errline">
            <span className="dms-tool-mark">✖</span>
            <span>{turn.error}</span>
          </div>
        )
        : undefined}
      {running
        ? (
          <div className="dms-typing" aria-label="CLI 正在执行">
            <i /><i /><i />
            <span>正在执行…</span>
          </div>
        )
        : undefined}
    </div>
  )
}

/** 会话页主组件。 */
export function SessionPage(props: {
  /** 打开时点中的任务（可以是链上任何一轮）。 */
  taskId: string
  /** 打开时那颗节点的 CLI——链的首轮还没被任务列表看到前，页面先用它标注。 */
  cli?: MaestroCliId
  /** 任务路由的会话范围（与看板一致）。 */
  sessionIds?: readonly string[]
  access?: MaestroSessionAccess
  /** 落点：`panel` = 看板上的覆盖层（默认，无右栏 tab 时的回落）；`tab` = 右栏 tab 座位。 */
  place?: 'panel' | 'tab'
  onClose?: () => void
}): ReactNode {
  const scopeKey = [...(props.sessionIds ?? [])].sort().join(',')
  if (props.access === undefined) return <div className="dms"><p className="dms-empty" role="alert">缺少当前父会话的 CLI 访问授权，请回到原父会话并重新打开。</p>{props.onClose === undefined ? null : <button type="button" onClick={props.onClose}>返回</button>}</div>
  return <SessionPageContent key={JSON.stringify([props.taskId, scopeKey, props.access.sessionId, props.access.token])} {...props} access={props.access} />
}

function SessionPageContent(props: Parameters<typeof SessionPage>[0] & { access: MaestroSessionAccess }): ReactNode {
  useSessionStyles()
  const { taskId, cli: cliHint, sessionIds, access, place = 'panel', onClose } = props
  const scopeKey = sessionIds === undefined || sessionIds.length === 0 ? '' : [...sessionIds].sort().join(',')
  const labels = useMarkdownLabels()

  // 回复链发现：轮询任务列表，用 replyTo 把链串起来。
  const [summaries, setSummaries] = useState<Record<string, MaestroTaskSummary>>({})
  const [listError, setListError] = useState<string | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const load = async (): Promise<void> => {
      const result = await fetchTasks(scopeKey === '' ? undefined : scopeKey.split(','), access)
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
  }, [scopeKey, access])

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
  // 续接引用只在后台使用（/task/reply 在服务端取真实 sessionRef），不展示。
  const replyAnchorId = replyAnchorOf(chain, summaries)

  // 模型目录会话页不再读取：续发沿用该 CLI 的服务端配置（模型与思考档位
  // 都不在会话页改）。

  // 输入框与发送。
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | undefined>(undefined)
  const sendingRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  useEffect(() => {
    if (pendingReplyId === undefined && !sending) sendingRef.current = false
  }, [pendingReplyId, sending])
  const submit = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (text === '' || sendingRef.current || sending || lastRunning || replyAnchorId === undefined) return
    sendingRef.current = true
    setSending(true)
    setSendError(undefined)
    const result = await replyTask(replyAnchorId, text, {
      access,
      ...(scopeKey === '' ? {} : { sessionIds: scopeKey.split(',') }),
    })
    if (!mountedRef.current) return
    setSending(false)
    if (!result.ok) {
      sendingRef.current = false
      setSendError(result.error)
      return
    }
    // 成功后保持同步锁，直到轮询确认 pending 轮次；state更新尚未提交也不能重发。
    setPendingReplyId(result.id)
    setDraft('')
  }, [draft, sending, lastRunning, replyAnchorId, scopeKey, access])

  const cancelLast = useCallback(() => {
    void cancelTask(lastId, scopeKey === '' ? undefined : scopeKey.split(','), access)
  }, [lastId, scopeKey, access])

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

  // 会话级用量：按回复链上已测量的轮次聚合，未测量的轮次不参与（不把缺失
  // 当成 0）。四个桶互不重叠，与看板 cli-detail 的 token 口径一致。
  const usageTotals = useMemo(() => {
    let input = 0
    let output = 0
    let cacheRead = 0
    let cacheWrite = 0
    let measured = 0
    for (const id of chain) {
      const usage = summaries[id]?.usage
      if (usage === undefined) continue
      input += usage.uncachedInputTokens
      output += usage.outputTokens
      cacheRead += usage.cacheReadTokens
      cacheWrite += usage.cacheWriteTokens
      measured += 1
    }
    if (measured === 0) return undefined
    return { input, output, cacheRead, cacheWrite, measured }
  }, [chain, summaries])
  const totalTokens = usageTotals === undefined ? undefined
    : usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite
  const cacheHit = usageTotals !== undefined && usageTotals.input + usageTotals.cacheRead > 0
    ? Math.round(usageTotals.cacheRead * 100 / (usageTotals.input + usageTotals.cacheRead))
    : undefined
  // tok/s 只看最近一轮：本轮输出 / 本轮耗时，跨境聚合没有意义。
  const lastUsage = lastSummary?.usage
  const tokensPerSecond = lastUsage !== undefined && lastSummary?.durationMs !== undefined && lastSummary.durationMs >= 500
    ? Math.round(lastUsage.outputTokens / (lastSummary.durationMs / 1000))
    : undefined
  const tokensTip = usageTotals === undefined ? undefined
    : `入 ${formatTokens(usageTotals.input)} · 缓存读 ${formatTokens(usageTotals.cacheRead)} · 缓存写 ${formatTokens(usageTotals.cacheWrite)} · 出 ${formatTokens(usageTotals.output)}（${String(usageTotals.measured)} 轮已测量）`
  const tokensPerSecondTip = lastUsage === undefined || lastSummary?.durationMs === undefined ? undefined
    : `最近一轮：输出 ${formatTokens(lastUsage.outputTokens)} tokens / ${formatDuration(lastSummary.durationMs)}`

  // 输入框随内容增高（宿主 InputBar 的同款行为），上限走宿主变量。
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const element = textareaRef.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${String(Math.min(element.scrollHeight, 336))}px`
  }, [draft])

  // 状态不在这里：页头徽标与看板常驻显示阶段，footer 只留读数。
  const notice = sendError ?? (listError === undefined ? undefined : `任务列表读取失败：${listError}`)
  return (
    <div className={place === 'panel' ? 'dms dms-panel' : 'dms'} role="dialog" aria-label="CLI 会话">
      {place === 'panel' ? (
        <div className="dms-head">
          <button type="button" className="dms-back" onClick={onClose} title="退回任务看板">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M10 3L5 8l5 5" />
            </svg>
            看板
          </button>
          <div className="dms-title">
            <span className="dms-title-text">{rootSummary?.title ?? 'CLI 会话'}</span>
            <span className="dms-chip">{CLI_LABELS[cli]}</span>
          </div>
        </div>
      ) : undefined}

      <div
        className="dms-stream" ref={streamRef} onScroll={onScroll}
        // 宿主 Markdown 的文件/图片/链接 delegate 优先。只有未被处理的
        // http(s) 链接才外开；本地路径不猜测宿主 endpoint。
        onClick={event => {
          if (event.defaultPrevented) return
          const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
          const href = anchor?.getAttribute('href') ?? ''
          if (!/^https?:/i.test(href)) return
          event.preventDefault()
          window.open(href, '_blank', 'noopener')
        }}
      >
        <div className="dms-column">
          {chain.map(id => (
            <TurnView
              key={id}
              id={id}
              active
              {...(sessionIds === undefined ? {} : { sessionIds })}
              {...(access === undefined ? {} : { access })}
              running={lastRunning && id === lastId}
              labels={labels}
            />
          ))}
        </div>
      </div>

      <div className="dms-composer">
        {notice === undefined ? undefined : <p className="dms-notice dms-notice-error" role="alert">{notice}</p>}
        <div className="dms-card">
          <div className="dms-inputrow">
            <textarea
              ref={textareaRef}
              className="dms-textarea"
              rows={1}
              title="Enter 发送 · Shift+Enter 换行"
              placeholder={
                lastRunning
                  ? (pendingReplyId !== undefined ? '回复已发出，等这一轮结束…' : '这一轮还在执行，结束后可以继续发消息…')
                  : replyAnchorId !== undefined
                    ? '给这个 CLI 会话发一条后续指令…'
                    : '这个会话里没有可续接的 CLI 会话引用，无法续发（重新派发一个可续接的任务吧）'
              }
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
          </div>
          <div className="dms-toolrow">
            <div className="dms-toolrow-left">
              <span
                className="dms-cli-badge" data-cli={cli} role="img" aria-label={CLI_LABELS[cli]}
                title={`${CLI_LABELS[cli]}：续发沿用它的服务端配置（模型与思考档位不在会话页改）；CLI 续发只接受文本，需要文件请把路径写进消息`}
              >
                <span className="dms-cli-logo" aria-hidden />
              </span>
            </div>
            <div className="dms-toolrow-actions">
              {lastRunning
                ? (
                  <button
                    type="button" className="dms-stop" onClick={cancelLast}
                    title="停止正在执行的这一轮（会取消当前 CLI 进程）" aria-label="停止这一轮"
                  >
                    <i aria-hidden />
                  </button>
                )
                : (
                  <button
                    type="button" className="dms-send" aria-label={sending ? '发送中' : '发送'}
                    title={sending ? '发送中…' : '发送（Enter）'}
                    disabled={replyAnchorId === undefined || sending || draft.trim() === ''}
                    onClick={() => { void submit() }}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M8 13V3.5" />
                      <path d="M3.5 8L8 3.5 12.5 8" />
                    </svg>
                  </button>
                )}
            </div>
          </div>
        </div>
        {/* 状态不在这里：会话页头部徽标与看板已经常驻显示阶段，footer 只放
            宿主同款的读数，避免同一屏里出现两处状态。 */}
        <div className="dms-stats">
          <span
            className="dms-stat-pill" data-composer-stat="activity"
            title={`回复链共 ${String(chain.length)} 轮${pendingReplyId === undefined ? '' : '（含刚发出、尚未入库的一轮）'}${tokensPerSecondTip === undefined ? '' : `；${tokensPerSecondTip}`}`}
          >
            <IconGaugeOutlineRegular />
            <span className="dms-stat-label">
              {`${String(chain.length)} 轮`}
              {tokensPerSecond === undefined ? undefined : <span className="dms-sep">·</span>}
              {tokensPerSecond === undefined ? undefined : <>{String(tokensPerSecond)} tok/s</>}
            </span>
          </span>
          {totalTokens === undefined && cacheHit === undefined ? undefined : (
            <span
              className="dms-stat-pill" data-composer-stat="usage"
              {...(tokensTip === undefined ? {} : { title: tokensTip })}
            >
              <IconDatabaseOutlineRegular />
              <span className="dms-stat-label">
                {totalTokens === undefined ? undefined : <>{formatTokens(totalTokens)} tok</>}
                {cacheHit === undefined ? undefined : (
                  <>{totalTokens === undefined ? undefined : <span className="dms-sep">·</span>}缓存命中 {String(cacheHit)}%</>
                )}
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
