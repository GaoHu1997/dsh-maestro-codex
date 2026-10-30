/**
 * The `dispatch_cli_task` tool — the main agent's entry to the CLI subagents.
 * Registered through the host's own `tools` service (the `generate_image`
 * precedent): execute validates, delegates to the shared dispatch runner, and
 * returns the structured answer whose schema the host enforces. `exec.signal`
 * must reach the child — a user stop kills the CLI, not just abandons the run.
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { TASK_DIFFICULTIES } from './config.js'
import { parseDispatchParams, runDispatch, type DispatchDeps, type DispatchParams, type DispatchValue } from './dispatch.js'
import { externalCatalogRow, mirrorAsJob } from './job-mirror.js'
import { sessionUsageAppendOf, type CliUsageSession } from './usage.js'

export const TOOL_NAME = 'dispatch_cli_task'

/** The deps the tool needs — the same stable dispatch instance the routes use. */
export type MaestroToolDeps = DispatchDeps

/**
 * The model-facing JSON schema of the canonical value. This must stay inside
 * the harness's *enforced* JSON Schema subset: `required` is only legal as a
 * string array on an object node. Per-property `required: true` makes
 * `tools.register` throw `JsonSchemaError`, the tool then never exists, and
 * the routing hint advertises a tool the model cannot call.
 */
export const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    cli: { type: 'string' },
    model: { type: 'string' },
    cwd: { type: 'string' },
    durationMs: { type: 'integer' },
    exitCode: { type: 'integer' },
    sessionRef: { type: 'string' },
    finalText: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'cli', 'model', 'cwd', 'durationMs', 'sessionRef', 'finalText', 'notes'],
} as const

/**
 * The model-facing parameter schema. `tools.register` does not convert the
 * tool DSL — it hands this object to the model as-is — so it is plain JSON
 * Schema (object wrapper, `required` array).
 */
export const TOOL_PARAMETER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task: { type: 'string', description: '完整、自包含的任务描述。CLI 子代理看不到本会话上下文：目标、涉及的文件路径、验收标准、输出格式都要写全。' },
    cli: { type: 'string', description: '"claude" / "codex" / 缺省 auto。auto 按任务类型和默认配置路由，然后检查实际选定 CLI 的独立最低难度（停用请求回落时检查回落 CLI）；指定 CLI 或用户点名均不能绕过，也不会因另一 CLI 门槛较低而重新路由。' },
    task_difficulty: { type: 'string', enum: [...TASK_DIFFICULTIES], description: '主代理对任务实际范围、步骤、依赖和风险的语义评估：简短问答/小范围编辑 low，多步一般任务 medium，跨模块重构 high，系统级复杂任务 extreme；不要按关键词或为了触发 CLI 夸大难度。' },
    difficulty_reason: { type: 'string', description: '非空评估依据（最多 2000 字符），说明真实任务范围、步骤、依赖或风险；必须与 task_difficulty 同时提供，不能仅用任务类型关键词当理由。' },
    cwd: { type: 'string', description: '执行目录（绝对路径）。省略时沿用本会话工作区，并在返回的 notes 里标注实际使用的目录。' },
    resume: { type: 'string', description: '续接之前的 CLI 子代理会话：传上次结果里的 sessionRef（claude 的 session id 或 codex 的 thread id），本次任务作为该会话的后续指令执行。原会话对话不会自动带入，需要的结论要写进 task；不带此参数则开全新会话。' },
    model: { type: 'string', description: '临时指定该子代理的模型；不填则默认沿用主代理当前选择的模型（协议不支持该 CLI 时改用配置页的 dsh 模型）。两者都不可用时任务会直接报错并说明原因，不会回落到 CLI 自身配置的模型。' },
    timeout_minutes: { type: 'number', description: '超时（分钟，1–240），缺省用配置页的每 CLI 超时。' },
  },
  required: ['task', 'task_difficulty', 'difficulty_reason'],
} as const

/**
 * The slice of the host's tool-execution context this plugin reads. `agent` is
 * absent in headless/SDK runs, so both the session tag and the primary model
 * route are optional — a missing one only costs the auto-derived model.
 */
export interface ToolExec {
  readonly signal: AbortSignal
  readonly agent?: {
    readonly id?: string
    readonly options?: { readonly provider?: string; readonly model?: string }
    readonly session?: {
      requestHeader?: () => { readonly config?: { readonly provider?: string; readonly model?: string } } | undefined
      readonly append?: (type: string, data: unknown) => unknown
    }
  } | undefined
}

/**
 * The calling agent's effective model route. The request header is what the
 * last request actually used (registered provider + model); `options` is the
 * configured choice before routing. Either may be missing.
 */
export function primaryRouteOf(exec: ToolExec): { provider: string; model: string } | undefined {
  const agent = exec.agent
  if (agent === undefined) return undefined
  let header: { readonly provider?: string; readonly model?: string } | undefined
  try {
    header = agent.session?.requestHeader?.()?.config
  } catch {
    // A session without a header fold must not break the dispatch.
    header = undefined
  }
  const provider = header?.provider ?? agent.options?.provider
  const model = header?.model ?? agent.options?.model
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return undefined
  return { provider, model }
}

/** The owning session id, when the host exposes one. */
export function ownerSessionOf(exec: ToolExec): string | undefined {
  const id = exec.agent?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * The owning session's append handle (usage reporting). `undefined` when the
 * host session does not expose `append` — the dispatch then simply reports
 * nothing, and the board still shows the per-task stats.
 */
export function usageSessionOf(exec: ToolExec): CliUsageSession | undefined {
  return sessionUsageAppendOf(exec.agent?.session)
}

/**
 * Register the dispatch tool (and return its disposer). Name collisions fall
 * back to `maestro_dispatch_task`; any other registration failure (a schema
 * the host refuses, a missing service) propagates so the caller can log it
 * instead of silently losing the tool.
 */
export function registerDispatchTool(ctx: Context, deps: MaestroToolDeps): { readonly name: string; readonly dispose: () => void } {
  const tools = (ctx as unknown as { tools: { register(definition: unknown): unknown } }).tools

  const execute = async (rawArgs: unknown, exec: ToolExec): Promise<DispatchValue> => {
    const parsed = parseToolArgs(rawArgs)
    if (typeof parsed === 'string') throw new Error(parsed)
    const primaryModel = primaryRouteOf(exec)
    const sessionId = ownerSessionOf(exec)
    const usageSession = usageSessionOf(exec)
    const params: DispatchParams = {
      ...parsed,
      ...(primaryModel === undefined ? {} : { primaryModel }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(usageSession === undefined ? {} : { usageSession }),
    }
    // DispatchError messages are already agent-facing; anything else keeps its
    // own shape (the abort reason included).
    const jobs = deps.jobs?.()
    const mirror = deps.readConfig().mirrorAsJob !== false && jobs !== undefined && sessionId !== undefined
    const value = mirror
      ? await mirrorAsJob({
          jobs,
          owner: sessionId,
          label: `CLI(${parsed.cli}) ${parsed.task.replace(/\s+/g, ' ').slice(0, 60)}`,
          deps,
          params,
          signal: exec.signal,
        })
      : await runDispatch(deps, params, exec.signal)
    // A2: 一次成功的派发在父会话补一行 external 目录（拓扑树里的 ✓ 叶子）。
    // 会话事件模型不可见；失败的任务不写——✓ 只代表完成。绝不影响派发结果。
    if (value.ok && usageSession !== undefined && deps.readConfig().mirrorAsJob !== false) {
      try {
        usageSession.append('subagent/catalog', externalCatalogRow(`u-${randomUUID().slice(0, 8)}`, `cli · ${parsed.task.replace(/\s+/g, ' ').slice(0, 60)}`, Date.now()))
      } catch { /* catalog rows are observability; a refusal costs nothing */ }
    }
    return value
  }

  const definitionFor = (name: string): unknown => ({
    name,
    description: '仅将主代理语义评估达到实际选定 CLI 独立最低难度的完整任务派发给外部 CLI 子代理（claude cli 或 codex cli）执行并取回结果。派发前先判断该任务是否需要开子代理：不需要就由主代理自己完成，不要为了委派而委派；需要委派时再评估真实难度并提供 task_difficulty 和 difficulty_reason，按请求或 auto 路由确定真实 CLI（含停用回落），再检查该 CLI 的配置门槛；低于门槛改用 dsh 子代理（subagent / subagent_fork），禁止改选门槛更低的 CLI 绕过限制。简短问答/小范围编辑 low，多步一般任务 medium，跨模块重构 high，系统级复杂任务 extreme。任务类型命中、指定 cli 或用户点名均不能绕过门槛。CLI 看不到会话上下文，task 必须自包含；需要在上次结果的基础上继续时，传 resume=上次返回的 sessionRef 续接同一 CLI 会话。',
    parameters: TOOL_PARAMETER_SCHEMA,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
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
    if (!isToolNameTaken(error)) throw error
    name = FALLBACK_TOOL_NAME
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

/** The fallback name used when another plugin already owns `dispatch_cli_task`. */
export const FALLBACK_TOOL_NAME = 'maestro_dispatch_task'

function isToolNameTaken(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /already registered|already exists|duplicate/i.test(message)
}

/** Validate one raw args record; a string return is the error. */
export function parseToolArgs(raw: unknown): DispatchParams | string {
  // Same validation as the manual dispatch route — one shared parser.
  return parseDispatchParams(raw)
}

/** The rendered result text cap: the canonical value keeps the full text, the
 * conversation surface must not eat the context window with one CLI answer. */
const RENDER_TEXT_CAP = 20_000

/** The summary text the tool result renders into the conversation. */
export function renderSummary(value: DispatchValue): string {
  const head = `[${value.cli}] ${value.ok ? '任务完成' : '任务失败'}（${Math.round(value.durationMs / 1000)}s，model=${value.model || '默认'}）`
  const rawBody = value.finalText.trim() === '' ? '（CLI 未返回文本）' : value.finalText
  const body = rawBody.length > RENDER_TEXT_CAP
    ? `${rawBody.slice(0, RENDER_TEXT_CAP)}\n…（结果过长已截断 ${rawBody.length - RENDER_TEXT_CAP} 字符，完整文本见任务看板转录）`
    : rawBody
  return value.ok ? `${head}\n\n${body}` : `${head}\n${body}`
}
