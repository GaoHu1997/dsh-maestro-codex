/**
 * The shared dispatch runner: one CLI task from request to settled registry
 * record. Both the `dispatch_cli_task` tool and the config card's manual
 * dispatch route go through here, so cancellation, concurrency, timeouts and
 * phase bookkeeping behave identically no matter who asks.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { modelTokenError, type EffectiveConfig } from './config.js'
import { runClaudeTask } from './channels/claude.js'
import { runCodexTask } from './channels/codex.js'
import { detectCli, type CliDetection } from './cli-manager.js'
import { RoutingError, pickCli } from './routing.js'
import { Limiter, TaskRegistry } from './task-registry.js'
import type { SpawnFn } from './spawn.js'
import { writeClaudeMcpConfig, unlinkQuiet, type DshMcpServer } from './mcp.js'
import type { DshModelEndpoint } from './dsh-models.js'
import type { MaestroCliId } from './wire.js'

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
  logger?: { warn(message: string): void }
}

/** One dispatch request (already validated by the caller). */
export interface DispatchParams {
  cli: string
  task: string
  cwd?: string | undefined
  model?: string | undefined
  timeoutMinutes?: number | undefined
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

/** Validate one raw dispatch body; a string return is the error message. */
export function parseDispatchParams(raw: unknown): DispatchParams | string {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const task = record['task']
  if (typeof task !== 'string' || task.trim() === '') return '"task" 不能为空：CLI 子代理需要完整任务描述'
  if (task.length > 100_000) return '"task" 超过 100k 字符上限'
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
  return { cli, task, cwd, ...(model === undefined ? {} : { model }), ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }) }
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
  try {
    decision = pickCli(config, params.cli, params.task)
  } catch (error) {
    throw error instanceof RoutingError ? new DispatchError(error.message) : error
  }

  const notes: string[] = []
  if (decision.note !== undefined) notes.push(decision.note)
  const model = params.model ?? (decision.cli === 'claude' ? config.claude.model : config.codex.model)
  const timeoutMinutes = params.timeoutMinutes ?? (decision.cli === 'claude' ? config.claude.timeoutMinutes : config.codex.timeoutMinutes)
  const cwd = params.cwd

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
      deps.registry.setPhase(task, 'running', `开始执行（${decision.cli}${model === '' ? '' : `, model=${model}`}${cwd === undefined ? '' : `, cwd=${cwd}`}，超时 ${timeoutMinutes} 分钟）`)
      const startedAt = Date.now()
      const onEvent = (kind: 'text' | 'note' | 'error', text: string): void => {
        deps.registry.push(task, kind, text)
      }

      // dsh-catalog model mapping: a `<provider>::<model>` selection wins over
      // the CLI's own configured model; a tool-arg model override wins over
      // both. claude only maps over anthropic-protocol providers. Resolution
      // failures land on the task record — never a stuck 'running'.
      let dshEndpoint: DshModelEndpoint | undefined
      const dshSelection = decision.cli === 'claude' ? config.claude.dshModel : config.codex.dshModel
      if (params.model === undefined && dshSelection !== '' && deps.resolveDshModel !== undefined) {
        try {
          dshEndpoint = await deps.resolveDshModel(dshSelection)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          deps.registry.setPhase(task, 'failed', message)
          throw error
        }
        if (decision.cli === 'claude' && dshEndpoint.api !== 'anthropic-messages') {
          const message = `dsh 供应商 "${dshEndpoint.provider}" 使用 ${dshEndpoint.api} 协议，claude cli 只能映射 Anthropic 兼容（anthropic-messages）的供应商`
          deps.registry.setPhase(task, 'failed', message)
          throw new DispatchError(message)
        }
        if (decision.cli === 'codex' && dshEndpoint.api === 'openai-completions') {
          // codex ≥0.146 removed chat-completions support entirely (wire_api="chat").
          const message = `dsh 供应商 "${dshEndpoint.provider}" 是 chat-completions（openai-completions）协议，codex 0.146+ 已移除该支持；请在配置页选择 openai-responses 协议的供应商`
          deps.registry.setPhase(task, 'failed', message)
          throw new DispatchError(message)
        }
      }
      const effectiveModel = params.model ?? (dshEndpoint !== undefined ? dshEndpoint.model : model)

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
          task.exitCode = raced.exitCode ?? 0
          task.finalText = raced.finalText
          task.stats = raced.stats
          deps.registry.setPhase(task, 'done', '执行完成')
          const sessionRef = 'sessionId' in raced ? raced.sessionId : raced.threadId
          if (sessionRef !== '') notes.push(`${decision.cli} session: ${sessionRef}`)
          for (const [key, stat] of Object.entries(raced.stats)) notes.push(`${key}: ${String(stat)}`)
          return {
            ok: true,
            cli: decision.cli,
            model: effectiveModel,
            cwd: cwd ?? '',
            durationMs,
            exitCode: raced.exitCode ?? 0,
            sessionRef,
            finalText: raced.finalText,
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
  }
}
