/**
 * 后台任务停靠槽。
 *
 * 上游 `JobsDrawer` 与 `tasks-graph.module.css` 是逐字节保真的 vendored 文件，不能改动，
 * 因此这里沿用 `accent.ts` 的注入式样式表做法：在 `Board.tsx` 里用一个带
 * `data-maestro-jobs-dock` 的包裹元素把抽屉钉在看板底部，再由本模块用更高特异性的
 * 规则把槽位固定成看板高度的 1/5。
 */
import css from './upstream/client/tasks-graph.module.css'

/** 包裹 `JobsDrawer` 的槽位元素属性（无值属性，渲染成 `<div data-maestro-jobs-dock="">`）。 */
export const JOBS_DOCK_ATTRIBUTE = 'data-maestro-jobs-dock'

/** 注入的 `<style>` 元素 id，用于幂等。 */
export const JOBS_DOCK_STYLE_ID = 'dsh-maestro-codex-jobs-dock'

/** 槽位占看板高度的比例：固定 1/5。 */
export const JOBS_DOCK_SHARE = '20%'

/** 抽屉标题栏在窄屏下的最小可见高度（见上游 `.jobsDrawerBar` 的 `height: 28px`）。 */
export const JOBS_DOCK_MIN_HEIGHT = '28px'

const DOCK = `[${JOBS_DOCK_ATTRIBUTE}]`

/**
 * 槽位本身是看板 column flex 容器的一个子项：`flex-basis: 20%` 相对看板的高度解析，
 * 因此看板再高再矮，抽屉都稳定占 1/5。
 */
const DOCK_RULE = `${DOCK} {
  flex: 0 0 ${JOBS_DOCK_SHARE};
  min-height: ${JOBS_DOCK_MIN_HEIGHT};
  display: flex;
  flex-direction: column;
  overflow: hidden;
}`

/** 上游 `.jobsDrawer` 自带 `flex: none`，这里让它撑满槽位，好把 20% 全部让给任务列表。 */
const SECTION_RULE = `${DOCK} > .${css.jobsDrawer} {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}`

/** 取消上游 `max-height: 156px` 的上限，改由槽位高度决定可视区，超出部分在槽位内部滚动。 */
const BODY_RULE = `${DOCK} > .${css.jobsDrawer} > .${css.jobsDrawerBody} {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
}`

/**
 * 用户手动折叠抽屉时（`open === false`，`jobsDrawerBody` 不渲染）槽位退回内容高度：
 * 只留 28px 的标题栏，不去占那 1/5 的空白。
 */
const COLLAPSED_RULE = `${DOCK}:not(:has(> .${css.jobsDrawer} > .${css.jobsDrawerBody})) {
  flex: 0 0 auto;
}`

export const JOBS_DOCK_CSS = [DOCK_RULE, SECTION_RULE, BODY_RULE, COLLAPSED_RULE].join('\n\n')

/** 幂等注入槽位样式；没有 DOM（SSR / node 测试）时安全返回。 */
export function injectJobsDock(): void {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(JOBS_DOCK_STYLE_ID)
  if (existing !== null) {
    if (existing.textContent !== JOBS_DOCK_CSS) existing.textContent = JOBS_DOCK_CSS
    return
  }
  const element = document.createElement('style')
  element.id = JOBS_DOCK_STYLE_ID
  element.textContent = JOBS_DOCK_CSS
  document.head.appendChild(element)
}
