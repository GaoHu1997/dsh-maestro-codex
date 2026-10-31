/**
 * CLI 子代理标识色：上游的 `kindBadge` 是中性灰，本插件把带 `data-cli-executor`
 * 的 CLI 徽标重涂成湖蓝色——会话树/图里一眼认出 CLI 子代理（claude/codex 统一）。
 *
 * 只覆盖样式，不改 vendored 文件：上游源码与 CSS 有逐字节保真测试
 * （upstream-source.test.ts），这里走插件自有的注入式样式表（宿主壳没有 CSS
 * 管线，按 id 幂等）。选择器借看板根节点的 `data-maestro-board-root` 提高权重，
 * 稳定压过上游模块类的同权重规则；亮暗两套色都够醒目。
 *
 * @module dsh-maestro-codex/client/board/accent
 */

const ACCENT_CSS = `
[data-maestro-board-root] [data-cli-executor] {
  color: light-dark(#0b87ab, #3ec9f0);
  border-color: color-mix(in srgb, light-dark(#0b87ab, #3ec9f0) 45%, transparent);
}
`

const ACCENT_STYLE_ID = 'dsh-maestro-codex-board-accent'

/** Inject the CLI accent stylesheet (idempotent by id; safe across mounts). */
export function injectBoardAccent(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(ACCENT_STYLE_ID) !== null) return
  const element = document.createElement('style')
  element.id = ACCENT_STYLE_ID
  element.textContent = ACCENT_CSS
  document.head.appendChild(element)
}
