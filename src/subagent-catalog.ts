/**
 * A2：派发一开始就往父会话补一行 `subagent/catalog`（`mode: 'external'`），
 * 内核会话顶部的「N 个子智能体」下拉框立刻能看到这条 CLI 子代理（external 行
 * 只作任务记录，不可打开，状态由本插件的任务看板提供）。
 *
 * 刻意**不**把 CLI 任务登记进宿主的后台任务（jobs 服务）：dsh 自己的子代理
 * 不出现在「后台任务」里，CLI 子代理也按同样方式处理——同一个任务在两处各有一
 * 份状态与一条终止入口，只会互相打架。看板卡片已经提供阶段、耗时、实时用量、
 * 转录与取消。
 */

/** A2 的 catalog 行：与宿主 establishExternalCatalogChild 的事件载荷同形。 */
export function externalCatalogRow(taskId: string, label: string, now: number): Record<string, unknown> {
  return { version: 2, childId: `cli-${taskId}`, childCreatedAt: now, mode: 'external', label }
}
