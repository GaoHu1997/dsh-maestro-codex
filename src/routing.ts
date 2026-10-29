/**
 * Routing: which CLI runs a given task. The main agent may name a CLI
 * explicitly (`cli` tool parameter); otherwise task-type keywords decide, and
 * the configured default breaks ties. Also builds the system-prompt hint that
 * teaches the main agent the routing table.
 */

import { TASK_DIFFICULTIES, TASK_DIFFICULTY_LABELS, isTaskDifficulty, type EffectiveConfig, type TaskDifficulty } from './config.js'
import type { MaestroCliId } from './wire.js'

export const CLI_IDS: readonly MaestroCliId[] = ['claude', 'codex']

/** The routing decision for one dispatch request. */
export interface RoutingDecision {
  cli: MaestroCliId
  reason: 'requested' | 'keyword' | 'default'
  /** When requested/keyword fell through to the default, why. */
  note: string | undefined
}

export class RoutingError extends Error {}

/** Validate semantic assessments, including callers that bypass the tool parser. */
export function taskDifficultyError(taskDifficulty: unknown, difficultyReason: unknown): string | undefined {
  // Older callers are kept compatible, but can never acquire a high rank from
  // task keywords, an explicit CLI, or an unsupported user-requested flag.
  if (taskDifficulty === undefined && difficultyReason === undefined) return undefined
  if (!isTaskDifficulty(taskDifficulty)) {
    return `"task_difficulty" 必须是 ${TASK_DIFFICULTIES.join(' / ')}；请由主代理根据任务范围和复杂度评估`
  }
  if (typeof difficultyReason !== 'string' || difficultyReason.trim() === '') {
    return '"difficulty_reason" 必须是非空字符串，说明任务范围、步骤、依赖或风险，不能仅用任务类型关键词代替难度判断'
  }
  if (difficultyReason.length > 2_000) return '"difficulty_reason" 超过 2000 字符上限'
  return undefined
}

/** Runtime gate for the CLI already selected by routing; never reroutes. */
export function assertTaskDifficulty(config: EffectiveConfig, cli: MaestroCliId, taskDifficulty: unknown, difficultyReason: unknown): TaskDifficulty {
  const error = taskDifficultyError(taskDifficulty, difficultyReason)
  if (error !== undefined) throw new RoutingError(error)
  const assessed = isTaskDifficulty(taskDifficulty) ? taskDifficulty : 'low'
  const minimum = config[cli].minTaskDifficulty
  // Defend direct/SDK callers as well as volatile configuration updates.
  if (!isTaskDifficulty(minimum)) {
    throw new RoutingError(`配置 ${cli}.minTaskDifficulty 无效，拒绝派发 ${cli} CLI 任务；请在配置页选择 low / medium / high / extreme`)
  }
  if (TASK_DIFFICULTIES.indexOf(assessed) < TASK_DIFFICULTIES.indexOf(minimum)) {
    const legacyNote = taskDifficulty === undefined ? '未提供难度评估，保守按低处理；' : ''
    throw new RoutingError(
      `${legacyNote}任务难度 ${TASK_DIFFICULTY_LABELS[assessed]}（${assessed}）低于最低难度 ${TASK_DIFFICULTY_LABELS[minimum]}（${minimum}）（实际 CLI：${cli}），未启动 CLI。请由主代理直接完成；只有真实评估达到该 CLI 门槛时才提交 task_difficulty 和 difficulty_reason，指定 cli 或用户点名也不能绕过门槛，也不会改选另一 CLI 绕过限制。`,
    )
  }
  return assessed
}

/**
 * Pick the CLI for one task. `requested` is the tool's `cli` parameter
 * ('auto' or empty = decide here). Throws `RoutingError` when the request
 * names a disabled CLI and nothing else can take the task.
 */
export function pickCli(config: EffectiveConfig, requested: string, taskText: string): RoutingDecision {
  const wanted = requested.trim() === '' ? 'auto' : requested.trim().toLowerCase()
  if (wanted !== 'auto') {
    if (!(CLI_IDS as readonly string[]).includes(wanted)) {
      throw new RoutingError(`未知 CLI "${requested}"（支持 ${CLI_IDS.join(' / ')} 或 auto）`)
    }
    const enabled = wanted === 'claude' ? config.claude.enabled : config.codex.enabled
    if (!enabled) {
      const fallback = otherOf(wanted as MaestroCliId)
      const fallbackEnabled = fallback === 'claude' ? config.claude.enabled : config.codex.enabled
      if (!fallbackEnabled) throw new RoutingError(`${wanted} 已停用，且另一个 CLI 也未启用`)
      return { cli: fallback, reason: 'default', note: `${wanted} 已停用，回落到 ${fallback}` }
    }
    return { cli: wanted as MaestroCliId, reason: 'requested', note: undefined }
  }
  const scored = CLI_IDS
    .filter(cli => (cli === 'claude' ? config.claude.enabled : config.codex.enabled))
    .map(cli => ({ cli, score: keywordScore(config, cli, taskText) }))
    .sort((a, b) => b.score - a.score)
  if (scored.length === 0) throw new RoutingError('两个 CLI 都未启用，无法派发任务')
  const best = scored[0]
  if (best === undefined) throw new RoutingError('两个 CLI 都未启用，无法派发任务')
  if (best.score > 0) {
    // A stable sort would otherwise always hand a tie to the first CLI_IDS
    // entry, silently ignoring the configured default. Break ties explicitly.
    const tied = scored.filter(entry => entry.score === best.score)
    if (tied.length > 1) {
      const preferred = tied.find(entry => entry.cli === config.defaultCli)
      if (preferred !== undefined) {
        return { cli: preferred.cli, reason: 'keyword', note: `按任务类型命中（平分取默认 ${preferred.cli}）` }
      }
    }
    return {
      cli: best.cli,
      reason: 'keyword',
      note: tied.length > 1 ? `按任务类型命中（${tied.map(entry => entry.cli).join('/')} 同分，取 ${best.cli}）` : '按任务类型命中',
    }
  }
  const preferred = config.defaultCli
  const preferredEnabled = preferred === 'claude' ? config.claude.enabled : config.codex.enabled
  const chosen = preferredEnabled ? preferred : best.cli
  return { cli: chosen, reason: 'default', note: best.score === 0 ? `无任务类型命中，使用默认 ${chosen}` : undefined }
}

function otherOf(cli: MaestroCliId): MaestroCliId {
  return cli === 'claude' ? 'codex' : 'claude'
}

/** Case-insensitive keyword hit count of one CLI's task types in the task text. */
export function keywordScore(config: EffectiveConfig, cli: MaestroCliId, taskText: string): number {
  const types = cli === 'claude' ? config.claude.taskTypes : config.codex.taskTypes
  const text = taskText.toLowerCase()
  let score = 0
  for (const type of types) {
    const keyword = type.trim().toLowerCase()
    if (keyword !== '' && text.includes(keyword)) score += 1
  }
  return score
}

/**
 * The system-prompt hint: the routing table the main agent reads before
 * deciding whether (and how) to call the dispatch tool. `unavailable` is set
 * when the tool could not be registered — advertising a tool the model cannot
 * call is worse than saying nothing.
 */
export function routingHint(config: EffectiveConfig, toolName: string, unavailable?: string): string {
  if (!config.enabled) return ''
  if (unavailable !== undefined) {
    return [
      `## CLI 子代理（不可用：${toolName}）`,
      `本插件的 ${toolName} 工具本次未能注册成功，本环境没有可调用的 CLI 子代理。不要尝试调用 dispatch 类工具；请用你自己的工具直接完成任务。`,
      `注册失败原因：${unavailable}`,
    ].join('\n')
  }
  const sections: string[] = []
  if (config.claude.enabled) {
    const permission = config.claude.permissionMode === 'inherit' ? 'CLI 默认策略' : config.claude.permissionMode
    sections.push(
      `- claude cli：擅长 ${config.claude.taskTypes.join('、') || '（未配置任务类型）'}`
      + `，最低任务难度：${TASK_DIFFICULTY_LABELS[config.claude.minTaskDifficulty]}（${config.claude.minTaskDifficulty}）`
      + `，权限 ${permission}`,
    )
  }
  if (config.codex.enabled) {
    sections.push(
      `- codex cli：擅长 ${config.codex.taskTypes.join('、') || '（未配置任务类型）'}`
      + `，最低任务难度：${TASK_DIFFICULTY_LABELS[config.codex.minTaskDifficulty]}（${config.codex.minTaskDifficulty}）`
      + `，沙箱 ${config.codex.sandbox}`,
    )
  }
  if (sections.length === 0) return ''
  return [
    `## CLI 子代理（${toolName}）`,
    '本环境接入了外部 CLI 子代理，但任务类型命中或用户点名不是派发许可。先由主代理按实际范围、步骤、依赖和风险做语义难度评估；按请求或 auto 路由确定真实 CLI 后，只有达到该 CLI 的独立最低难度才可调用。低于门槛请使用自己的工具直接完成，不要先尝试 CLI，也不要改选另一 CLI 绕过限制。',
    '各 CLI 分别配置最低任务难度。四级有序：low < medium < high < extreme，等于门槛允许派发。',
    '- 低（low）：简短问答、说明、单点修复或小范围编辑；即使提到重构/测试/文档，也不能仅凭关键词升档。',
    '- 中（medium）：范围明确但需要多步完成的一般任务。',
    '- 高（high）：跨模块重构、多个组件协作且有明显依赖或回归风险的任务。',
    '- 极高（extreme）：系统级复杂任务，涉及架构级约束、广泛依赖或高风险迁移。',
    '- 调用必须填写 task_difficulty（low / medium / high / extreme）和非空 difficulty_reason（说明范围、步骤、依赖或风险，最多 2000 字符）；不要为了触发 CLI 夸大难度。旧调用缺评估保守按 low，不根据关键词推断为高难度。',
    '- 运行端先确定真实 CLI，再在创建任务或启动进程前检查该 CLI 的门槛；指定 cli="claude" / "codex" 或用户点名也不能绕过。被请求的 CLI 停用时，检查回落 CLI 的门槛；不会因为另一个 CLI 门槛较低而重新路由。',
    '路由表（确定真实 CLI 后检查其独立门槛）：',
    ...sections,
    `不指定 cli 参数时按任务类型自动路由，缺省使用 ${config.defaultCli}。调用要求：`,
    '- task 必须自包含（CLI 看不到本会话上下文）：目标、涉及文件、验收标准、输出格式写全；若任务依赖本会话的技能或上下文，把关键指令内联进 task。',
    '- cwd 传入你正在工作的目录（绝对路径）；省略时沿用宿主进程的工作目录，结果 notes 会标注实际目录。',
    '- 桥接的 dsh MCP 服务器对子代理可用，task 里可直接要求使用相应工具。',
  ].join('\n')
}
