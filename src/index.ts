/**
 * dsh-maestro-codex host half. Wires the dispatch tool, the routing hint, and
 * the HTTP surface onto the host context; config edits persist into the
 * profile patch and take effect live (every dispatch re-reads the config).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context declaration merge into this program.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the settings Context declaration merge (`ctx.settings`).
import type {} from '@deepseek-ai/dsh-settings'
import { effectiveOf, validateConfig, type Config } from './config.js'
import { CliPathCache } from './dispatch.js'
import { Limiter, TaskRegistry } from './task-registry.js'
import { registerDispatchTool, TOOL_NAME } from './tool.js'
import { routingHint } from './routing.js'
import { listDshModels, resolveDshModelEndpoint, type SettingsDescribeFace } from './dsh-models.js'
import { discoverMcpServers } from './mcp.js'
import { installCliUsageProjection } from './usage.js'
import { jobsFaceOf } from './job-mirror.js'
import { dshHomeOf, loadPersistedTasks, persistTask } from './persist.js'
import { StatusStore, crossSitePost, handleCliNpmJob, handleCliRefresh, handleCliVersions, handleHint, handleModels, handleOverview, handleTaskCancel, handleTaskDetail, handleTasks, fail, ok, type RouteDeps, type RouteOutcome } from './routes.js'
import {
  ROUTE_HINT, ROUTE_MODELS, ROUTE_OVERVIEW, ROUTE_CLI_INSTALL, ROUTE_CLI_REFRESH, ROUTE_CLI_UNINSTALL, ROUTE_CLI_VERSIONS, ROUTE_TASK_CANCEL, ROUTE_TASK_DETAIL, ROUTE_TASKS,
} from './wire.js'

export const name = 'dsh-maestro-codex'

export const inject = []

/** Largest accepted request body (bytes) — dispatch payloads are task text. */
const BODY_LIMIT = 256 * 1024

/** The settings namespace this plugin serves — the composition entry id, which
 * the browser half reads configForms by (the same string). */
export const MAESTRO_NS = 'dsh-maestro-codex'

/** Cordis resolves the composition entry's config through this schema before `apply` runs. */
export { Config, validateConfig } from './config.js'

/**
 * Plugin apply: validate config, build the shared dispatch deps, mount the
 * tool + system-prompt hint where those services exist, and register the HTTP
 * routes on any webServer that comes and goes.
 */
export function apply(ctx: Context, config: Config = {}): void {
  validateConfig(config)

  const readConfig = (): ReturnType<typeof effectiveOf> =>
    effectiveOf((ctx.fiber?.config as Config | undefined) ?? config)

  const registry = new TaskRegistry()
  const controllers = new Map<string, AbortController>()
  const limiter = new Limiter(() => readConfig().maxConcurrentTasks)
  const pathCache = new CliPathCache(readConfig)
  const statusStore = new StatusStore(readConfig)
  // Settled dispatch results land under $DSH_HOME/maestro/tasks; boot seeds the
  // newest batch back into the registry so the task board survives a restart.
  const dshHome = dshHomeOf()
  void loadPersistedTasks(dshHome)
    .then(records => { for (const record of records) registry.restore(record) })
    .catch(() => { /* history is best effort — boot never waits on it */ })

  let toolName = TOOL_NAME
  /**
   * Why the dispatch tool is absent, when it is. The routing hint reads this
   * so a failed registration can never leave the model advertising (and
   * calling) a tool the host does not have.
   */
  let toolRegistrationError: string | undefined
  /**
   * Host logger when the composition has one; stderr otherwise. A missing
   * dispatch tool must never fail silently again.
   */
  const log = (level: 'warn' | 'error', message: string): void => {
    try {
      const raw = (ctx as unknown as { logger?: unknown }).logger
      if (typeof raw === 'function') {
        const scoped = (raw as (name: string) => Record<string, unknown>)('dsh-maestro-codex')
        const fn = scoped?.[level]
        if (typeof fn === 'function') {
          (fn as (text: string) => void).call(scoped, message)
          return
        }
      } else if (raw !== null && typeof raw === 'object') {
        const fn = (raw as Record<string, unknown>)[level]
        if (typeof fn === 'function') {
          (fn as (text: string) => void).call(raw, message)
          return
        }
      }
    } catch { /* fall through to stderr */ }
    process.stderr.write(`[dsh-maestro-codex] ${level}: ${message}\n`)
  }
  const logger = { warn: (message: string) => log('warn', message), error: (message: string) => log('error', message) }
  // The host jobs service (dsh-jobs-local) mirrors dispatched runs into the
  // native task page; optional — absent, the tool falls back to bare dispatch.
  let jobsService: unknown
  ctx.inject(['jobs'], (jobsCtx) => {
    jobsService = (jobsCtx as unknown as { get(name: string): unknown }).get('jobs')
  })
  // The settings face arrives with the settings service; the dsh model catalog
  // and the CLI model resolver both read the composed llm-pi-ai providers
  // through it (baseURL / api / apiKeyEnv per provider route).
  let settingsFace: SettingsDescribeFace | undefined
  const deps: RouteDeps = {
    readConfig,
    registry,
    limiter,
    controllers,
    pathCache,
    statusStore,
    toolName: () => toolName,
    listDshModels: () => listDshModels(ctx, settingsFace),
    resolveDshModel: (selection: string) => resolveDshModelEndpoint(ctx, settingsFace, selection),
    listMcpServers: () => discoverMcpServers(),
    mcpDiagnosticsEnabled: () => readConfig().mcpDiagnostics,
    describeSettings: () => settingsFace?.describe() ?? [],
    persist: (task) => {
      if (readConfig().persistTasks === false) return
      void persistTask(dshHome, task)
    },
    jobs: () => jobsFaceOf(jobsService),
    logger,
  }

  // In dsh 0.1.7+, the settings service projects volatile Config fields into
  // forms. auto: false — this plugin provides its own dedicated configuration
  // card (via `plugins.bundle.config`).
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => {
      settingsFace = settingsCtx.settings as unknown as SettingsDescribeFace
      return settingsCtx.settings.configure({ auto: false }, ctx.fiber)
    }, 'maestro-codex: settings presentation policy')
  })

  ctx.inject(['webServer'], (webCtx) => {
    // Keep the CLI status snapshot warm; the card polls the cheap overview.
    webCtx.effect(() => {
      void statusStore.refresh()
      const timer = setInterval(() => { void statusStore.refresh() }, 45_000)
      return () => { clearInterval(timer) }
    }, 'maestro-codex: status refresh loop')

    const send = (res: ServerResponse, outcome: RouteOutcome): void => {
      res.writeHead(outcome.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(outcome.body))
    }

    const readJson = (req: IncomingMessage): Promise<unknown> => new Promise((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > BODY_LIMIT) {
          req.destroy()
          rejectPromise(new Error('request body too large'))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (chunks.length === 0) {
          resolvePromise({})
          return
        }
        try {
          resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          rejectPromise(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`))
        }
      })
      req.on('error', rejectPromise)
    })

    /** One exact route with in-handler method dispatch. */
    const route = (path: string, label: string, handle: (req: IncomingMessage, body: unknown) => Promise<RouteOutcome> | RouteOutcome): void => {
      webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path, handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          // The routes have no auth; a cross-site page must not be able to
          // drive install/uninstall/cancel against the local host.
          if (req.method !== 'GET' && req.method !== 'HEAD' && crossSitePost({ origin: req.headers.origin, host: req.headers.host })) {
            send(res, fail(403, 'cross-origin request rejected'))
            return
          }
          const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readJson(req)
          send(res, await handle(req, body))
        } catch (error) {
          send(res, fail(400, error instanceof Error ? error.message : String(error)))
        }
      } }), `maestro-codex: ${label} route`)
    }

    route(ROUTE_OVERVIEW, 'overview', () => handleOverview(deps))
    route(ROUTE_TASKS, 'tasks', (req) => handleTasks(deps, new URL(req.url ?? '/', 'http://x').searchParams))
    route(ROUTE_TASK_DETAIL, 'task-detail', (req) => handleTaskDetail(deps, new URL(req.url ?? '/', 'http://x').searchParams))
    route(ROUTE_TASK_CANCEL, 'task-cancel', (_req, body) => handleTaskCancel(deps, body))
    route(ROUTE_CLI_REFRESH, 'cli-refresh', async (_req, body) => handleCliRefresh(deps, body))
    route(ROUTE_CLI_VERSIONS, 'cli-versions', (req) => handleCliVersions(deps, new URL(req.url ?? '/', 'http://x').searchParams))
    route(ROUTE_CLI_INSTALL, 'cli-install', (_req, body) => handleCliNpmJob(deps, 'install', body))
    route(ROUTE_CLI_UNINSTALL, 'cli-uninstall', (_req, body) => handleCliNpmJob(deps, 'uninstall', body))
    route(ROUTE_HINT, 'hint', () => handleHint(deps))
    route(ROUTE_MODELS, 'models', () => handleModels(deps))
  })

  // The dispatch tool: the conversation model's primary entry. Deferred on
  // purpose — a host without the tools service (headless, sdk) keeps every
  // other feature and simply gets no dispatch tool. A registration failure is
  // recorded (and logged) so the routing hint stops advertising the tool.
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      try {
        const registered = registerDispatchTool(toolCtx, deps)
        toolName = registered.name
        toolRegistrationError = undefined
        return () => {
          registered.dispose()
          toolName = TOOL_NAME
          toolRegistrationError = undefined
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        toolRegistrationError = message
        log('error', `dispatch tool "${TOOL_NAME}" failed to register: ${message}`)
        return () => { toolRegistrationError = undefined }
      }
    }, 'maestro-codex: dispatch tool')
  })

  // A few lines of routing table per request, so the model knows when to call
  // the tool and which CLI it names. Optional: hosts without the system-prompt
  // service boot unchanged. When the tool is absent, the hint says so instead
  // of describing a tool the model cannot call.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () => (promptCtx as unknown as { systemPrompt: { context(contribution: { name: string; order: number; text: () => string }): () => void } }).systemPrompt.context({
        name: 'dsh-maestro-codex:routing',
        order: 61,
        text: () => routingHint(readConfig(), toolName, toolRegistrationError),
      }),
      'maestro-codex: routing hint',
    )
  })

  // CLI usage reaches dsh through this plugin's own session projection
  // (`maestroCliUsage`): the host's built-in `tokenUsage` only counts this
  // process's own provider calls, so CLI subagent spend was invisible to every
  // plugin that reads usage. Deferred on the registry — a host without the
  // seam keeps working, and the board still shows the per-task stats.
  ;(ctx as unknown as { inject(deps: readonly string[], callback: (inner: Context) => void): void })
    .inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.effect(() => {
        const dispose = installCliUsageProjection(projectionCtx)
        if (dispose === undefined) {
          log('warn', 'session projection registry rejected the CLI usage projection — CLI usage stays in the task board only')
          return () => {}
        }
        return dispose
      }, 'maestro-codex: cli usage projection')
    })
}
