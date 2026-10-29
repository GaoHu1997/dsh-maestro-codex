/**
 * Route handlers for the plugin's HTTP surface (`/plugin/dsh-maestro-codex/*`).
 * Every handler is a pure `deps → body → outcome` function so tests can drive
 * them without a host; the apply layer binds them to the webServer.
 */

import { randomUUID } from 'node:crypto'
import { redactEffective, type EffectiveConfig } from './config.js'
import { parseDispatchParams, runDispatch, type DispatchDeps } from './dispatch.js'
import { detectCli, runNpmJob } from './cli-manager.js'
import { isTerminalPhase } from './task-registry.js'
import { routingHint } from './routing.js'
import type { DshModelCatalog } from './dsh-models.js'
import type { DshMcpServer } from './mcp.js'
import { CLI_PACKAGES, CLI_LABELS, MAESTRO_CLI_IDS, type MaestroCliId, type MaestroCliStatus, type MaestroOverview, type MaestroRouteError, type MaestroTaskDetail, type MaestroTaskRef, type MaestroTaskSummary } from './wire.js'

/** One uniform handler outcome. */
export interface RouteOutcome {
  status: number
  body: unknown
}

export function ok(body: unknown): RouteOutcome {
  return { status: 200, body }
}

export function fail(status: number, error: string): RouteOutcome {
  return { status, body: { error } as MaestroRouteError }
}

/** Deps the route layer needs; the apply layer builds one stable instance. */
export interface RouteDeps extends DispatchDeps {
  /** Last-known CLI statuses, refreshed in the background. */
  statusStore: StatusStore
  /** The registered tool name (hint text + dispatch echo). */
  toolName: () => string
  /** The dsh model catalog for the card's model pickers. */
  listDshModels: () => Promise<DshModelCatalog>
  /** dsh's own MCP servers (names surfaced in the card, bridge feeds dispatches). */
  listMcpServers: () => DshMcpServer[]
  /** Diagnostics switch (query `?diag=1` era — enabled via config for now). */
  mcpDiagnosticsEnabled?: (() => boolean) | undefined
  /** The raw composed-settings describe (diagnostics only). */
  describeSettings?: () => Array<{ ns: string; value?: unknown }>
}

/**
 * Background-refreshed CLI status store. Detection spawns processes (where +
 * --version), so the overview route answers from the snapshot and a single
 * refresh loop keeps it warm (30s) — client polls stay cheap.
 */
export class StatusStore {
  private snapshot: Record<MaestroCliId, MaestroCliStatus> = {
    claude: { installed: false, version: '', path: '', error: '尚未检测' },
    codex: { installed: false, version: '', path: '', error: '尚未检测' },
  }
  private refreshing: Promise<void> | undefined

  constructor(private readonly readConfig: () => EffectiveConfig) {}

  get(): Record<MaestroCliId, MaestroCliStatus> {
    return this.snapshot
  }

  /** Detect every CLI once, replacing the snapshot wholesale. */
  async refresh(): Promise<void> {
    if (this.refreshing !== undefined) return this.refreshing
    this.refreshing = (async () => {
      try {
        const config = this.readConfig()
        const entries = await Promise.all(MAESTRO_CLI_IDS.map(async (cli): Promise<[MaestroCliId, MaestroCliStatus]> => {
          const override = cli === 'claude' ? config.claude.cliPath : config.codex.cliPath
          const detection = await detectCli({ cli, override })
          return [cli, {
            installed: detection.installed,
            version: detection.version,
            path: detection.path,
            ...(detection.error === undefined ? {} : { error: detection.error }),
          }]
        }))
        this.snapshot = Object.fromEntries(entries) as Record<MaestroCliId, MaestroCliStatus>
      } finally {
        this.refreshing = undefined
      }
    })()
    return this.refreshing
  }
}

/** GET overview — statuses, safe config view, recent tasks. */
export function handleOverview(deps: RouteDeps): RouteOutcome {
  const config = deps.readConfig()
  const tasks = deps.registry.list().slice(0, 20)
  const overview: MaestroOverview = {
    clis: deps.statusStore.get(),
    enabled: config.enabled,
    defaultCli: config.defaultCli,
    tasks,
  }
  return ok(overview)
}

/** GET tasks — the full summary list. */
export function handleTasks(deps: RouteDeps): RouteOutcome {
  return ok({ tasks: deps.registry.list() })
}

/** GET task?id=&cursor= — one task's detail plus events after the cursor. */
export function handleTaskDetail(deps: RouteDeps, query: URLSearchParams): RouteOutcome {
  const id = query.get('id') ?? ''
  if (id === '') return fail(400, '"id" 不能为空')
  const cursor = Number(query.get('cursor') ?? '0')
  const page = deps.registry.eventsSince(id, cursor)
  if (page === undefined) return fail(404, `任务不存在：${id}`)
  const task = page.task
  const summary: MaestroTaskSummary = deps.registry.summaryOf(task)
  const detail: MaestroTaskDetail = {
    summary,
    ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
    ...(task.finalText === undefined ? {} : { finalText: task.finalText }),
    ...(task.error === undefined ? {} : { error: task.error }),
    ...(task.stats === undefined ? {} : { stats: task.stats }),
    events: page.events,
    nextCursor: page.nextCursor,
  }
  return ok(detail)
}

/** POST task/cancel {id} — abort one queued/running task. */
export function handleTaskCancel(deps: RouteDeps, body: unknown): RouteOutcome {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  if (id === '') return fail(400, '"id" 不能为空')
  const task = deps.registry.get(id)
  if (task === undefined) return fail(404, `任务不存在：${id}`)
  if (isTerminalPhase(task.phase)) return fail(409, `任务已结束（${task.phase}），无需取消`)
  const controller = deps.controllers.get(id)
  if (controller === undefined) return fail(409, '任务尚未挂起执行进程，请稍后重试')
  controller.abort(new Error('用户在配置页取消了任务'))
  return ok({ id, phase: task.phase } satisfies MaestroTaskRef)
}

/** POST dispatch {cli,task,cwd?,model?,timeout_minutes?} — manual dispatch from the card.
 * Runs as a background task; the answer is the task ref and the card polls. */
export async function handleDispatch(deps: RouteDeps, body: unknown): Promise<RouteOutcome> {
  const params = parseDispatchParams(body)
  if (typeof params === 'string') return fail(400, params)
  const controller = new AbortController()
  let failure: string | undefined
  const ref = await new Promise<MaestroTaskRef | undefined>((resolvePromise) => {
    void runDispatch(deps, params, controller.signal, { onTaskId: id => resolvePromise({ id, phase: 'queued' }) })
      .catch((error: unknown) => { failure = error instanceof Error ? error.message : String(error) })
      .finally(() => { setTimeout(() => resolvePromise(undefined), 0) })
  })
  if (ref === undefined) return fail(400, failure ?? '任务未能创建')
  return ok(ref)
}

/** POST cli/refresh {cli?} — re-detect (one CLI or both) right now. */
export async function handleCliRefresh(deps: RouteDeps, body: unknown): Promise<RouteOutcome> {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const cli = record['cli']
  deps.pathCache.invalidate()
  if (typeof cli === 'string' && (MAESTRO_CLI_IDS as readonly string[]).includes(cli)) {
    const config = deps.readConfig()
    const override = cli === 'claude' ? config.claude.cliPath : config.codex.cliPath
    const detection = await detectCli({ cli: cli as MaestroCliId, override })
    const next = { ...deps.statusStore.get(), [cli]: {
      installed: detection.installed,
      version: detection.version,
      path: detection.path,
      ...(detection.error === undefined ? {} : { error: detection.error }),
    } }
    // One-CLI refresh writes through the store's snapshot shape.
    Object.assign(deps.statusStore.get(), next)
    return ok({ clis: deps.statusStore.get() })
  }
  await deps.statusStore.refresh()
  return ok({ clis: deps.statusStore.get() })
}

/**
 * POST cli/install|update|uninstall {cli} — start one npm job as a registry
 * task and answer immediately; the card watches it through the task poll.
 * `install` also serves as update (npm -g installs latest).
 */
export function handleCliNpmJob(deps: RouteDeps, action: 'install' | 'uninstall', body: unknown): RouteOutcome {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const cli = record['cli']
  if (typeof cli !== 'string' || !(MAESTRO_CLI_IDS as readonly string[]).includes(cli)) {
    return fail(400, `"cli" 必须是 ${MAESTRO_CLI_IDS.join(' | ')}`)
  }
  const config = deps.readConfig()
  const registry = deps.registry
  const id = `npm-${randomUUID().slice(0, 8)}`
  const controller = new AbortController()
  deps.controllers.set(id, controller)
  const task = registry.create({
    id,
    cli: cli as MaestroCliId,
    title: `${action === 'install' ? '安装/更新' : '卸载'} ${CLI_LABELS[cli as MaestroCliId]}（npm -g ${CLI_PACKAGES[cli as MaestroCliId]}）`,
    model: '',
  })
  void (async () => {
    try {
      registry.setPhase(task, 'running', `npm ${action} 开始${config.npmRegistry === '' ? '' : `（registry ${config.npmRegistry}）`}`)
      const result = await runNpmJob({
        action,
        cli: cli as MaestroCliId,
        registry: config.npmRegistry,
        signal: controller.signal,
        onLine: line => registry.push(task, 'note', line),
      })
      deps.pathCache.invalidate()
      if (result.ok) {
        registry.setPhase(task, 'done', `${CLI_PACKAGES[cli as MaestroCliId]} ${action} 成功`)
      } else {
        registry.setPhase(task, controller.signal.aborted ? 'cancelled' : 'failed',
          `${action} 失败（退出码 ${result.exitCode ?? 'null'}${result.timedOut ? '，超时' : ''}）：${result.stderrTail.trim() === '' ? '无输出' : result.stderrTail.trim().split(/\r?\n/).at(-1)}`)
      }
    } catch (error) {
      registry.setPhase(task, 'failed', error instanceof Error ? error.message : String(error))
    } finally {
      deps.controllers.delete(id)
      void deps.statusStore.refresh()
    }
  })()
  return ok({ id, phase: task.phase } satisfies MaestroTaskRef)
}

/** GET hint — the routing hint text (debug/preview for the card). */
export function handleHint(deps: RouteDeps): RouteOutcome {
  const config = deps.readConfig()
  return ok({ hint: routingHint(config, deps.toolName()), redacted: redactEffective(config) })
}

/** GET models — the dsh provider/model catalog for the card's pickers, plus the bridged MCP server names. */
export async function handleModels(deps: RouteDeps): Promise<RouteOutcome> {
  try {
    const catalog = await deps.listDshModels()
    const servers = deps.listMcpServers()
    const diagnostics = mcpDiscoveryDiagnostics(deps)
    return ok({
      providers: catalog.providers,
      mcpServers: servers.map(server => ({ name: server.name, source: server.source })),
      ...(diagnostics === undefined ? {} : { mcpDiagnostics: diagnostics }),
    })
  } catch (error) {
    return fail(500, error instanceof Error ? error.message : String(error))
  }
}

/** One-shot visibility into what the composed settings expose (key names only). */
function mcpDiscoveryDiagnostics(deps: RouteDeps): string[] | undefined {
  if (deps.mcpDiagnosticsEnabled?.() !== true) return undefined
  try {
    const entries = deps.describeSettings?.() ?? []
    return entries.map(entry => {
      const value = entry.value
      const keys = typeof value === 'object' && value !== null ? Object.keys(value as Record<string, unknown>).slice(0, 8).join(',') : typeof value
      return `${entry.ns}: ${keys}`
    })
  } catch (error) {
    return [`describe failed: ${error instanceof Error ? error.message : String(error)}`]
  }
}
