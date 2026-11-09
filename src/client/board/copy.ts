/**
 * 看板词条覆盖：上游 `locales.ts` 是 verbatim vendored 文件（逐字节保真测试，
 * upstream-source.test.ts），改不了源码里的词条，就在运行时把导出的 zh/en 字典
 * 对象就地改写——`t()` 每次渲染都按 key 现读字典，改写立即生效。
 *
 * `tasksNodeJump`：上游叫「查看转录 / Open transcript」。本插件的语境里这个
 * 按钮对 dsh 子代理打开的是原生子会话转录、对 CLI 子代理打开的是插件的会话
 * 页，统一叫「查看会话 / Open session」更准（与 CLI 侧按钮共用一套词）。
 *
 * 主/子代理 → 主/子智能体：看板全站（节点徽标、头部计数、空态）统一用
 * 「智能体」的叫法。英文没有这层区分（都是 agent），en 字典不动。
 *
 * @module dsh-maestro-codex/client/board/copy
 */
import { en, zh, t } from './upstream/index.js'

/**
 * 空后台任务列表的槽位提示（「后台任务」面板常驻底部，列表为空也要显示空态）。
 * 依赖 {@link applyBoardCopy} 补写的 `jobsEmpty` 键。
 */
export function jobsEmptyLabel(): string {
  return t('jobsEmpty' as Parameters<typeof t>[0])
}

/**
 * 中断任务的看板状态词。上游只有「运行中 / 待命 / 已完成 / 出错」四态词条，
 * 而中断是第五种：没有结论、也不是失败，等人决定要不要重新派发。上游渲染器
 * 通过 `TasksAgentNode.stateText` 槽位接收这枚词，卡片状态位与树 meta 行共用。
 * 先补写字典再取词，避免任何调用顺序下拿到裸 key。
 */
export function interruptedStateLabel(): string {
  applyBoardCopy()
  return t('tasksStateInterrupted' as Parameters<typeof t>[0])
}

/** 应用看板词条覆盖（幂等；客户端 apply 时调用一次即可）。 */
export function applyBoardCopy(): void {
  zh.tasksNodeJump = '查看会话'
  en.tasksNodeJump = 'Open session'
  zh.subagentMainAgent = '主智能体'
  zh.tasksKindSubagent = '子智能体'
  zh.subagentEmpty = '暂无子智能体'
  zh.subagentEmptyDesc = '当前主智能体派生的子智能体将显示在这里'
  zh.subagentCount = '{count} 个子智能体'
  zh.subagentCountRunning = '{count} 个子智能体 · {running} 运行中'
  // 新键：上游字典没有空后台任务列表的文案，运行时补（同上就地改写，t() 现读生效）。
  ;(zh as Record<string, string>).jobsEmpty = '暂无后台任务'
  ;(en as Record<string, string>).jobsEmpty = 'No background jobs'
  // 第五种状态词：中断（等人决定是否重新派发），与详情浮层的「已中断」同词。
  ;(zh as Record<string, string>).tasksStateInterrupted = '已中断'
  ;(en as Record<string, string>).tasksStateInterrupted = 'Interrupted'
}
