/**
 * Routing: which CLI runs a given task. The main agent may name a CLI
 * explicitly (`cli` tool parameter); otherwise task-type keywords decide, and
 * the configured default breaks ties. Also builds the system-prompt hint that
 * teaches the main agent the routing table.
 */

import type { EffectiveConfig } from './config.js'
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
    return { cli: best.cli, reason: 'keyword', note: scored[1] !== undefined && scored[1].score === best.score ? '按任务类型命中（平分取默认优先）' : '按任务类型命中' }
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
 * deciding whether (and how) to call the dispatch tool.
 */
export function routingHint(config: EffectiveConfig, toolName: string): string {
  if (!config.enabled) return ''
  const sections: string[] = []
  if (config.claude.enabled) {
    const permission = config.claude.permissionMode === 'inherit' ? 'CLI 默认策略' : config.claude.permissionMode
    sections.push(
      `- claude cli：擅长 ${config.claude.taskTypes.join('、') || '（未配置任务类型）'}`
      + `${config.claude.model === '' ? '' : `，模型 ${config.claude.model}`}，权限 ${permission}`,
    )
  }
  if (config.codex.enabled) {
    sections.push(
      `- codex cli：擅长 ${config.codex.taskTypes.join('、') || '（未配置任务类型）'}`
      + `${config.codex.model === '' ? '' : `，模型 ${config.codex.model}`}，沙箱 ${config.codex.sandbox}`,
    )
  }
  if (sections.length === 0) return ''
  return [
    `## CLI 子代理（${toolName}）`,
    '本环境接入了外部 CLI 子代理。当任务整体适合交给外部编码代理完成（用户明确点名 claude/codex，或任务类型命中下表）时，调用该工具把完整任务描述交给对应 CLI，取回结果后向用户汇报。',
    '路由表：',
    ...sections,
    `不指定 cli 参数时按任务类型自动路由，缺省使用 ${config.defaultCli}。调用要求：`,
    '- task 必须自包含（CLI 看不到本会话上下文）：目标、涉及文件、验收标准、输出格式写全；若任务依赖本会话的技能或上下文，把关键指令内联进 task。',
    '- cwd 传入当前工作区目录（你正在工作的目录），CLI 子代理会在同一目录执行。',
    '- 桥接的 dsh MCP 服务器对子代理可用，task 里可直接要求使用相应工具。',
  ].join('\n')
}
