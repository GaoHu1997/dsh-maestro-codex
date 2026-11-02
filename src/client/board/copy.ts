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
import { en, zh } from './upstream/index.js'

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
}
