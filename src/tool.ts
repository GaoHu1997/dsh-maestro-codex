/**
 * The `dispatch_cli_task` tool — the main agent's entry to the CLI subagents.
 * Registered through the host's own `tools` service (the `generate_image`
 * precedent): execute validates, delegates to the shared dispatch runner, and
 * returns the structured answer whose schema the host enforces. `exec.signal`
 * must reach the child — a user stop kills the CLI, not just abandons the run.
 */

import type { Context } from '@deepseek-ai/cordis'
import { parseDispatchParams, runDispatch, type DispatchDeps, type DispatchParams, type DispatchValue } from './dispatch.js'

export const TOOL_NAME = 'dispatch_cli_task'

/** The deps the tool needs — the same stable dispatch instance the routes use. */
export type MaestroToolDeps = DispatchDeps

/** The model-facing JSON schema of the canonical value (harness dialect). */
const OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    ok: { type: 'boolean', required: true },
    cli: { type: 'string', required: true },
    model: { type: 'string', required: true },
    cwd: { type: 'string', required: true },
    durationMs: { type: 'integer', required: true },
    exitCode: { type: 'integer' },
    sessionRef: { type: 'string', required: true },
    finalText: { type: 'string', required: true },
    notes: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const TOOL_PARAMETERS = {
  task: { type: 'string', required: true, description: '完整、自包含的任务描述。CLI 子代理看不到本会话上下文：目标、涉及的文件路径、验收标准、输出格式都要写全。' },
  cli: { type: 'string', description: '"claude" / "codex" / 缺省 auto。auto 时按任务类型路由表自动选择；用户点名 CLI 时必须照办。' },
  cwd: { type: 'string', description: '执行目录（绝对路径），缺省用当前工作区根目录。' },
  model: { type: 'string', description: '覆盖该 CLI 配置的模型；用户点名模型时才填。' },
  timeout_minutes: { type: 'number', description: '超时（分钟），缺省用配置页的每 CLI 超时。' },
} as const

/**
 * Register the dispatch tool (and return its disposer). Name collisions fall
 * back to `maestro_dispatch_task` so a hard failure never takes the plugin down.
 */
export function registerDispatchTool(ctx: Context, deps: MaestroToolDeps): { readonly name: string; readonly dispose: () => void } {
  const tools = (ctx as unknown as { tools: { register(definition: unknown): unknown } }).tools

  const execute = async (rawArgs: unknown, exec: { signal: AbortSignal }): Promise<DispatchValue> => {
    const parsed = parseToolArgs(rawArgs)
    if (typeof parsed === 'string') throw new Error(parsed)
    try {
      return await runDispatch(deps, parsed, exec.signal)
    } catch (error) {
      // DispatchError messages are already agent-facing; anything else keeps
      // its own shape (the abort reason included).
      throw error
    }
  }

  const definitionFor = (name: string): unknown => ({
    name,
    description: '把一个完整任务派发给外部 CLI 子代理（claude cli 或 codex cli）执行并取回结果。适合：用户点名 claude/codex，或任务类型命中配置的路由表（如重构/测试/文档给 claude，脚本/快速修复给 codex）。CLI 子代理看不到本会话上下文，task 参数必须自包含。',
    parameters: TOOL_PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args: unknown, value: DispatchValue) => [
        { type: 'text' as const, text: renderSummary(value) },
      ],
    },
    presentCall: (args: unknown) => {
      const record = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
      return {
        card: 'generic' as const,
        title: `派发 CLI 任务（${typeof record['cli'] === 'string' && record['cli'] !== 'auto' && record['cli'] !== '' ? record['cli'] : 'auto'}）`,
        kind: 'other' as const,
        rawInput: {
          task: typeof record['task'] === 'string' ? record['task'].slice(0, 200) : '',
        },
      }
    },
    execute,
  })

  let name = TOOL_NAME
  let disposer: unknown
  try {
    disposer = tools.register(definitionFor(name))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/already registered/i.test(message)) throw error
    name = 'maestro_dispatch_task'
    deps.logger?.warn(`dsh-maestro-codex: tool name "${TOOL_NAME}" is taken — registering as "${name}"`)
    disposer = tools.register(definitionFor(name))
  }
  return {
    name,
    dispose: () => {
      if (typeof disposer === 'function') (disposer as () => void)()
    },
  }
}

/** Validate one raw args record; a string return is the error. */
export function parseToolArgs(raw: unknown): DispatchParams | string {
  // Same validation as the manual dispatch route — one shared parser.
  return parseDispatchParams(raw)
}

/** The summary text the tool result renders into the conversation. */
export function renderSummary(value: DispatchValue): string {
  const head = `[${value.cli}] ${value.ok ? '任务完成' : '任务失败'}（${Math.round(value.durationMs / 1000)}s，model=${value.model || '默认'}）`
  const body = value.finalText.trim() === '' ? '（CLI 未返回文本）' : value.finalText
  return value.ok ? `${head}\n\n${body}` : `${head}\n${body}`
}
