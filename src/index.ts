/**
 * dsh-maestro-codex host half. Wires the dispatch tool, the routing hint, and
 * the HTTP surface onto the host context; config edits persist into the
 * profile patch and take effect live (every dispatch re-reads the config).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
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
import { readJsonBody, sendBodyFailure } from './request-body.js'
import { listDshModels, resolveDshModelEndpoint, type DshModelEndpoint, type SettingsDescribeFace } from './dsh-models.js'
import { preflightDshModel as runPreflight } from './preflight.js'
import { discoverMcpServers } from './mcp.js'
import { createBridgeHandle, type BridgeHandle, type SkillsFace, type ToolsFace } from './bridge.js'
import { SessionAccessRegistry, installSessionAccessProjection } from './session-access.js'
import { CLI_ACCESS_HEADER } from './wire.js'
import { installCliUsageProjection, flushPendingCliUsage, clearCliUsageMirrors } from './usage.js'
import { UsageJournal } from './usage-journal.js'
import { installAccountingService, type NativeRecoveryDiagnostics } from './accounting-service.js'
import { installCliRecordGuard } from './record-guard.js'
import { probeHostCapabilities } from './host-capabilities.js'
import { installCliRecordProjection, ownsCliRecordSession } from './cli-record-projection.js'
import { NativeRecovery, type NativeRecoveryPersistence, type NativeRecoveryQuery, type NativeRecoveryResult, type NativeRecoveryStore } from './native-recovery.js'
import { createChildSessionRecorder, type ChildSessionStoreFace } from './child-session.js'
import { CliSessionRecoveryGate, replayCliSessions, type ReplayListedSession } from './replay.js'
import { dshHomeOf, loadPersistedTasks, persistTask } from './persist.js'
import { EffectQueue, FAILURES_BEFORE_ERROR } from './effects.js'
import { DedupeGuard } from './dedupe.js'
import { HealthBoard } from './health.js'
import { ConfigHistory } from './config-history.js'
import { PromptBook } from './prompts.js'
import { restoreInterrupted } from './recovery.js'
import { BRIDGE_ACCESS_HEADER } from './wire.js'
import { bridgeCatalogRequestQuery, bridgeCallRequestBody } from './routes.js'
import { StatusStore, crossSitePost, handleBridgeCall, handleBridgeCatalog, handleCliNpmJob, handleCliRefresh, handleCliVersions, handleConfigHistory, handleHealth, handleHint, handleModels, handleOverview, handlePrompts, handlePromptsSave, handleStatus, handleTaskCancel, handleTaskDetail, handleTaskReply, handleTasks, fail, ok, type RouteDeps, type RouteOutcome } from './routes.js'
import {
  ROUTE_BRIDGE_CALL, ROUTE_BRIDGE_CATALOG, ROUTE_CONFIG_HISTORY, ROUTE_HEALTH, ROUTE_HINT, ROUTE_MODELS, ROUTE_OVERVIEW, ROUTE_CLI_INSTALL, ROUTE_CLI_REFRESH, ROUTE_CLI_UNINSTALL, ROUTE_CLI_VERSIONS, ROUTE_PROMPTS, ROUTE_PROMPTS_SAVE, ROUTE_STATUS, ROUTE_TASK_CANCEL, ROUTE_TASK_DETAIL, ROUTE_TASK_REPLY, ROUTE_TASKS,
} from './wire.js'

export const name = 'dsh-maestro-codex'
export { ACCOUNTING_SERVICE } from './accounting-service.js'
export type { AccountingSnapshot, MaestroCliAccountingService, NativeRecoveryDiagnostics } from './accounting-service.js'
export type { CliUsageRecord, CliUsageState } from './usage.js'

export const inject = []

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
  const stateDir = join(dshHome, 'maestro')

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

  // ---- 可靠性面（P0/P1）----------------------------------------------------
  // 健康板：每个子系统自己认领自己的条目，面板只读；健康态不占面板空间。
  const health = new HealthBoard()
  // 副作用队列：唯一记录"派发开始了但没结算"的地方，重启恢复靠它。
  const effects = new EffectQueue({
    file: join(stateDir, 'effects.json'),
    onWarn: message => logger.warn(message),
    onGiveUp: row => {
      effectsHealth.set('error', `${row.kind} ${row.key} 连续失败 ${String(FAILURES_BEFORE_ERROR)} 次：${row.error ?? '原因未知'}`)
    },
  })
  const effectsHealth = health.claim('effects')
  // 幂等窗口：同一父会话重复派发同一件事只启动一次。
  const dedupe = new DedupeGuard()
  const dispatchHealth = health.claim('dispatch')
  health.claim('persist')
  health.claim('spawn')
  health.claim('bridge')
  health.claim('native-mirror')
  health.claim('preflight')
  // 配置历史（P2-1）：配置变化留快照与差异，面板看得出来"谁把并发改成了 8"。
  const configHistory = new ConfigHistory({ file: join(stateDir, 'config-history.json'), onWarn: message => logger.warn(message) })
  // 提示模板（P2-2）：三条可编辑片段，默认变了会标 stale。
  const prompts = new PromptBook({ file: join(stateDir, 'prompts.json'), onWarn: message => logger.warn(message) })

  // 启动恢复顺序：先读持久化历史（终态任务），再读副作用队列（没跑完的），
  // 后者标成 interrupted 并清账——同一份历史不会在下次启动时重放。
  void loadPersistedTasks(dshHome)
    .then(async records => {
      for (const record of records) registry.restore(record)
      await effects.load()
      await prompts.load()
      await configHistory.load()
      configHistory.record(readConfig())
      const restored = restoreInterrupted(registry, effects.dead('launch').concat(effects.pending('launch')))
      for (const id of restored) await effects.settle('launch', id)
      if (restored.length > 0) logger.warn(`上次退出时有 ${String(restored.length)} 个任务没跑完，已标记为 interrupted`)
    })
    .catch(() => { /* history is best effort — boot never waits on it */ })
  // The settings face arrives with the settings service; the dsh model catalog
  // and the CLI model resolver both read the composed llm-pi-ai providers
  // through it (baseURL / api / apiKeyEnv per provider route).
  let settingsFace: SettingsDescribeFace | undefined
  // The skills face arrives with dsh's skill registry; the bridge reads skill
  // summaries and bodies through it. Deferred like every other service — a host
  // without the registry simply runs unbridged.
  let skillsFace: SkillsFace | undefined
  // Same story for the tools registry — the bridge reads schemas and executes
  // allowlisted host tools through it.
  let toolsFace: ToolsFace | undefined
  let agentsFace: { get(id: string): import('./tool.js').ToolExec['agent'] } | undefined
  // The webServer's port lands with the HTTP surface; until then the bridge has
  // nowhere to call back to and stays dormant (runServerEntry → undefined).
  let bridgePort = 0
  // The host session store arrives with the sessions service; until then (or on
  // hosts without it) dispatches record no native child sessions.
  let sessionsFace: ChildSessionStoreFace | undefined
  let projectionHost: unknown
  let projectionFace: unknown
  let queryFace: NativeRecoveryQuery | undefined
  let persistenceFace: NativeRecoveryPersistence | undefined
  let nativeBindingVersion = 0
  // Diagnostics only: the webServer face (port) and the systemPrompt face are
  // probed for the capability report, never used as authority.
  let webServerFace: unknown
  let systemPromptFace: unknown
  const bridge: BridgeHandle = createBridgeHandle({
    skills: () => skillsFace,
    tools: () => toolsFace,
    portOf: () => bridgePort,
    readConfig,
    logger,
  })
  const sessionAccess = new SessionAccessRegistry()
  const usageJournal = new UsageJournal(dshHome)
  const recoveryCache = new Map<string, { owner: string; version: number; session: unknown; checkedAt: number; result: NativeRecoveryResult }>()
  const recoveryRunning = new Map<string, Promise<void>>()
  const recoveryGate = new CliSessionRecoveryGate()
  const nativeRecovery = new NativeRecovery({
    store: () => sessionsFace as unknown as NativeRecoveryStore | undefined,
    projections: () => projectionHost,
    query: () => queryFace,
    persistence: () => persistenceFace,
    bindingVersion: () => nativeBindingVersion,
    isNotFound: error => typeof error === 'object' && error !== null
      && (error as { code?: unknown }).code === 'SESSION_QUERY_SESSION_NOT_FOUND',
  })
  void usageJournal.load().then(() => {
    const health = usageJournal.status()
    if (health.corrupt !== 0 || health.incomplete !== 0) log('warn', `usage journal requires recovery: incomplete=${String(health.incomplete)}, corrupt=${String(health.corrupt)}; unknown usage is not zero`)
  }).catch(() => log('error', 'usage journal unavailable; new CLI calls cannot launch without an accounting marker'))
  const publishUsage = async (session: unknown, sessionId: string): Promise<void> => {
    await usageJournal.publish(session, sessionId)
  }
  const recoverNativeMirrors = (owner: string): Promise<void> => {
    const running = recoveryRunning.get(owner)
    if (running !== undefined) return running
    const job = recoveryGate.run(owner, async () => {
      await usageJournal.refresh()
      for (const record of usageJournal.recordsFor(owner)) {
        const key = JSON.stringify([owner, record.source, record.taskId, record.startedAt])
        const session = record.childSessionId === undefined ? undefined : sessionsFace?.get?.(record.childSessionId)
        const old = recoveryCache.get(key)
        if (old?.version === nativeBindingVersion && old.session === session
          && ((old.result.status === 'recovered' || old.result.status === 'already-present') || Date.now() - old.checkedAt < 30_000)) continue
        const version = nativeBindingVersion
        const result = await nativeRecovery.recover(record)
        if (version !== nativeBindingVersion) continue
        const current = record.childSessionId === undefined ? undefined : sessionsFace?.get?.(record.childSessionId)
        recoveryCache.set(key, { owner, version, session: current, checkedAt: Date.now(), result })
      }
    })
    recoveryRunning.set(owner, job)
    void job.finally(() => { if (recoveryRunning.get(owner) === job) recoveryRunning.delete(owner) }).catch(() => {})
    return job
  }
  const recoveryDiagnostics = (owner: string): NativeRecoveryDiagnostics => {
    const rows = [...recoveryCache.values()].filter(row => row.owner === owner && row.version === nativeBindingVersion)
    return {
      source: 'sdk-count-observation-recovery',
      observedRecords: rows.filter(row => row.result.nativeUsageAccepted === true).length,
      ownedWriterBarriers: rows.filter(row => row.result.nativeWriteFlushed === true).length,
      skippedRecords: rows.filter(row => row.result.status === 'skipped').length,
      failedRecords: rows.filter(row => row.result.status === 'failed').length,
      pendingRecords: Math.max(0, usageJournal.recordsFor(owner).length - rows.length),
      standardProjectionVerification: 'not-performed',
      reasons: [...new Set(rows.filter(row => row.result.status === 'skipped' || row.result.status === 'failed').map(row => row.result.reason))],
    }
  }
  ctx.effect(() => {
    const dispose = installCliRecordGuard(ctx, (session) => {
      if (typeof session !== 'object' || session === null) return false
      const value = session as { id?: unknown; header?: { parentSession?: unknown } }
      if (typeof value.id !== 'string' || !value.id.startsWith('cli-') || typeof value.header?.parentSession !== 'string') return false
      const task = registry.get(value.id.slice(4))
      return (task?.kind === 'cli' && task.sessionId === value.header.parentSession)
        || usageJournal.ownsChildSession(value.id, value.header.parentSession)
        || ownsCliRecordSession(projectionHost, session)
    })
    if (dispose === undefined) log('warn', 'CLI record pre-step protection unavailable; do not assume direct Agent API execution is blocked')
    return () => { dispose?.() }
  }, 'maestro-codex: CLI record execution veto')
  ctx.effect(() => {
    const dispose = installAccountingService(ctx, usageJournal, sessionAccess, recoveryDiagnostics)
    if (dispose === undefined) log('warn', 'public accounting service unavailable on this host; canonical journal remains intact')
    return () => { dispose?.() }
  }, 'maestro-codex: public canonical accounting service')
  ctx.effect(() => () => { sessionAccess.clear(); clearCliUsageMirrors() }, 'maestro-codex: session capability cleanup')
  const deps: RouteDeps = {
    readConfig,
    beginUsage: task => usageJournal.begin(task),
    settleUsage: async (task, session) => {
      await usageJournal.settle(task)
      task.stats = { ...task.stats, accountingState: 'canonical-stored' }
      if (task.sessionId !== undefined) {
        const target = session ?? sessionsFace?.get?.(task.sessionId)
        try {
          await publishUsage(target, task.sessionId)
          task.stats = { ...task.stats, accountingState: target === undefined ? 'canonical-stored-host-unavailable' : 'canonical-stored-host-checkpoint-unconfirmed' }
        } catch (error) {
          task.stats = { ...task.stats, accountingState: 'canonical-stored-host-replay-pending' }
          throw error
        }
      }
    },
    ensureSessionAccess: (sessionId, session) => { sessionAccess.publish(sessionId, session) },
    registry,
    limiter,
    controllers,
    pathCache,
    statusStore,
    toolName: () => toolName,
    listDshModels: () => listDshModels(ctx, settingsFace),
    resolveDshModel: (selection: string, cli: 'claude' | 'codex' | 'grok') => resolveDshModelEndpoint(ctx, settingsFace, selection, cli),
    // Second half of the pre-spawn check: the protocol is already known to fit,
    // so confirm this endpoint actually serves the selected model name.
    preflightDshModel: async (endpoint: DshModelEndpoint, cli, signal) => {
      signal?.throwIfAborted()
      const catalog = await listDshModels(ctx, settingsFace)
      signal?.throwIfAborted()
      const declared = catalog.providers.find(provider => provider.id === endpoint.provider)?.models ?? []
      return runPreflight(endpoint, declared, { cli, signal })
    },
    listMcpServers: () => discoverMcpServers(),
    bridge,
    childSessions: createChildSessionRecorder({ store: () => sessionsFace, readConfig, logger }),
    // 会话页回复与工具派发同一条记账通道：解析派发会话（父会话）的 append 面。
    parentSessionOf: (sessionId) => sessionsFace?.get?.(sessionId),
    parentAgentOf: (sessionId) => {
      try {
        const agent = agentsFace?.get(sessionId)
        return agent?.id === sessionId ? agent : undefined
      } catch { return undefined }
    },
    mcpDiagnosticsEnabled: () => readConfig().mcpDiagnostics,
    describeSettings: () => settingsFace?.describe() ?? [],
    hostCapabilities: () => probeHostCapabilities({
      settings: settingsFace,
      skills: skillsFace,
      agents: agentsFace,
      sessions: sessionsFace,
      sessionQuery: queryFace,
      sessionPersistence: persistenceFace,
      sessionProjections: projectionFace,
      tools: toolsFace,
      systemPrompt: systemPromptFace,
      webServer: webServerFace,
    }),
    persist: (task) => {
      if (readConfig().persistTasks === false) return
      void persistTask(dshHome, task)
    },
    effects,
    dedupe,
    health: dispatchHealth,
    healthBoard: health,
    prompts,
    configHistory,
    prepareCommand: () => readConfig().prepareCommand,
    protocolLine: () => prompts.text('resultProtocol'),
    replyPrefix: () => prompts.text('replyPrefix'),
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

  // The bridge reads skills through dsh's registry; absent = dispatches run
  // unbridged (the routing hint and config keep working).
  ;(ctx as unknown as { inject(deps: readonly string[], callback: (inner: Context) => void): void })
    .inject(['skills'], (skillsCtx) => {
      skillsCtx.effect(() => {
        skillsFace = (skillsCtx as unknown as { skills: SkillsFace | undefined }).skills
        return () => { skillsFace = undefined }
      }, 'maestro-codex: skills face')
    })

  ;(ctx as unknown as { inject(deps: readonly string[], callback: (inner: Context) => void): void })
    .inject(['agents'], (agentCtx) => {
      agentCtx.effect(() => {
        const candidate = (agentCtx as unknown as { agents?: { get?: unknown } }).agents
        agentsFace = typeof candidate?.get === 'function' ? candidate as { get(id: string): import('./tool.js').ToolExec['agent'] } : undefined
        return () => { agentsFace = undefined }
      }, 'maestro-codex: public live agent registry')
    })

  // The host session store: native record sessions for dispatched CLI runs
  // (see `child-session.ts`). Absent = dispatches keep working without them.
  ;(ctx as unknown as { inject(deps: readonly string[], callback: (inner: Context) => void): void })
    .inject(['sessions'], (sessionCtx) => {
      sessionCtx.effect(() => {
        const candidate = (sessionCtx as unknown as { sessions?: Partial<ChildSessionStoreFace> | undefined }).sessions
        sessionsFace = typeof candidate?.create === 'function' ? candidate as ChildSessionStoreFace : undefined
        nativeBindingVersion++
        if (sessionsFace === undefined) log('warn', 'host session store unusable — CLI dispatches record no native child sessions')
        const refreshSessions = (): void => {
          const list = (sessionsFace as unknown as { list?(): readonly { id: string; append(type: string, data: unknown): unknown }[] } | undefined)?.list?.() ?? []
          for (const session of list) {
            if (session.id.startsWith('cli-')) continue
            try {
              sessionAccess.publish(session.id, session)
              flushPendingCliUsage(session, session.id)
              void publishUsage(session, session.id).catch(() => log('warn', 'usage replay awaits a usable host checkpoint; canonical records retained'))
              void recoverNativeMirrors(session.id).catch(() => log('warn', 'native mirror recovery pending; canonical counters retained'))
            } catch { /* fail closed, retry when live */ }
          }
          deps.childSessions?.flushPending?.()
        }
        refreshSessions()
        const timer = setInterval(refreshSessions, 2500)
        return () => { clearInterval(timer); sessionsFace = undefined; sessionAccess.clear(); nativeBindingVersion++; recoveryCache.clear() }
      }, 'maestro-codex: sessions face')
    })

  // Replay only gaps left by canonical NativeRecovery. Durable child IDs own
  // their immutable headers and must never be recreated from journal metadata.
  // Scope is bounded by the workspace registry: skip archived parents, at most
  // 30 per project, newest activity first. The delay reduces startup work; the
  // per-parent recovery barrier (not this timer) prevents concurrent recovery.
  ;(ctx as unknown as { inject(deps: readonly string[], callback: (inner: Context) => void): void })
    .inject(['sessions', 'sessionPersistence'], (replayCtx) => {
      replayCtx.effect(() => {
        const store = (replayCtx as unknown as { sessions?: Partial<ChildSessionStoreFace> }).sessions
        const persistence = (replayCtx as unknown as {
          sessionPersistence?: { list?: (options?: unknown) => Promise<readonly ReplayListedSession[]> }
        }).sessionPersistence
        if (typeof store?.create !== 'function' || typeof persistence?.list !== 'function') return () => {}
        const controller = new AbortController()
        const timer = setTimeout(() => {
          void replayCliSessions({
            store: store as ChildSessionStoreFace,
            journal: usageJournal,
            persistence: { list: () => persistence.list!() },
            dshHome,
            readConfig,
            log,
            prepareParent: recoverNativeMirrors,
            withParent: (owner, publish) => recoveryGate.run(owner, publish),
          }, { signal: controller.signal }).catch(error => log('warn', `子会话重放跳过：${String(error)}`))
        }, 4_000)
        return () => { controller.abort(); clearTimeout(timer) }
      }, 'maestro-codex: child session replay')
    })

  ;(ctx as unknown as { inject(deps: readonly string[], callback: (inner: Context) => void): void })
    .inject(['sessionQuery'], (queryCtx) => {
      queryCtx.effect(() => {
        const candidate = (queryCtx as unknown as { sessionQuery?: NativeRecoveryQuery }).sessionQuery
        queryFace = typeof candidate?.readSession === 'function' ? candidate : undefined
        nativeBindingVersion++
        return () => { queryFace = undefined; nativeBindingVersion++; recoveryCache.clear() }
      }, 'maestro-codex: public session query binding')
    })
  ;(ctx as unknown as { inject(deps: readonly string[], callback: (inner: Context) => void): void })
    .inject(['sessionPersistence'], (persistenceCtx) => {
      persistenceCtx.effect(() => {
        const candidate = (persistenceCtx as unknown as { sessionPersistence?: NativeRecoveryPersistence }).sessionPersistence
        persistenceFace = typeof candidate?.identity === 'symbol' && typeof candidate.create === 'function' && typeof candidate.open === 'function' ? candidate : undefined
        nativeBindingVersion++
        return () => { persistenceFace = undefined; nativeBindingVersion++; recoveryCache.clear() }
      }, 'maestro-codex: public persistence ownership binding')
    })

  ctx.inject(['webServer'], (webCtx) => {
    // The bridge shim calls back over this HTTP surface; remember the port for
    // as long as the webServer (and its effect) lives.
    webCtx.effect(() => {
      bridgePort = (webCtx.webServer as unknown as { port: number }).port
      webServerFace = webCtx.webServer
      return () => { bridgePort = 0; webServerFace = undefined }
    }, 'maestro-codex: bridge port')

    // Keep the CLI status snapshot warm; the card polls the cheap overview.
    // 同一轮也顺手记一次配置快照：变了才落盘（ConfigHistory 自己 debounce）。
    webCtx.effect(() => {
      const recordConfig = (): void => { void configHistory.record(readConfig()) }
      void statusStore.refresh()
      recordConfig()
      const timer = setInterval(() => {
        void statusStore.refresh()
        recordConfig()
      }, 45_000)
      return () => { clearInterval(timer); statusStore.invalidate() }
    }, 'maestro-codex: status refresh loop')

    const send = (res: ServerResponse, outcome: RouteOutcome): void => {
      res.writeHead(outcome.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(outcome.body))
    }

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
          const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readJsonBody(req)
          send(res, await handle(req, body))
        } catch (error) {
          sendBodyFailure(req, res, error)
        }
      } }), `maestro-codex: ${label} route`)
    }

    route(ROUTE_OVERVIEW, 'overview', () => handleOverview(deps))
    route(ROUTE_TASKS, 'tasks', (req) => handleTasks(deps, new URL(req.url ?? '/', 'http://x').searchParams, sessionAccess.authorize(req.headers[CLI_ACCESS_HEADER])))
    route(ROUTE_TASK_DETAIL, 'task-detail', (req) => handleTaskDetail(deps, new URL(req.url ?? '/', 'http://x').searchParams, sessionAccess.authorize(req.headers[CLI_ACCESS_HEADER])))
    route(ROUTE_TASK_CANCEL, 'task-cancel', (req, body) => handleTaskCancel(deps, body, sessionAccess.authorize(req.headers[CLI_ACCESS_HEADER])))
    route(ROUTE_TASK_REPLY, 'task-reply', (req, body) => handleTaskReply(deps, body, sessionAccess.authorize(req.headers[CLI_ACCESS_HEADER])))
    route(ROUTE_BRIDGE_CATALOG, 'bridge-catalog', (req) => handleBridgeCatalog(deps, bridgeCatalogRequestQuery(new URL(req.url ?? '/', 'http://x').searchParams, req.headers[BRIDGE_ACCESS_HEADER])))
    route(ROUTE_BRIDGE_CALL, 'bridge-call', (req, body) => handleBridgeCall(deps, bridgeCallRequestBody(body, req.headers[BRIDGE_ACCESS_HEADER])))
    route(ROUTE_CLI_REFRESH, 'cli-refresh', async (_req, body) => handleCliRefresh(deps, body))
    route(ROUTE_CLI_VERSIONS, 'cli-versions', (req) => handleCliVersions(deps, new URL(req.url ?? '/', 'http://x').searchParams))
    route(ROUTE_CLI_INSTALL, 'cli-install', (_req, body) => handleCliNpmJob(deps, 'install', body))
    route(ROUTE_CLI_UNINSTALL, 'cli-uninstall', (_req, body) => handleCliNpmJob(deps, 'uninstall', body))
    route(ROUTE_HINT, 'hint', () => handleHint(deps))
    route(ROUTE_MODELS, 'models', () => handleModels(deps))
    route(ROUTE_HEALTH, 'health', () => handleHealth(deps))
    route(ROUTE_STATUS, 'status', () => handleStatus(deps))
    route(ROUTE_PROMPTS, 'prompts', () => handlePrompts(deps))
    route(ROUTE_PROMPTS_SAVE, 'prompts-save', async (_req, body) => await handlePromptsSave(deps, body))
    route(ROUTE_CONFIG_HISTORY, 'config-history', () => handleConfigHistory(deps))
  })

  // The dispatch tool: the conversation model's primary entry. Deferred on
  // purpose — a host without the tools service (headless, sdk) keeps every
  // other feature and simply gets no dispatch tool. A registration failure is
  // recorded (and logged) so the routing hint stops advertising the tool.
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      // Capture the registry face for the bridge before anything can fail below.
      toolsFace = (toolCtx as unknown as { tools: ToolsFace | undefined }).tools
      try {
        const registered = registerDispatchTool(toolCtx, deps)
        toolName = registered.name
        toolRegistrationError = undefined
        return () => {
          registered.dispose()
          toolName = TOOL_NAME
          toolRegistrationError = undefined
          toolsFace = undefined
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        toolRegistrationError = message
        log('error', `dispatch tool "${TOOL_NAME}" failed to register: ${message}`)
        return () => { toolRegistrationError = undefined; toolsFace = undefined }
      }
    }, 'maestro-codex: dispatch tool')
  })

  // A few lines of routing table per request, so the model knows when to call
  // the tool and which CLI it names. Optional: hosts without the system-prompt
  // service boot unchanged. When the tool is absent, the hint says so instead
  // of describing a tool the model cannot call.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () => {
        systemPromptFace = (promptCtx as unknown as { systemPrompt?: unknown }).systemPrompt
        const registered = (promptCtx as unknown as { systemPrompt: { context(contribution: { name: string; order: number; text: () => string }): () => void } }).systemPrompt.context({
          name: 'dsh-maestro-codex:routing',
          order: 61,
          text: () => {
            const base = routingHint(readConfig(), toolName, toolRegistrationError)
            // 团队附加说明（`/prompts` 可改）接在后面：出厂为空，所以默认输出
            // 仍与 `routing.ts` 完全一致，没有第二份措辞要同步。
            const extra = prompts.text('routingHint').trim()
            return extra === '' ? base : `${base}\n${extra}`
          },
        })
        return () => { registered(); systemPromptFace = undefined }
      },
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
        let face: unknown
        try { face = (projectionCtx as unknown as { sessionProjections?: unknown }).sessionProjections }
        catch { log('warn', 'session projection registry getter rejected; optional projections remain unavailable') }
        // Read the optional getter once and give every installer the same face.
        // Retain the host method receiver through the captured service object.
        const installedHost = { sessionProjections: face }
        projectionHost = installedHost
        projectionFace = face
        nativeBindingVersion++
        recoveryCache.clear()
        const install = (installer: () => (() => void) | undefined, warning: string): (() => void) | undefined => {
          try {
            const disposer = installer()
            if (disposer === undefined) log('warn', warning)
            return disposer
          } catch { log('warn', warning); return undefined }
        }
        const recordDispose = install(() => installCliRecordProjection(installedHost),
          'native CLI identity projection unavailable; no positive mirror verification assumed')
        const accessDispose = install(() => installSessionAccessProjection(installedHost, sessionAccess),
          'session-access projection unavailable; scoped task requests remain fail-closed')
        const usageDispose = install(() => installCliUsageProjection(installedHost, sessionId => usageJournal.recordsFor(sessionId)),
          'CLI usage projection unavailable; canonical public accounting service remains authoritative')
        let released = false
        return () => {
          if (released) return
          released = true
          for (const disposer of [accessDispose, usageDispose, recordDispose]) {
            try {
              if (disposer !== undefined) void Promise.resolve(disposer()).catch(() => log('warn', 'optional session projection disposer rejected'))
            } catch { log('warn', 'optional session projection disposer rejected') }
          }
          // An old injection may finish unloading after its replacement starts.
          if (projectionHost === installedHost) {
            projectionHost = undefined
            projectionFace = undefined
            nativeBindingVersion++
            recoveryCache.clear()
          }
        }
      }, 'maestro-codex: cli usage projection')
    })
}
