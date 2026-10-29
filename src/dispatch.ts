/**
 * The shared dispatch runner: one CLI task from request to settled registry
 * record. Both the `dispatch_cli_task` tool and the config card's manual
 * dispatch route go through here, so cancellation, concurrency, timeouts and
 * phase bookkeeping behave identically no matter who asks.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { modelTokenError, type EffectiveConfig, type TaskDifficulty } from './config.js'
import { runClaudeTask } from './channels/claude.js'
import { runCodexTask } from './channels/codex.js'
import { detectCli, type CliDetection } from './cli-manager.js'
import { RoutingError, assertTaskDifficulty, pickCli, taskDifficultyError } from './routing.js'
import { Limiter, TaskRegistry } from './task-registry.js'
import type { SpawnFn } from './spawn.js'
import { writeClaudeMcpConfig, unlinkQuiet, type DshMcpServer } from './mcp.js'
import type { DshModelEndpoint } from './dsh-models.js'
import { reportCliUsage, type CliUsageSession } from './usage.js'
import { cleanLogText, type MaestroCliId } from './wire.js'

/** Faces the dispatcher needs; the host apply builds one stable instance. */
export interface DispatchDeps {
  readConfig: () => EffectiveConfig
  registry: TaskRegistry
  limiter: Limiter
  /** Abort controllers by task id — the cancel route kills through these. */
  controllers: Map<string, AbortController>
  pathCache: CliPathCache
  /** Resolve a `<provider>::<model>` dsh-catalog selection into a CLI endpoint. */
  resolveDshModel?: ((selection: string) => Promise<DshModelEndpoint>) | undefined
  /** dsh's own MCP servers (the bridge hands them to every dispatched run). */
  listMcpServers?: (() => DshMcpServer[]) | undefined
  /** Injectable spawn seam (tests); absent = the real system spawn. */
  spawnFn?: SpawnFn | undefined
  logger?: { warn(message: string): void; error?(message: string): void }
}

/** One dispatch request (already validated by the caller). */
export interface DispatchParams {
  cli: string
  task: string
  /** Semantic assessment by the main agent; absent legacy assessments rank low. */
  taskDifficulty?: TaskDifficulty | undefined
  difficultyReason?: string | undefined
  cwd?: string | undefined
  model?: string | undefined
  timeoutMinutes?: number | undefined
  /** The calling agent's session id — the task board scopes by it. Not a model
   * parameter: the tool injects it from `exec.agent`. */
  sessionId?: string | undefined
  /**
   * The calling agent's own model route. The dispatch prefers it over the
   * configuration card's dsh model (see the resolution order in
   * {@link runDispatch}). Injected from `exec.agent`; never model-supplied.
   */
  primaryModel?: { provider: string; model: string } | undefined
  /**
   * The calling agent's session, used only to append the `maestro/cli-usage`
   * event so dsh and other plugins can read CLI spend. Injected from
   * `exec.agent`; headless runs have none.
   */
  usageSession?: CliUsageSession | undefined
}

/** The structured answer the tool returns and the card renders. */
export interface DispatchValue {
  ok: boolean
  cli: MaestroCliId
  model: string
  cwd: string
  durationMs: number
  exitCode: number | null
  sessionRef: string
  finalText: string
  notes: string[]
}

/** A CLI routing/availability failure with a user-facing message. */
export class DispatchError extends Error {}

/** Detection cache: one `where` + `--version` per minute per (cli, override). */
export class CliPathCache {
  private readonly cache = new Map<string, { at: number; detection: CliDetection }>()
  private static readonly TTL_MS = 60_000

  constructor(private readonly readConfig: () => EffectiveConfig, private readonly spawnFn?: SpawnFn) {}

  /** The resolved CLI path, or a friendly not-installed error. */
  async pathOf(cli: MaestroCliId, signal?: AbortSignal): Promise<string> {
    const config = this.readConfig()
    const override = cli === 'claude' ? config.claude.cliPath : config.codex.cliPath
    const key = `${cli}:${override}`
    const cached = this.cache.get(key)
    if (cached !== undefined && Date.now() - cached.at < CliPathCache.TTL_MS) {
      if (!cached.detection.installed) throw new DispatchError(notInstalledMessage(cli, cached.detection.error))
      return cached.detection.path
    }
    const detection = await detectCli({ cli, override, ...(this.spawnFn === undefined ? {} : { spawnFn: this.spawnFn }), ...(signal === undefined ? {} : { signal }) })
    this.cache.set(key, { at: Date.now(), detection })
    if (!detection.installed) throw new DispatchError(notInstalledMessage(cli, detection.error))
    return detection.path
  }

  /** Drop the cache (the refresh route and the npm jobs call this). */
  invalidate(): void {
    this.cache.clear()
  }
}

function notInstalledMessage(cli: MaestroCliId, error: string | undefined): string {
  return `${cli} cli 未安装或不可用${error === undefined ? '' : `（${error}）`}。可在本插件的配置页点击「安装」。`
}

/** `<provider>::<model>`, the selection shape `resolveDshModelEndpoint` consumes. */
function selectionOf(route: { provider: string; model: string } | undefined): string | undefined {
  if (route === undefined) return undefined
  const provider = route.provider.trim()
  const model = route.model.trim()
  if (provider === '' || model === '') return undefined
  return `${provider}::${model}`
}

/** Why a resolved dsh endpoint cannot drive this CLI, or undefined when it can. */
function protocolProblem(cli: MaestroCliId, endpoint: DshModelEndpoint): string | undefined {
  if (cli === 'claude' && endpoint.api !== 'anthropic-messages') {
    return `dsh 供应商 "${endpoint.provider}" 使用 ${endpoint.api} 协议，claude cli 只能映射 Anthropic 兼容（anthropic-messages）的供应商`
  }
  if (cli === 'codex' && endpoint.api === 'openai-completions') {
    // codex ≥0.146 removed chat-completions support entirely (wire_api="chat").
    return `dsh 供应商 "${endpoint.provider}" 是 chat-completions（openai-completions）协议，codex 0.146+ 已移除该支持；请在配置页选择 openai-responses 协议的供应商`
  }
  return undefined
}

/** Validate one raw dispatch body; a string return is the error message. */
export function parseDispatchParams(raw: unknown): DispatchParams | string {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const task = record['task']
  if (typeof task !== 'string' || task.trim() === '') return '"task" 不能为空：CLI 子代理需要完整任务描述'
  if (task.length > 100_000) return '"task" 超过 100k 字符上限'
  const taskDifficulty = record['task_difficulty']
  const difficultyReason = record['difficulty_reason']
  const assessmentError = taskDifficultyError(taskDifficulty, difficultyReason)
  if (assessmentError !== undefined) return assessmentError
  const cli = typeof record['cli'] === 'string' && record['cli'].trim() !== '' ? record['cli'].trim() : 'auto'
  const cwd = typeof record['cwd'] === 'string' && record['cwd'].trim() !== '' ? record['cwd'].trim() : undefined
  if (cwd !== undefined && (!isAbsolute(cwd) || !existsSync(cwd))) return `"cwd" 必须是已存在的绝对路径：${cwd}`
  const model = typeof record['model'] === 'string' && record['model'].trim() !== '' ? record['model'].trim() : undefined
  if (model !== undefined) {
    const error = modelTokenError(model)
    if (error !== undefined) return `"model" ${error}`
  }
  let timeoutMinutes: number | undefined
  if (typeof record['timeout_minutes'] === 'number' && Number.isFinite(record['timeout_minutes'])) {
    timeoutMinutes = Math.min(240, Math.max(1, Math.round(record['timeout_minutes'])))
  }
  return {
    cli, task, cwd,
    ...(taskDifficulty === undefined ? {} : {
      taskDifficulty: taskDifficulty as TaskDifficulty,
      difficultyReason: (difficultyReason as string).trim(),
    }),
    ...(model === undefined ? {} : { model }),
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
  }
}

/**
 * Run one dispatch to settlement. Throws `DispatchError` (or the abort reason)
 * on failure; resolves with the structured value on success. The registry
 * record carries the full event trail either way. `hooks.onTaskId` fires as
 * soon as the registry record exists (the manual route answers with the id
 * and polls, instead of holding the HTTP request open).
 */
export async function runDispatch(deps: DispatchDeps, params: DispatchParams, signal: AbortSignal, hooks?: { onTaskId?: (id: string) => void }): Promise<DispatchValue> {
  const config = deps.readConfig()
  if (!config.enabled) throw new DispatchError('CLI 子代理插件已停用（配置页可重新开启）')

  let decision
  let taskDifficulty: TaskDifficulty
  try {
    decision = pickCli(config, params.cli, params.task)
    taskDifficulty = assertTaskDifficulty(config, decision.cli, params.taskDifficulty, params.difficultyReason)
  } catch (error) {
    throw error instanceof RoutingError ? new DispatchError(error.message) : error
  }

  const notes: string[] = [
    `难度评估：${taskDifficulty}；${decision.cli} 最低难度：${config[decision.cli].minTaskDifficulty}；依据：${params.difficultyReason === undefined ? '旧调用未提供评估，保守按 low 处理' : cleanLogText(params.difficultyReason.trim())}`,
  ]
  if (decision.note !== undefined) notes.push(decision.note)
  const model = params.model ?? ''
  const timeoutMinutes = params.timeoutMinutes ?? (decision.cli === 'claude' ? config.claude.timeoutMinutes : config.codex.timeoutMinutes)
  // A missing cwd used to travel as `undefined`, silently inheriting whatever
  // directory the host process happened to be in. Resolve it once, say which
  // directory the run really used, and hand that same path to the child.
  const requestedCwd = params.cwd
  const cwd = requestedCwd ?? process.cwd()
  if (requestedCwd === undefined) notes.push(`未指定 cwd，沿用宿主进程目录：${cwd}`)

  const id = `task-${randomUUID().slice(0, 8)}`
  const abort = new AbortController()
  const onOuterAbort = (): void => abort.abort(signal.reason)
  if (signal.aborted) onOuterAbort()
  else signal.addEventListener('abort', onOuterAbort, { once: true })
  deps.controllers.set(id, abort)

  // The record exists before availability checks so a failed lookup is
  // visible in the monitor, and the manual route can answer with the id.
  const task = deps.registry.create({
    id,
    cli: decision.cli,
    title: params.task.replace(/\s+/g, ' ').slice(0, 80),
    cwd,
    model,
    ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
  })
  hooks?.onTaskId?.(id)

  try {
    let cliPath: string
    try {
      cliPath = await deps.pathCache.pathOf(decision.cli, abort.signal)
    } catch (error) {
      deps.registry.setPhase(task, abort.signal.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error))
      throw error
    }

    const slot = deps.limiter.acquire(abort.signal)
    try {
      await slot.waited
    } catch (error) {
      deps.registry.setPhase(task, 'cancelled', error instanceof Error ? error.message : '已取消')
      throw error instanceof Error ? error : new Error(String(error))
    }

    try {
      deps.registry.setPhase(task, 'running', `开始执行（${decision.cli}${model === '' ? '' : `, model=${model}`}, cwd=${cwd}，超时 ${timeoutMinutes} 分钟）`)
      const startedAt = Date.now()
      const onEvent = (kind: 'text' | 'note' | 'error', text: string): void => {
        deps.registry.push(task, kind, text)
      }

      // Model resolution order, narrowest first:
      //   1. an explicit tool-arg model (already validated),
      //   2. the calling agent's own route — but only when the CLI speaks its
      //      protocol (see `protocolProblem`),
      //   3. the configuration card's `<provider>::<model>` selection,
      //   4. the CLI's own default model.
      // The protocol check comes first for (2) on purpose: the main agent may
      // run on a provider the CLI cannot speak, and that is expected — the
      // dispatch drops straight to the configured model instead of failing.
      // A mismatch on (3) is an explicit operator choice and stays a hard error.
      let dshEndpoint: DshModelEndpoint | undefined
      // One note reaches both readers: the board's event trail and the tool
      // result the model sees.
      const note = (text: string): void => {
        notes.push(text)
        deps.registry.push(task, 'note', text)
      }
      if (params.model === undefined) {
        const configuredSelection = decision.cli === 'claude' ? config.claude.dshModel : config.codex.dshModel
        // Where a rejected primary route falls back to, named in the note so the
        // model never has to guess.
        const fallbackLabel = configuredSelection === '' ? 'CLI 默认模型' : '配置页模型'
        const attempts: Array<{ selection: string; label: string; fatal: boolean }> = []
        const primarySelection = selectionOf(params.primaryModel)
        if (primarySelection !== undefined) attempts.push({ selection: primarySelection, label: '主代理模型', fatal: false })
        if (configuredSelection !== '') attempts.push({ selection: configuredSelection, label: '配置页模型', fatal: true })
        for (const attempt of attempts) {
          if (deps.resolveDshModel === undefined) break
          let endpoint: DshModelEndpoint
          try {
            endpoint = await deps.resolveDshModel(attempt.selection)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (attempt.fatal) {
              deps.registry.setPhase(task, 'failed', message)
              throw error
            }
            note(`主代理模型 ${attempt.selection} 不可用（${message}），直接使用${fallbackLabel}`)
            continue
          }
          const problem = protocolProblem(decision.cli, endpoint)
          if (problem === undefined) {
            dshEndpoint = endpoint
            if (attempt.label === '主代理模型') note(`CLI 模型沿用主代理：${attempt.selection}`)
            break
          }
          if (attempt.fatal) {
            deps.registry.setPhase(task, 'failed', problem)
            throw new DispatchError(problem)
          }
          note(`主代理模型 ${attempt.selection} 的协议不受 ${decision.cli} 支持（${problem}），直接使用${fallbackLabel}`)
        }
      }
      const effectiveModel = params.model ?? (dshEndpoint !== undefined ? dshEndpoint.model : model)
      // The board shows the model the child really received, not the pre-route blank.
      deps.registry.setModel(task, effectiveModel)

      // MCP bridge: the same servers dsh itself runs, handed to the CLI run.
      const mcpServers = config.bridgeMcp === true ? deps.listMcpServers?.() ?? [] : []
      let mcpConfigPath: string | undefined
      try {
        if (decision.cli === 'claude' && mcpServers.length > 0) {
          mcpConfigPath = await writeClaudeMcpConfig(mcpServers)
        }

        const run = decision.cli === 'claude'
          ? runClaudeTask({
              ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
              claudePath: cliPath,
              task: params.task,
              cwd,
              model: effectiveModel,
              permissionMode: config.claude.permissionMode,
              baseUrl: dshEndpoint !== undefined ? dshEndpoint.baseURL : config.claude.baseUrl,
              authToken: dshEndpoint !== undefined ? dshEndpoint.apiKey : config.claude.authToken,
              ...(mcpConfigPath === undefined ? {} : { mcpConfigPath, mcpServerNames: mcpServers.map(server => server.name) }),
              timeoutMs: timeoutMinutes * 60_000,
              signal: abort.signal,
              onEvent,
            })
          : runCodexTask({
              ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
              codexPath: cliPath,
              task: params.task,
              cwd,
              model: effectiveModel,
              sandbox: config.codex.sandbox,
              configOverrides: config.codex.configOverrides,
              ...(dshEndpoint === undefined ? {} : {
                dshModel: {
                  model: dshEndpoint.model,
                  baseUrl: dshEndpoint.baseURL,
                  apiKey: dshEndpoint.apiKey,
                  wireApi: dshEndpoint.api === 'openai-responses' ? 'responses' as const : 'chat' as const,
                },
              }),
              ...(mcpServers.length > 0 ? { mcpServers } : {}),
              baseUrl: config.codex.baseUrl,
              apiKey: config.codex.apiKey,
              timeoutMs: timeoutMinutes * 60_000,
              signal: abort.signal,
              onEvent,
            })

        // Two cancel paths meet here: the outer signal (tool exec / HTTP cancel)
        // aborts `abort`, the child dies, and the run settles with a failure —
        // no separate race needed.
        const raced = await run

        const durationMs = Date.now() - startedAt
        if (raced.ok) {
          const finalText = cleanLogText(raced.finalText)
          task.exitCode = raced.exitCode ?? 0
          task.finalText = finalText
          task.stats = raced.stats
          deps.registry.setPhase(task, 'done', '执行完成')
          const sessionRef = 'sessionId' in raced ? raced.sessionId : raced.threadId
          if (sessionRef !== '') notes.push(`${decision.cli} session: ${sessionRef}`)
          for (const [key, stat] of Object.entries(raced.stats)) notes.push(`${key}: ${String(stat)}`)
          return {
            ok: true,
            cli: decision.cli,
            model: effectiveModel,
            cwd,
            durationMs,
            exitCode: raced.exitCode ?? 0,
            sessionRef,
            finalText,
            notes,
          }
        }
        const message = abort.signal.aborted
          ? '任务已取消'
          : raced.error ?? '任务失败（原因未知）'
        const timedOut = raced.stats['timedOut'] === true
        deps.registry.setPhase(task, timedOut ? 'timeout' : abort.signal.aborted ? 'cancelled' : 'failed', message)
        task.exitCode = raced.exitCode ?? undefined
        throw new DispatchError(`${decision.cli} 任务失败：${message}`)
      } finally {
        if (mcpConfigPath !== undefined) await unlinkQuiet(mcpConfigPath)
      }
    } finally {
      slot.release()
    }
  } finally {
    deps.controllers.delete(id)
    signal.removeEventListener('abort', onOuterAbort)
    // Report the settled run (success or failure) to dsh. The projection this
    // event folds into is how other plugins read CLI spend.
    reportCliUsage(params.usageSession, task)
  }
}
