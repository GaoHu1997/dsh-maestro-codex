/**
 * The `dispatch_cli_task` tool — the main agent's entry to the CLI subagents.
 * Registered through the host's own `tools` service (the `generate_image`
 * precedent): execute validates, delegates to the shared dispatch runner, and
 * returns the structured answer whose schema the host enforces. `exec.signal`
 * must reach the child — a user stop kills the CLI, not just abandons the run.
 */

import type { Context } from '@deepseek-ai/cordis'
import { TASK_DIFFICULTIES } from './config.js'
import { DispatchError, parseDispatchParams, runDispatch, type DispatchDeps, type DispatchParams, type DispatchValue } from './dispatch.js'
import type { CliUsageSession } from './usage.js'
import { cliFailureDiagnostic } from './public-diagnostics.js'

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
    taskId: { type: 'string' },
    phase: { type: 'string' },
    error: { type: 'string' },
    cli: { type: 'string' },
    model: { type: 'string' },
    cwd: { type: 'string' },
    durationMs: { type: 'integer' },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    sessionRef: { type: 'string' },
    finalText: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'taskId', 'phase', 'cli', 'model', 'cwd', 'durationMs', 'sessionRef', 'finalText', 'notes'],
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
    task_name: { type: 'string', description: '简短任务名（任务看板节点标题，一句话概括这个子代理要做什么，40 字以内）；省略时自动取 task 的首行作为任务名。' },
    cli: { type: 'string', description: '"claude" / "codex" / "grok" / 缺省 auto。auto 按任务类型和默认配置路由，然后检查实际选定 CLI 的独立最低难度（停用请求回落时检查回落 CLI）；指定 CLI 或用户点名均不能绕过，也不会因另一 CLI 门槛较低而重新路由。' },
    task_difficulty: { type: 'string', enum: [...TASK_DIFFICULTIES], description: '主代理对任务实际范围、步骤、依赖和风险的语义评估：简短问答/小范围编辑 low，多步一般任务 medium，跨模块重构 high，系统级复杂任务 extreme；不要按关键词或为了触发 CLI 夸大难度。' },
    difficulty_reason: { type: 'string', description: '非空评估依据（最多 2000 字符），说明真实任务范围、步骤、依赖或风险；必须与 task_difficulty 同时提供，不能仅用任务类型关键词当理由。' },
    cwd: { type: 'string', description: '执行目录（绝对路径）。省略时沿用本会话工作区，并在返回的 notes 里标注实际使用的目录。' },
    resume: { type: 'string', description: '续接之前的 CLI 子代理会话：传上次结果里的 sessionRef（claude 的 session id、codex 的 thread id 或 grok 的 session id），本次任务作为该会话的后续指令执行。原会话对话不会自动带入，需要的结论要写进 task；不带此参数则开全新会话。' },
    model: { type: 'string', description: '临时指定 DSH 模型：provider::model 固定供应商且失败不回退；裸模型名绑定主代理或配置页的可信 DSH 供应商，保留该模型名逐一解析、校验协议并预检，不能借用 CLI 自带配置。省略时沿用主代理模型（协议不兼容或不可用则回退配置页的 dsh 模型）。无可用 DSH 端点时直接报错。' },
    timeout_minutes: { type: 'number', description: 'CLI 连续无 stdout/stderr 输出超时（分钟，1–240），不是总运行时长；非空输出分片重置计时。这是无输出保护，不代表任务语义进展。各 CLI 通道（Codex/Claude/Grok）持续重连另有同长度恢复期限，重复重连日志不会续期。缺省用配置页的统一超时。' },
    dedupe_key: { type: 'string', description: '可选幂等键：同一个键在 10 分钟窗口内只会真正启动一次（重复调用直接返回"已派发过"）。不传则按 父会话+cli+任务名+cwd 自动推导；续接（resume）不参与去重。' },
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
  /** Host-minted same-process execution identity; never reconstructed from JSON. */
  readonly token?: symbol | undefined
  readonly callId?: string | undefined
  readonly rootCallId?: string | undefined
  readonly agent?: {
    /** Public agent-scoped Context; not needed to resolve tools by agent identity. */
    readonly ctx?: Context | undefined
    readonly id?: string
    readonly options?: { readonly provider?: string; readonly model?: string }
    readonly session?: {
      /** Immutable storage header of the live session; carries the workspace cwd. */
      readonly header?: { readonly cwd?: string | undefined } | undefined
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
 * Keep the trusted host Session itself: dispatch also uses it for access and
 * the native child catalog. Volatile usage sinks are created only inside the
 * accounting functions; replacing this identity would rotate capabilities.
 */
export function usageSessionOf(exec: ToolExec): CliUsageSession | undefined {
  const session = exec.agent?.session
  return session !== undefined && typeof session.append === 'function' ? session as CliUsageSession : undefined
}

/** The calling session's workspace, from the host's immutable session header. */
export function sessionCwdOf(exec: ToolExec): string | undefined {
  try {
    const cwd = exec.agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    // A host without a readable session header must not break the dispatch.
    return undefined
  }
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
    const sessionCwd = sessionCwdOf(exec)
    const usageSession = usageSessionOf(exec)
    const params: DispatchParams = {
      ...parsed,
      ...(primaryModel === undefined ? {} : { primaryModel }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(sessionCwd === undefined ? {} : { sessionCwd }),
      ...(usageSession === undefined ? {} : { usageSession }),
      ...(exec.agent === undefined ? {} : { executionAgent: exec.agent }),
      executionContext: { agent: exec.agent, token: exec.token, callId: exec.callId, rootCallId: exec.rootCallId },
    }
    // Pre-task validation/authority errors still reject. Once a task exists,
    // keep its real failed/cancelled/timeout result (including recovery refs)
    // in the enforced output schema rather than dropping it with the throw.
    try {
      return modelDispatchValue(await runDispatch(deps, params, exec.signal))
    } catch (error) {
      if (error instanceof DispatchError && error.value !== undefined) return modelDispatchValue(error.value)
      throw error
    }
  }

  const definitionFor = (name: string): unknown => ({
    name,
    description: '仅将主代理语义评估达到实际选定 CLI 独立最低难度的完整任务派发给外部 CLI 子代理（claude cli、codex cli 或 grok cli）执行并取回结果。派发前先判断该任务是否需要开子代理：不需要就由主代理自己完成，不要为了委派而委派；需要委派时再评估真实难度并提供 task_difficulty 和 difficulty_reason，按请求或 auto 路由确定真实 CLI（含停用回落），再检查该 CLI 的配置门槛；低于门槛改用 dsh 子代理（subagent / subagent_fork），禁止改选门槛更低的 CLI 绕过限制。简短问答/小范围编辑 low，多步一般任务 medium，跨模块重构 high，系统级复杂任务 extreme。任务类型命中、指定 cli 或用户点名均不能绕过门槛。CLI 看不到会话上下文，task 必须自包含；需要在上次结果的基础上继续时，传 resume=上次返回的 sessionRef 续接同一 CLI 会话。',
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

/** Failure output is a model projection, not the canonical task record.
 * Keep recovery identity; never mistake raw product errors or partial text for
 * a successful answer. The authorized task detail retains original diagnostics.
 */
export function modelDispatchValue(value: DispatchValue): DispatchValue {
  if (value.ok) return value
  const error = cliFailureDiagnostic(value)
  return { ...value, error, finalText: '', notes: [error] }
}

/** The rendered result text cap: the canonical value keeps the full text, the
 * conversation surface must not eat the context window with one CLI answer. */
const RENDER_TEXT_CAP = 20_000

/** The summary text the tool result renders into the conversation. */
export function renderSummary(value: DispatchValue): string {
  value = modelDispatchValue(value)
  const head = `[${value.cli}] ${value.ok ? '任务完成' : '任务失败'}（${Math.round(value.durationMs / 1000)}s，model=${value.model || '默认'}）`
  const rawBody = value.finalText.trim() === '' ? '（CLI 未返回文本）' : value.finalText
  const body = rawBody.length > RENDER_TEXT_CAP
    ? `${rawBody.slice(0, RENDER_TEXT_CAP)}\n…（结果过长已截断 ${rawBody.length - RENDER_TEXT_CAP} 字符，完整文本见任务看板转录）`
    : rawBody
  // 续接提示直接进对话文本：notes 不在渲染结果里，模型看不到。返工/追加时
  // 传 resume 续接同一 CLI 会话，子代理带着完整上下文继续，不必重复背景。
  const resumeHint = value.sessionRef === '' ? ''
    : `\n\n如需返工或补充要求：再次调用本工具并传 resume="${value.sessionRef}"，会在同一 CLI 会话中带着完整上下文继续，无需重复背景信息。`
  const metadata = `taskId=${value.taskId}，phase=${value.phase}`
  const failure = !value.ok && value.error !== undefined ? `\n错误：${value.error}` : ''
  return `${head}\n${metadata}${failure}\n\n${body}${resumeHint}`
}
