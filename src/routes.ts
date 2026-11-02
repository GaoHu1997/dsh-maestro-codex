/**
 * Route handlers for the plugin's HTTP surface (`/plugin/dsh-maestro-codex/*`).
 * Every handler is a pure `deps → body → outcome` function so tests can drive
 * them without a host; the apply layer binds them to the webServer.
 */

import { randomUUID } from 'node:crypto'
import { modelTokenError, redactEffective, type EffectiveConfig } from './config.js'
import { runDispatch, type DispatchDeps } from './dispatch.js'
import type { CliUsageSession } from './usage.js'
import type { ToolExec } from './tool.js'
import { detectCli, queryPackageVersions, runNpmJob } from './cli-manager.js'
import { isTerminalPhase, type MaestroTask } from './task-registry.js'
import { routingHint } from './routing.js'
import { readPackageVersion } from './host-capabilities.js'
import { dshModelSelectionError, type DshModelCatalog } from './dsh-models.js'
import type { DshMcpServer } from './mcp.js'
import type { HostCapabilityReport } from './wire.js'
import { CLI_PACKAGES, CLI_LABELS, MAESTRO_CLI_IDS, type MaestroCliId, type MaestroCliStatus, type MaestroCliVersions, type MaestroOverview, type MaestroRouteError, type MaestroStage, type MaestroTaskDetail, type MaestroTaskRef, type MaestroTaskSummary } from './wire.js'
import type { ConfigHistory } from './config-history.js'
import type { HealthBoard } from './health.js'
import { PROMPT_FRAGMENTS, PROMPT_CAP, type PromptBook, type PromptId } from './prompts.js'
import { needsPerson } from './stage.js'

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

/**
 * Whether a mutating request carries a cross-site `Origin`: browsers attach it
 * to every cross-origin POST, and the plugin routes have no auth — without
 * this check any web page could drive install/uninstall/cancel against the
 * local host. No Origin (curl, host-internal fetch) cannot be judged and is
 * allowed through; a malformed Origin is rejected.
 */
export function crossSitePost(headers: { origin?: string | undefined; host?: string | undefined }): boolean {
  const origin = headers.origin?.trim() ?? ''
  if (origin === '') return false
  const host = headers.host?.trim() ?? ''
  if (host === '') return false
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return true
  }
  return originHost !== host
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
  /**
   * Resolve a LIVE session's append face by id — the reply route uses it so a
   * session-page reply reports usage into the same channels a tool dispatch
   * does (parent projection + native record session). undefined = not live.
   */
  parentSessionOf?: ((sessionId: string) => CliUsageSession | undefined) | undefined
  /** Public AgentRegistry.get, resolved only AFTER task/principal ownership.
   * Missing live agent is allowed for CLI-only continuation, never synthesized. */
  parentAgentOf?: ((sessionId: string) => ToolExec['agent']) | undefined
  /** Diagnostics switch (query `?diag=1` era — enabled via config for now). */
  mcpDiagnosticsEnabled?: (() => boolean) | undefined
  /** The raw composed-settings describe (diagnostics only). */
  describeSettings?: () => Array<{ ns: string; value?: unknown }>
  /** Public host interfaces this build resolved, for release-mismatch diagnosis. */
  hostCapabilities?: (() => HostCapabilityReport) | undefined
  /** 整块健康板（P1-1）：面板与 `maestro status` 的读面。 */
  healthBoard?: HealthBoard | undefined
  /** 提示模板（P2-2）。 */
  prompts?: PromptBook | undefined
  /** 配置历史（P2-1）。 */
  configHistory?: ConfigHistory | undefined
  /** 续接消息前缀（P2-2）：出厂为空，团队设了才拼到人写的内容前面。 */
  replyPrefix?: (() => string) | undefined
}

/** Snapshot reads stay cheap; each CLI publishes as soon as its own probe ends. */
export class StatusStore {
  private snapshot: Record<MaestroCliId, MaestroCliStatus> = {
    claude: { installed: false, version: '', path: '', checking: true },
    codex: { installed: false, version: '', path: '', checking: true },
  }
  private readonly refreshing = new Map<MaestroCliId, { override: string; controller: AbortController; promise: Promise<void> }>()
  private readonly overrides = new Map<MaestroCliId, string>()

  constructor(private readonly readConfig: () => EffectiveConfig, private readonly detect: typeof detectCli = detectCli) {}

  /** A copy — callers never mutate the store's internal snapshot. */
  get(): Record<MaestroCliId, MaestroCliStatus> {
    return { claude: { ...this.snapshot.claude }, codex: { ...this.snapshot.codex } }
  }

  set(cli: MaestroCliId, status: MaestroCliStatus): void {
    this.invalidate(cli)
    this.overrides.set(cli, this.readConfig()[cli].cliPath.trim())
    this.snapshot = { ...this.snapshot, [cli]: { ...status } }
  }

  setAll(next: Record<MaestroCliId, MaestroCliStatus>): void {
    for (const cli of MAESTRO_CLI_IDS) this.set(cli, next[cli])
  }

  /** npm changed the filesystem: never reuse an install's pre-change probe. */
  invalidate(cli?: MaestroCliId): void {
    for (const id of cli === undefined ? MAESTRO_CLI_IDS : [cli]) {
      const entry = this.refreshing.get(id)
      this.refreshing.delete(id)
      entry?.controller.abort()
    }
  }

  async refresh(cli?: MaestroCliId): Promise<void> {
    await Promise.all((cli === undefined ? MAESTRO_CLI_IDS : [cli]).map(id => this.refreshOne(id)))
  }

  private refreshOne(cli: MaestroCliId): Promise<void> {
    const override = this.readConfig()[cli].cliPath.trim()
    const previous = this.refreshing.get(cli)
    if (previous?.override === override) return previous.promise
    if (previous !== undefined) this.invalidate(cli)
    const status = this.overrides.get(cli) === override
      ? this.snapshot[cli]
      : { installed: false, version: '', path: '' }
    this.overrides.set(cli, override)
    this.snapshot = { ...this.snapshot, [cli]: { ...status, checking: true } }
    const entry = { override, controller: new AbortController(), promise: Promise.resolve() }
    this.refreshing.set(cli, entry)
    entry.promise = (async () => {
      try {
        const detection = await this.detect({ cli, override, signal: entry.controller.signal })
        if (this.refreshing.get(cli) !== entry) return
        if (this.readConfig()[cli].cliPath.trim() !== override) {
          this.invalidate(cli)
          await this.refreshOne(cli)
          return
        }
        this.snapshot = { ...this.snapshot, [cli]: {
          installed: detection.installed, version: detection.version, path: detection.path, checking: false,
          ...(detection.error === undefined ? {} : { error: detection.error }),
        } }
      } catch (error) {
        if (this.refreshing.get(cli) !== entry || entry.controller.signal.aborted) return
        if (this.readConfig()[cli].cliPath.trim() !== override) {
          this.invalidate(cli)
          await this.refreshOne(cli)
          return
        }
        this.snapshot = { ...this.snapshot, [cli]: {
          ...status, checking: false, error: `CLI 检测失败：${error instanceof Error ? error.message : String(error)}`,
        } }
      } finally {
        if (this.refreshing.get(cli) === entry) this.refreshing.delete(cli)
      }
    })()
    return entry.promise
  }
}

/** GET overview — statuses, safe config view, recent tasks. */
export function handleOverview(deps: RouteDeps): RouteOutcome {
  const config = deps.readConfig()
  const tasks = deps.registry.list().filter(task => task.sessionId === undefined && task.kind === 'npm').slice(0, 20)
  const overview: MaestroOverview = {
    clis: deps.statusStore.get(),
    enabled: config.enabled,
    defaultCli: config.defaultCli,
    minTaskDifficulties: { claude: config.claude.minTaskDifficulty, codex: config.codex.minTaskDifficulty },
    dshModels: { claude: config.claude.dshModel, codex: config.codex.dshModel },
    dsh: {
      minTaskDifficulty: config.dsh.minTaskDifficulty,
      taskTypes: config.dsh.taskTypes,
      version: dshVersion(),
    },
    tasks,
    ...(deps.hostCapabilities === undefined ? {} : { hostCapabilities: deps.hostCapabilities() }),
  }
  return ok(overview)
}

/** The host dsh version is fixed for the life of the process; resolve it once. */
let dshVersionCache: string | null | undefined
function dshVersion(): string | null {
  if (dshVersionCache === undefined) dshVersionCache = readPackageVersion('@deepseek-ai/dsh')
  return dshVersionCache
}

/** Authenticated runtime owner, injected by HTTP transport, not parsed from JSON/query. */
export interface TaskPrincipal { readonly sessionId: string }

/** GET tasks — summaries scoped to the authenticated owner. */
export function handleTasks(deps: RouteDeps, query?: URLSearchParams, principal?: TaskPrincipal): RouteOutcome {
  const sessions = parseSessionFilter(query?.get('sessions') ?? null)
  return ok({ tasks: deps.registry.list().filter(task => taskVisible(task, sessions, principal)) })
}

/**
 * The session ids a board may show. `sessions=<id,id,…>` on the query string
 * (`null`/blank = no scoping, the operator's own view).
 */
export function parseSessionFilter(raw: string | null): ReadonlySet<string> | undefined {
  if (raw === null) return undefined
  const ids = raw.split(',').map(id => id.trim()).filter(id => id !== '')
  return ids.length === 0 ? undefined : new Set(ids)
}

/** The body form of the same filter (`{sessions: [id,…]}`). */
function parseSessionList(raw: unknown): ReadonlySet<string> | undefined {
  if (!Array.isArray(raw)) return undefined
  const ids = raw.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map(id => id.trim())
  return ids.length === 0 ? undefined : new Set(ids)
}

/**
 * Whether one task belongs to the caller's session scope. Owner-less tasks
 * (npm installs started from the config card) stay visible everywhere.
 */
function taskVisible(task: { readonly sessionId?: string | undefined; readonly kind?: 'cli' | 'npm' | undefined }, sessions: ReadonlySet<string> | undefined, principal?: TaskPrincipal): boolean {
  if (task.sessionId === undefined) return task.kind === 'npm'
  return principal !== undefined && task.sessionId === principal.sessionId && (sessions === undefined || sessions.has(task.sessionId))
}

/** GET task?id=&cursor=&sessions= — one task's detail plus events after the cursor. */
export function handleTaskDetail(deps: RouteDeps, query: URLSearchParams, principal?: TaskPrincipal): RouteOutcome {
  const id = query.get('id') ?? ''
  if (id === '') return fail(400, '"id" 不能为空')
  const sessions = parseSessionFilter(query.get('sessions'))
  const cursor = Number(query.get('cursor') ?? '0')
  const page = deps.registry.eventsSince(id, cursor)
  // A task from another conversation reads as absent — the board must not leak
  // that another session's task exists.
  if (page === undefined || !taskVisible(page.task, sessions, principal)) return fail(404, `任务不存在：${id}`)
  const task = page.task
  const summary: MaestroTaskSummary = deps.registry.summaryOf(task)
  const detail: MaestroTaskDetail = {
    summary,
    ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
    ...(task.prompt === undefined || task.prompt === '' ? {} : { prompt: task.prompt }),
    ...(task.finalText === undefined ? {} : { finalText: task.finalText }),
    ...(task.error === undefined ? {} : { error: task.error }),
    ...(task.stats === undefined ? {} : { stats: task.stats }),
    events: page.events,
    nextCursor: page.nextCursor,
  }
  return ok(detail)
}

/** POST task/cancel {id} — abort one queued/running task. */
export function handleTaskCancel(deps: RouteDeps, body: unknown, principal?: TaskPrincipal): RouteOutcome {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  if (id === '') return fail(400, '"id" 不能为空')
  const task = deps.registry.get(id)
  if (task === undefined || !taskVisible(task, parseSessionList(record['sessions']), principal)) return fail(404, `任务不存在：${id}`)
  if (isTerminalPhase(task.phase)) return fail(409, `任务已结束（${task.phase}），无需取消`)
  const controller = deps.controllers.get(id)
  if (controller === undefined) return fail(409, '任务尚未挂起执行进程，请稍后重试')
  controller.abort(new Error('用户在配置页取消了任务'))
  return ok({ id, phase: task.phase } satisfies MaestroTaskRef)
}

/**
 * POST task/reply {id, text, sessions?, model?, thinking?, timeout_minutes?} —
 * send one follow-up message into a settled CLI task's session (claude
 * `--resume` / codex `exec resume`). The reply runs as a new task chained to
 * the original via `replyTo` and answers with its id immediately; the session
 * page follows it through the ordinary task-detail poll.
 *
 * `model` is a dsh-catalog selection (`provider::model`) from the session
 * page's picker — it resolves against dsh's configured providers and never
 * touches the CLI's own configuration. An empty model follows the dispatch's
 * usual route (配置页模型).
 */
/**
 * 续接消息的最终文本：可配置前缀在前（出厂为空），人写的内容在后。
 * 纯函数，方便把"前缀到底有没有生效"直接测出来。
 */
export function replyTextOf(prefix: string, text: string): string {
  const trimmed = prefix.trim()
  return trimmed === '' ? text : `${trimmed}

${text}`
}

export function handleTaskReply(deps: RouteDeps, body: unknown, principal?: TaskPrincipal): RouteOutcome {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  const text = typeof record['text'] === 'string' ? record['text'].trim() : ''
  if (id === '') return fail(400, '"id" 不能为空')
  if (text === '') return fail(400, '"text" 不能为空：回复内容就是发给 CLI 的新指令')
  if (text.length > 100_000) return fail(400, '"text" 超过 100k 字符上限')
  if (!deps.readConfig().enabled) return fail(409, 'CLI 子代理插件已停用（配置页可重新开启）')
  const task = deps.registry.get(id)
  if (task === undefined || !taskVisible(task, parseSessionList(record['sessions']), principal)) return fail(404, `任务不存在：${id}`)
  if (!isTerminalPhase(task.phase)) return fail(409, '任务还在运行中，等它结束再续发')
  // The runner records the CLI session reference inside the extensible stats
  // contract (persisted with the stats); that is the handle a reply resumes.
  const sessionRef = typeof task.stats?.['sessionRef'] === 'string' ? task.stats['sessionRef'] : ''
  if (sessionRef === '') {
    return fail(409, `这个任务没有可续接的 ${task.cli} 会话引用（CLI 未返回会话 id），无法续发`)
  }
  const model = typeof record['model'] === 'string' ? record['model'].trim() : ''
  // 会话模型继承：请求没带 model（会话页已不再有模型选择器）时，沿用这条
  // 会话最近一轮真正解析出的 dsh 选择（stats['dshModel']）——与 dsh 子智能体
  // 的子会话携带自身模型同一条语义：续发接着上一轮的模型聊，绝不落到 CLI
  // 自身配置。锚点轮也没记录（老任务/dsh 目录不可用的部署）就保持为空，走
  // dispatch 原有的自动路由。
  const inheritedModel = model === '' && typeof task.stats?.['dshModel'] === 'string' ? task.stats['dshModel'] : ''
  const selection = model !== '' ? model : inheritedModel
  const modelError = dshModelSelectionError(selection)
  if (modelError !== undefined) return fail(400, `"model" ${modelError}`)
  const thinking = typeof record['thinking'] === 'string' ? record['thinking'].trim() : ''
  const thinkingError = modelTokenError(thinking)
  if (thinkingError !== undefined) return fail(400, `"thinking" ${thinkingError}`)
  const replyPrefix = (deps.replyPrefix?.() ?? '').trim()
  const rawTimeout = record['timeout_minutes']
  const timeoutMinutes = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout)
    ? Math.min(240, Math.max(1, Math.round(rawTimeout)))
    : undefined
  // 一个 CLI 会话同一时刻只能有一条回复在跑：两条并发 resume 打在同一个
  // claude session / codex thread 上会互相踩。客户端在发送后到列表轮询到
  // 新回复前会锁输入，这里是双开窗口时的兜底。（排在参数校验之后：坏请求
  // 无论什么状态都该拿到 400，而不是被状态检查截成 409。）
  if (deps.registry.resumeBusy(task.cli, sessionRef)) return fail(409, '同一 CLI 会话已有续接正在执行，请等待结束')
  const runningReply = deps.registry.list().find(candidate => candidate.replyTo === id && !isTerminalPhase(candidate.phase))
  if (runningReply !== undefined) {
    return fail(409, `上一条回复（${runningReply.id}）还在执行，等它结束再续发`)
  }

  // runDispatch's synchronous prefix (enabled check → CLI pin → registry.create
  // → onTaskId) completes before its first await, so the reply's id exists by
  // the time this call returns. Its own AbortController is registered under the
  // reply id, so the ordinary cancel route keeps working; nothing here needs a
  // second handle on the run.
  let replyId = ''
  // 会话页回复与工具派发走同一条记账通道：解析派发会话的 append 面（父会话
  // 不在线就跳过——记录是观测面，不阻塞续发），runDispatch 据此写
  // maestro/cli-usage 投影事件与原生子会话。
  const parentSession = task.sessionId === undefined ? undefined : deps.parentSessionOf?.(task.sessionId)
  const executionAgent = task.sessionId === undefined ? undefined : deps.parentAgentOf?.(task.sessionId)
  const running = runDispatch(
    deps,
    {
      cli: task.cli,
      // 团队固定的开场白（`/prompts` 可改）在这里拼到人写的内容前面；出厂为空。
      task: replyTextOf(replyPrefix, text),
      resume: sessionRef,
      cwd: task.cwd,
      ...(selection === '' ? {} : { dshModel: selection }),
      // 继承来的选择要在事件流里说清楚来源（显式选择的措辞不同）。
      ...(model === '' && inheritedModel !== '' ? { dshModelInherited: true } : {}),
      ...(thinking === '' ? {} : { thinking }),
      ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
      replyTo: task.id,
      ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
      ...(parentSession === undefined ? {} : { usageSession: parentSession }),
      ...(executionAgent === undefined ? {} : { executionAgent }),
    },
    new AbortController().signal,
    { onTaskId: (newId) => { replyId = newId } },
  )
  if (replyId === '') {
    // Only reachable when the plugin was disabled between the two checks above:
    // the record never existed, so there is nothing to poll — say so outright.
    void running.catch(() => { /* no record to carry the failure; the answer says it */ })
    return fail(409, '续发未能启动：插件可能刚被停用，请刷新后重试')
  }
  // Settle failures (spawn errors, timeouts, cancel) are recorded on the reply
  // task by runDispatch itself; the session page renders them like any turn.
  void running.catch(() => { /* recorded on the reply task */ })
  return ok({ id: replyId, phase: 'queued' } satisfies MaestroTaskRef)
}

/** POST cli/refresh {cli?} — re-detect (one CLI or both) right now. */
export async function handleCliRefresh(deps: RouteDeps, body: unknown): Promise<RouteOutcome> {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const cli = record['cli']
  deps.pathCache.invalidate()
  if (typeof cli === 'string' && (MAESTRO_CLI_IDS as readonly string[]).includes(cli)) {
    await deps.statusStore.refresh(cli as MaestroCliId)
    return ok({ clis: deps.statusStore.get() })
  }
  await deps.statusStore.refresh()
  return ok({ clis: deps.statusStore.get() })
}

/** A published npm version string (`1.2.3`, `0.166.0-alpha.6`). */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** GET cli/versions?cli= — versions published on the npm registry. */
export async function handleCliVersions(deps: RouteDeps, query: URLSearchParams): Promise<RouteOutcome> {
  const cli = query.get('cli') ?? ''
  if (!(MAESTRO_CLI_IDS as readonly string[]).includes(cli)) {
    return fail(400, `"cli" 必须是 ${MAESTRO_CLI_IDS.join(' | ')}`)
  }
  const result = await queryPackageVersions({
    ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
    cli: cli as MaestroCliId,
    registry: deps.readConfig().npmRegistry,
  })
  if (!result.ok) return fail(502, result.error)
  return ok({
    cli: cli as MaestroCliId,
    latest: result.value.latest,
    versions: result.value.versions,
    platform: `${process.platform}-${process.arch}`,
  } satisfies MaestroCliVersions)
}

/**
 * POST cli/install|update|uninstall {cli,version?} — start one npm job as a
 * registry task and answer immediately; the card watches it through the task
 * poll. `install` with a `version` pins `pkg@version`; without one it installs
 * the registry's latest.
 */
export function handleCliNpmJob(deps: RouteDeps, action: 'install' | 'uninstall', body: unknown): RouteOutcome {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const cli = record['cli']
  if (typeof cli !== 'string' || !(MAESTRO_CLI_IDS as readonly string[]).includes(cli)) {
    return fail(400, `"cli" 必须是 ${MAESTRO_CLI_IDS.join(' | ')}`)
  }
  // One npm job per CLI at a time: two concurrent `npm -g` runs fight over the
  // global install lock and leave the status store guessing which one won.
  const running = deps.registry.list().find(task =>
    task.id.startsWith('npm-') && task.cli === cli && !isTerminalPhase(task.phase))
  if (running !== undefined) {
    return fail(409, `${CLI_LABELS[cli as MaestroCliId]} 已有 npm 任务进行中（${running.title}），请等它结束`)
  }
  const rawVersion = record['version']
  let version: string | undefined
  if (action === 'install' && typeof rawVersion === 'string' && rawVersion.trim() !== '') {
    if (!VERSION_PATTERN.test(rawVersion.trim())) return fail(400, `"version" 不是合法版本号：${rawVersion}`)
    version = rawVersion.trim()
  }
  const config = deps.readConfig()
  const registry = deps.registry
  const id = `npm-${randomUUID().slice(0, 8)}`
  const controller = new AbortController()
  deps.controllers.set(id, controller)
  const task = registry.create({
    id,
    kind: 'npm',
    cli: cli as MaestroCliId,
    title: `${action === 'install' ? (version === undefined ? '安装/更新' : `安装 ${version}`) : '卸载'} ${CLI_LABELS[cli as MaestroCliId]}（npm -g ${CLI_PACKAGES[cli as MaestroCliId]}）`,
    model: '',
  })
  void (async () => {
    try {
      registry.setPhase(task, 'running', `npm ${action} 开始${version === undefined ? '' : `（目标版本 ${version}）`}${config.npmRegistry === '' ? '' : `（registry ${config.npmRegistry}）`}`)
      const result = await runNpmJob({
        ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
        action,
        cli: cli as MaestroCliId,
        registry: config.npmRegistry,
        ...(version === undefined ? {} : { version }),
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
      deps.pathCache.invalidate()
      deps.statusStore.invalidate(cli as MaestroCliId)
      void deps.statusStore.refresh(cli as MaestroCliId)
    }
  })()
  return ok({ id, phase: task.phase } satisfies MaestroTaskRef)
}

/** GET hint — the routing hint text (debug/preview for the card). */
export function handleHint(deps: RouteDeps): RouteOutcome {
  const config = deps.readConfig()
  return ok({ hint: routingHint(config, deps.toolName()), redacted: redactEffective(config) })
}

/**
 * GET health — 各子系统自报的健康条目。健康态返回空列表：面板上不占地方，
 * 出问题时才有内容。
 */
export function handleHealth(deps: RouteDeps): RouteOutcome {
  const board = deps.healthBoard
  return ok({
    worst: board?.worst() ?? 'ok',
    entries: board?.all() ?? [],
  })
}

/**
 * GET status — `maestro status` 的一屏摘要：按阶段计数（谁在等、谁在跑）、
 * 未结清的副作用行、以及健康问题。脚本只认这个形状。
 */
export function handleStatus(deps: RouteDeps): RouteOutcome {
  const counts: Record<MaestroStage, number> = {
    'person/answer': 0,
    'person/review': 0,
    'person/blocked': 0,
    'person/failed': 0,
    'working/queued': 0,
    working: 0,
    idle: 0,
  }
  for (const task of deps.registry.list()) counts[task.stage ?? 'idle'] += 1
  const waiting = (Object.keys(counts) as MaestroStage[]).filter(needsPerson)
    .reduce((sum, stage) => sum + counts[stage], 0)
  return ok({
    enabled: deps.readConfig().enabled,
    tasks: counts,
    needsPerson: waiting,
    pendingEffects: deps.effects?.size() ?? 0,
    problems: (deps.healthBoard?.problems() ?? []).map(entry => ({ name: entry.name, level: entry.level, message: entry.message ?? '' })),
  })
}

/** GET prompts — 三条可编辑片段的当前文本、是否被改过、默认是否已变。 */
export function handlePrompts(deps: RouteDeps): RouteOutcome {
  return ok({ cap: PROMPT_CAP, fragments: deps.prompts?.list() ?? [] })
}

/** POST prompts/save {id,text} — 空文本即恢复默认。 */
export async function handlePromptsSave(deps: RouteDeps, body: unknown): Promise<RouteOutcome> {
  const prompts = deps.prompts
  if (prompts === undefined) return fail(503, '提示模板服务不可用')
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const id = record['id']
  const known = PROMPT_FRAGMENTS.some(fragment => fragment.id === id)
  if (typeof id !== 'string' || !known) return fail(400, '"id" 必须是 resultProtocol / routingHint / replyPrefix 之一')
  const text = record['text']
  if (typeof text !== 'string') return fail(400, '"text" 必须是字符串（空串 = 恢复默认）')
  try {
    if (text.trim() === '') await prompts.reset(id as PromptId)
    else await prompts.override(id as PromptId, text)
  } catch (error) {
    return fail(400, error instanceof Error ? error.message : String(error))
  }
  return ok({ cap: PROMPT_CAP, fragments: prompts.list() })
}

/** GET config-history — 最近若干次配置快照与差异（旧到新）。 */
export function handleConfigHistory(deps: RouteDeps): RouteOutcome {
  const history = deps.configHistory
  if (history === undefined) return fail(503, '配置历史不可用')
  return ok({ entries: history.entriesOf().slice(-20), latest: history.latestChanges() })
}

/** Convert the HTTP boundary to the internal bridge parameters. Query/body credentials are ignored. */
export function bridgeCatalogRequestQuery(query: URLSearchParams, credential: unknown): URLSearchParams {
  const result = new URLSearchParams()
  const cwd = query.get('cwd')
  if (cwd !== null) result.set('cwd', cwd)
  result.set('token', typeof credential === 'string' ? credential : '')
  return result
}

export function bridgeCallRequestBody(body: unknown, credential: unknown): Record<string, unknown> {
  const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {}
  return { ...record, token: typeof credential === 'string' ? credential : '' }
}

/** Internal catalog parameters; HTTP callers must first use bridgeCatalogRequestQuery. */
export async function handleBridgeCatalog(deps: RouteDeps, query: URLSearchParams): Promise<RouteOutcome> {
  const bridge = deps.bridge
  if (bridge === undefined) return fail(404, '技能桥未启用（宿主缺少 skills 服务或 HTTP 面板）')
  const result = await bridge.catalog(query.get('token') ?? '', query.get('cwd') ?? undefined)
  return 'error' in result ? fail(result.status, result.error) : ok(result)
}

/** POST bridge/call {token, kind, name, cwd?, arguments?} — one bridge invocation from the shim. */
export async function handleBridgeCall(deps: RouteDeps, body: unknown): Promise<RouteOutcome> {
  const bridge = deps.bridge
  if (bridge === undefined) return fail(404, '技能桥未启用（宿主缺少 skills 服务或 HTTP 面板）')
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const token = typeof record['token'] === 'string' ? record['token'] : ''
  const kind = typeof record['kind'] === 'string' ? record['kind'] : ''
  const name = typeof record['name'] === 'string' ? record['name'] : ''
  const cwd = typeof record['cwd'] === 'string' && record['cwd'].trim() !== '' ? record['cwd'] : undefined
  if (kind === 'skill') {
    const result = await bridge.loadSkill(token, name, cwd)
    return result.ok ? ok(result) : fail(result.status, result.error)
  }
  if (kind === 'tool') {
    const args = typeof record['arguments'] === 'object' && record['arguments'] !== null && !Array.isArray(record['arguments'])
      ? record['arguments'] as Record<string, unknown>
      : {}
    const result = await bridge.callTool(token, name, args)
    return result.ok ? ok(result) : fail(result.status, result.error)
  }
  return fail(400, '"kind" 必须是 "skill" 或 "tool"')
}

/** GET models — the dsh provider/model catalog for the card's pickers, plus the bridged MCP server names. */
export async function handleModels(deps: RouteDeps): Promise<RouteOutcome> {
  try {
    const catalog = await deps.listDshModels()
    const servers = deps.listMcpServers()
    const diagnostics = mcpDiscoveryDiagnostics(deps)
    const bridge = deps.bridge === undefined ? undefined : await deps.bridge.diagnose()
    return ok({
      providers: catalog.providers,
      mcpServers: servers.map(server => ({ name: server.name, source: server.source })),
      ...(bridge === undefined ? {} : { bridge }),
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
