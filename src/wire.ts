/**
 * Shared wire contract between the host half (HTTP routes under
 * `/plugin/dsh-maestro-codex`) and the browser half (settings card + task
 * monitor). Zero runtime dependencies: constants, pure helpers and types,
 * imported by both builds.
 */

/** The plugin entry id — also the settings namespace and the route prefix tail. */
export const PLUGIN_ID = 'dsh-maestro-codex'

/** Capability delivered only through the authorized host session projection. Never put in a URL or CLI prompt. */
export interface MaestroSessionAccess { readonly sessionId: string; readonly token: string }
export const CLI_ACCESS_PROJECTION_KEY = 'maestroCliAccess'
export const CLI_ACCESS_EVENT = 'maestro/cli-access'
export const CLI_ACCESS_HEADER = 'x-maestro-session-access'
/** Per-run bridge credential: HTTP header only, never query/log/model content. */
export const BRIDGE_ACCESS_HEADER = 'x-maestro-bridge-access'

/** Absolute pathname prefix every route of this plugin lives under. */
export const ROUTE_PREFIX = `/plugin/${PLUGIN_ID}`

/** GET ROUTE_PREFIX/overview — CLI statuses, safe config view, recent tasks. */
export const ROUTE_OVERVIEW = `${ROUTE_PREFIX}/overview`

/** GET ROUTE_PREFIX/tasks?sessions=<id,id,…> — task summaries, optionally scoped
 * to a session tree (owner-less npm jobs always stay visible). */
export const ROUTE_TASKS = `${ROUTE_PREFIX}/tasks`

/** GET ROUTE_PREFIX/task?id=<id>&cursor=<seq> — one task's detail plus events after the cursor. */
export const ROUTE_TASK_DETAIL = `${ROUTE_PREFIX}/task`

/** POST ROUTE_PREFIX/task/cancel {id} — abort one queued/running task. */
export const ROUTE_TASK_CANCEL = `${ROUTE_PREFIX}/task/cancel`

/**
 * POST ROUTE_PREFIX/task/reply {id,text,model?,thinking?} — send one follow-up
 * message into a settled CLI task's session (claude `--resume` / codex
 * `exec resume`). The board's session page posts here; the reply runs as a new
 * task chained to the original via `replyTo`.
 */
export const ROUTE_TASK_REPLY = `${ROUTE_PREFIX}/task/reply`

/** POST ROUTE_PREFIX/cli/refresh {cli} — re-detect one CLI's install state. */
export const ROUTE_CLI_REFRESH = `${ROUTE_PREFIX}/cli/refresh`

/** GET ROUTE_PREFIX/cli/versions?cli= — versions published on the npm registry. */
export const ROUTE_CLI_VERSIONS = `${ROUTE_PREFIX}/cli/versions`

/** POST ROUTE_PREFIX/cli/install {cli,version?} — install one version via npm -g. */
export const ROUTE_CLI_INSTALL = `${ROUTE_PREFIX}/cli/install`

/** POST ROUTE_PREFIX/cli/uninstall {cli} — uninstall via npm -g. */
export const ROUTE_CLI_UNINSTALL = `${ROUTE_PREFIX}/cli/uninstall`

/** GET ROUTE_PREFIX/hint — the routing hint text the host injects into the system prompt. */
export const ROUTE_HINT = `${ROUTE_PREFIX}/hint`

/** GET ROUTE_PREFIX/models — dsh providers/models joined with CLI-mappability facts. */
export const ROUTE_MODELS = `${ROUTE_PREFIX}/models`

/**
 * GET ROUTE_PREFIX/bridge/catalog?cwd= with BRIDGE_ACCESS_HEADER — what the bridge shim may expose
 * to one dispatched CLI run (dsh skills; host tools from PR2 onward). Token is
 * the per-run value issued at dispatch time.
 */
export const ROUTE_BRIDGE_CATALOG = `${ROUTE_PREFIX}/bridge/catalog`

/**
 * POST ROUTE_PREFIX/bridge/call {kind, name, cwd?} with BRIDGE_ACCESS_HEADER — one bridge
 * invocation from the shim: load a skill body (PR1) or execute an allowlisted
 * host tool (PR2).
 */
export const ROUTE_BRIDGE_CALL = `${ROUTE_PREFIX}/bridge/call`

/** GET ROUTE_PREFIX/health — 各子系统健康条目（P1-1）。 */
export const ROUTE_HEALTH = `${ROUTE_PREFIX}/health`

/** GET ROUTE_PREFIX/prompts — 提示模板片段（默认文本 / 是否被改过 / 是否过期）。 */
export const ROUTE_PROMPTS = `${ROUTE_PREFIX}/prompts`

/** POST ROUTE_PREFIX/prompts/save {id,text} — 保存或重置一条提示片段。 */
export const ROUTE_PROMPTS_SAVE = `${ROUTE_PREFIX}/prompts/save`

/** GET ROUTE_PREFIX/config-history — 配置变更快照与差异（P2-1）。 */
export const ROUTE_CONFIG_HISTORY = `${ROUTE_PREFIX}/config-history`

/** GET ROUTE_PREFIX/status — 给 `maestro status` 用的一屏摘要（P1-4）。 */
export const ROUTE_STATUS = `${ROUTE_PREFIX}/status`

/** One dsh provider as the card's model picker renders it. */
export interface DshProviderModels {
  readonly id: string
  readonly displayName: string
  readonly api: string
  readonly mappable: boolean
  readonly models: readonly DshModelChoice[]
}

/** One model in a provider's catalog, with its configured reasoning efforts. */
export interface DshModelChoice {
  readonly id: string
  /** Effort keys declared under `reasoningEfforts` (settings order kept). */
  readonly reasoningEfforts: readonly string[]
}

/** One bridged dsh MCP server (name only over the wire). */
export interface MaestroMcpServerRef {
  readonly name: string
  readonly source: string
}

/** The CLIs this plugin drives. */
export type MaestroCliId = 'claude' | 'codex' | 'grok'

/** 路由目标：两个外部 CLI，外加内置 dsh 子代理（不经过 CLI 进程）。 */
export type MaestroRouteTarget = MaestroCliId | 'dsh'

export const MAESTRO_CLI_IDS: readonly MaestroCliId[] = ['claude', 'codex', 'grok']

/**
 * Lifecycle phase of one dispatched task.
 *
 * `interrupted` 是"进程死了、这次跑没有结论"：不同于 `failed`（跑完了但失败），
 * 也不同于 `cancelled`（人主动停的）。它只在启动恢复时产生，恢复后由人决定
 * 重新派发还是丢弃——看板据此把卡片标成"需要人处理"而不是"失败"。
 */
export type MaestroPhase = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'timeout' | 'interrupted'

/**
 * Terminal phases (a task in one of these will not run again).
 *
 * `interrupted` 在这里：进程已经没了，没有任何执行路径会再碰这个任务，恢复
 * 是一次新的派发（会创建新任务），不是这个任务自己继续。
 */
export const TERMINAL_PHASES: readonly MaestroPhase[] = ['done', 'failed', 'cancelled', 'timeout', 'interrupted']

/**
 * 派发任务的"等人还是等机器"。
 *
 * phase 回答"生命周期走到哪了"（queued/running/终态），stage 回答"现在该谁动"。
 * 两者不是一张表：一个 `done` 的任务可能正等人看结果（person/review），一个
 * `running` 的任务可能正等人补一句话（person/answer）。
 */
export type MaestroStage =
  /** 等人：下游阻塞在某个只有人能做的决定上。 */
  | 'person/answer'
  /** 等人：跑完了，结果需要人过目。 */
  | 'person/review'
  /** 等人：任务自己说被卡住了。 */
  | 'person/blocked'
  /** 等人：任务失败，要不要重试只有人能定。 */
  | 'person/failed'
  /** 等机器：排队等槽位。 */
  | 'working/queued'
  /** 等机器：正在跑。 */
  | 'working'
  /** 结束了，没有任何一方需要动。 */
  | 'idle'

/** 全部 stage（测试与面板按这个顺序渲染）。 */
export const MAESTRO_STAGES: readonly MaestroStage[] = [
  'person/answer',
  'person/review',
  'person/blocked',
  'person/failed',
  'working/queued',
  'working',
  'idle',
]

/** stage 的人读标签。 */
export const MAESTRO_STAGE_LABELS: Readonly<Record<MaestroStage, string>> = {
  'person/answer': '等你回话',
  'person/review': '等你验收',
  'person/blocked': '等你处理阻塞',
  'person/failed': '等你决定重试',
  'working/queued': '排队中',
  working: '进行中',
  idle: '已结束',
}

/** The progress facts a channel surfaces for one CLI frame. */
export interface MaestroChannelEvent {
  readonly kind: 'text' | 'thinking' | 'tool' | 'result' | 'note' | 'error'
  readonly text: string
  /** Expandable public tool parameters, results or error details. */
  readonly detail?: string
}

/** One streamed progress event of a task. */
export interface MaestroTaskEvent {
  /** Monotonic sequence inside the task; the client polls with `after`. */
  readonly seq: number
  /** Wall-clock ms epoch of the event. */
  readonly at: number
  /** Event kind: phase transitions, streamed text, thinking bodies, tool rows, notes, errors. */
  readonly kind: 'phase' | 'text' | 'thinking' | 'tool' | 'note' | 'error' | 'result'
  readonly text: string
  /** A tool row's expandable body; its first line doubles as the collapsed summary. */
  readonly detail?: string
}

/** The kinds a task event may carry (restore validates persisted rows against it). */
export const MAESTRO_EVENT_KINDS: readonly MaestroTaskEvent['kind'][] = ['phase', 'text', 'thinking', 'tool', 'note', 'error', 'result']

/** npm package that provides each CLI (install/update/uninstall target). */
export const CLI_PACKAGES: Record<MaestroCliId, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  grok: '@xai-official/grok',
}

/** Human label per CLI. */
export const CLI_LABELS: Record<MaestroCliId, string> = {
  claude: 'claude cli',
  codex: 'codex cli',
  grok: 'grok cli',
}

/** Four-character task names shared by the CLI picker and routing defaults. */
export const TASK_TYPE_CATALOG: readonly string[] = [
  '仓库探索', '代码定位', '资料检索', '方案核验', '影响分析',
  '功能开发', '缺陷修复', '测试验证', '代码审查', '数据处理',
  '模块重构', '方案设计', '文档整理',
]

/** Keep task names short; explain the independent deliverable in the tooltip. */
export const TASK_TYPE_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  ['仓库探索', '梳理目录、入口、模块职责与依赖关系，返回仓库地图和关键代码位置。'],
  ['代码定位', '定位实现位置、调用链与相关配置，返回路径、行号和结论。'],
  ['资料检索', '搜集资料，整理来源、证据与未确认事项。'],
  ['方案核验', '独立检查方案的遗漏、反例与风险，返回问题清单。'],
  ['影响分析', '分析变更范围，列出受影响模块、接口、配置与回归项。'],
  ['功能开发', '实现范围明确的模块或接口，补齐必要测试并返回验证结果。'],
  ['缺陷修复', '复现问题、定位根因、修复并增加回归测试。'],
  ['测试验证', '补齐测试、执行回归，分析失败原因并返回测试结果。'],
  ['代码审查', '检查正确性、安全边界与回归风险，按严重程度返回位置和证据。'],
  ['数据处理', '编写数据转换、校验、统计及自动化脚本，返回可运行脚本和样例结果。'],
  ['模块重构', '调整跨模块结构与依赖，保持外部行为并验证回归风险。'],
  ['方案设计', '比较实现路径，明确接口、约束、取舍与迁移步骤。'],
  ['文档整理', '根据真实实现整理技术文档、使用说明与交接资料。'],
])

/** Rename built-in legacy types without replacing a user's CLI assignments. */
export const LEGACY_TASK_TYPE_NAMES: ReadonlyMap<string, string> = new Map([
  ['需求分析', '方案设计'],
  ['代码生成', '功能开发'],
  ['文档写作', '文档整理'],
  ['项目测试', '测试验证'],
  ['重构', '模块重构'],
  ['调试修复', '缺陷修复'],
])

export function normalizeTaskType(type: string): string {
  return LEGACY_TASK_TYPE_NAMES.get(type) ?? type
}

/** Preserve custom keywords and order, but never show an old/new duplicate. */
export function normalizeTaskTypes(types: readonly string[]): string[] {
  return [...new Set(types.map(normalizeTaskType))]
}

/** A legacy keyword and its new name count as one task type when routing. */
export function taskTypeKeywords(type: string): readonly string[] {
  const name = normalizeTaskType(type)
  const aliases = [...LEGACY_TASK_TYPE_NAMES]
    .filter(([, current]) => current === name)
    .map(([legacy]) => legacy)
  return [name, ...aliases]
}

/**
 * The thinking levels a CLI accepts are NOT hardcoded: the card derives the
 * options from the selected dsh model's `reasoningEfforts` (see
 * `DshModelChoice`). These two tables only translate a chosen level into each
 * CLI's own knob; a level absent from its table is ignored at run time.
 */

/**
 * claude level → `MAX_THINKING_TOKENS` budget. `off`/`none`/`minimal` disable
 * thinking (0); the rest follow Claude Code's own keyword tiers (think / think
 * hard / ultrathink).
 */
export const CLAUDE_THINKING_BUDGETS: Readonly<Record<string, number>> = {
  off: 0,
  none: 0,
  minimal: 0,
  low: 4096,
  medium: 10000,
  high: 31999,
  xhigh: 31999,
  ultra: 31999,
}

/** `model_reasoning_effort` values codex parses; anything else (e.g. `off`) is skipped. */
export const CODEX_REASONING_EFFORTS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'none']

/**
 * Canonical `--reasoning-effort` levels grok parses (a model only accepts the
 * levels it declares; unsupported keys are skipped at run time like codex).
 */
export const GROK_REASONING_EFFORTS: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** One CLI's published versions (npm registry) for the SDK card's picker. */
export interface MaestroCliVersions {
  readonly cli: MaestroCliId
  /** The registry's `latest` dist-tag ('' when it is a prerelease). */
  readonly latest: string
  /** Stable releases only, oldest first (prereleases are filtered out). */
  readonly versions: readonly string[]
  /** The machine this host runs on, e.g. `win32-x64`. */
  readonly platform: string
}

/**
 * Strip terminal escape sequences and stray control characters out of CLI
 * output before it reaches the log view. Codex/claude paint progress bars with
 * ANSI colours and carriage-return redraws; rendered as text those bytes show
 * up as mojibake, so both the host (event ring) and the card clean the text.
 */
export function cleanLogText(text: string): string {
  return text
    // OSC sequences: ESC ] … (BEL | ESC \)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // CSI sequences: ESC [ params/intermediates final-byte
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // Any other two-byte ESC sequence.
    .replace(/\u001b[@-Z\\-_]/g, '')
    // C0 controls except TAB and LF, plus DEL.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
}

/**
 * Turn a raw CLI failure blob (command dumps, stderr tails, provider errors)
 * into one short cause line — 「限流 / 超时 / 网络错误 …」 — for the places where
 * the user only wants to know *why* it failed. The full text stays available
 * (task detail / collapsed原文), so nothing is lost; the cause is classified,
 * not abbreviated. First matching cause wins: a cancellation or rate-limit
 * sentence buried in a stderr tail is the real reason even when the blob also
 * carries a bare exit code.
 */
export function summarizeError(text: string): string {
  const first = cleanLogText(text).trim()
  if (first === '') return '任务失败（原因未知）'
  if (/任务已取消|已取消，进程|cancel+ed|abort/i.test(first)) return '任务已取消'
  if (/连续无输出|超时|timed? ?out|ETIMEDOUT|TimeoutError/i.test(first)) return '任务失败：超时'
  if (/429|rate ?limit|too many requests|RESOURCE_EXHAUSTED|quota|额度|限流/i.test(first)) return '任务失败：限流'
  if (/ECONN|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR|CERT_|DEPTH_ZERO|UNABLE_TO_VERIFY|socket hang up|网络或传输/i.test(first)) return '任务失败：网络错误'
  const exit = /进程退出码\s*(\d+)/.exec(first)
  if (exit !== null) return `任务失败：退出码 ${exit[1]}`
  if (/未返回文本|未返回最终答复|缺少非空|result 帧缺失/i.test(first)) return '任务失败：CLI 未返回结果'
  const head = first.split(/\r?\n/, 1)[0] ?? ''
  return `任务失败：${head.length > 80 ? `${head.slice(0, 80)}…` : head}`
}

/** Detected install state of one CLI. */
export interface MaestroCliStatus {
  readonly installed: boolean
  readonly version: string
  readonly path: string
  readonly error?: string
  /** First detection/refresh is in flight; an empty version alone is not absence. */
  readonly checking?: boolean
}

/** Measured CLI usage in four disjoint buckets (never raw inclusive input). */
export interface MaestroTokenUsage {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** Unknown statistics stay unknown; no token fields is not a measured zero. */
export function tokenUsageOfStats(stats: Readonly<Record<string, string | number | boolean>> | undefined): MaestroTokenUsage | undefined {
  const keys = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens'] as const
  // This upstream view requires four mutually exclusive numeric buckets.
  // Partial observations remain available in stats/the nullable CLI ledger.
  if (!keys.every(key => {
    const value = stats?.[key]
    return stats?.[`usagePartial_${key}`] !== true && typeof value === 'number' && Number.isFinite(value) && value >= 0
  })) return undefined
  const count = (key: typeof keys[number]): number => Math.round(stats![key] as number)
  return { uncachedInputTokens: count('inputTokens'), outputTokens: count('outputTokens'),
    cacheReadTokens: count('cachedInputTokens'), cacheWriteTokens: count('cacheWriteTokens') }
}

/**
 * 任务自己声明的工作状态（结构化收尾协议）。
 *
 * 子代理在最后一行写 `MAESTRO_RESULT {...}`，插件解析后填进任务摘要；解析
 * 不出来就退成 `unknown` 并按 phase 推导 stage——绝不从自由文本里猜"它是不是
 * 在等人"。
 */
export type MaestroResultState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped' | 'unknown'

/** 解析出的结构化收尾。 */
export interface MaestroTaskResult {
  readonly state: MaestroResultState
  /** 只有人能做的下一步（`waiting`/`blocked` 时使用）。 */
  readonly humanAction?: string
  /** 一句话结论（不是日志，别在这里贴全文）。 */
  readonly summary?: string
  /** 来源：`protocol` = 读到了 MAESTRO_RESULT；`fallback` = 由 phase 推导。 */
  readonly source: 'protocol' | 'fallback'
}

/** Task summary as listed in the monitor. */
export interface MaestroTaskSummary {
  readonly id: string
  readonly cli: MaestroCliId
  readonly kind?: 'cli' | 'npm'
  readonly title: string
  /** 任务全文压平截到 80 字的输入预览；看板把它画成节点的描述行（标题是任务名）。 */
  readonly inputPreview?: string
  readonly phase: MaestroPhase
  /** 现在该谁动（在 phase 之上派生，见 `stage.ts`）。 */
  readonly stage?: MaestroStage
  /** 结构化收尾（协议行解析结果，或由 phase 推导的兜底）。 */
  readonly result?: MaestroTaskResult
  readonly model: string
  /** The session (agent) that dispatched the task; absent = no owner (npm jobs). */
  readonly sessionId?: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly exitCode?: number
  readonly durationMs?: number
  readonly usage?: MaestroTokenUsage
  /**
   * The CLI session reference a follow-up message resumes (claude session id /
   * codex thread id, reported through `stats.sessionRef`); absent = the turn
   * cannot be continued.
   */
  readonly sessionRef?: string
  /** The task this one continues (a session-page reply); absent = a root turn. */
  readonly replyTo?: string
  /** Server-derived CLI ancestor views; never accepted from a request's scope. */
  readonly replySessionIds?: readonly string[]
  /** The event ring dropped older entries: a client must not trust gaps as idle time. */
  readonly truncated?: boolean
}

/** Task detail: summary plus the outcome fields and events after a cursor. */
export interface MaestroTaskDetail {
  readonly summary: MaestroTaskSummary
  readonly cwd?: string
  /** The full task text of this turn — the session page's user message. */
  readonly prompt?: string
  readonly finalText?: string
  readonly error?: string
  readonly stats?: Readonly<Record<string, string | number | boolean>>
  /** Events strictly after `after`; `nextCursor` feeds the next poll. */
  readonly events: readonly MaestroTaskEvent[]
  readonly nextCursor: number
}

/** Host services the plugin adapts to through public interfaces. */
export type HostCapabilityId =
  | 'settings'
  | 'skills'
  | 'agents'
  | 'sessions'
  | 'sessionQuery'
  | 'sessionPersistence'
  | 'sessionProjections'
  | 'tools'
  | 'systemPrompt'
  | 'webServer'

/** One probed public host interface (data only — no paths, tokens, or content). */
export interface HostCapabilityResult {
  readonly id: HostCapabilityId
  readonly present: boolean
  readonly degraded: 'none' | 'partial' | 'absent'
  /** Members this host does not expose. */
  readonly missing: readonly string[]
  /** What the plugin silently loses when this capability is degraded. */
  readonly impact: string
}

/** Where the trusted permission context for host tools comes from. */
export interface PermissionContextReport {
  /** `public-agent-registry` = the real Agent from `agents.get`; `unavailable` = host tools fail closed. */
  readonly source: 'public-agent-registry' | 'unavailable'
  /** `real-symbol-parent` = the host's own execution token is forwarded, never minted. */
  readonly parentToken: 'real-symbol-parent' | 'absent'
  /** Authority is never derived from a URL/scope parameter. */
  readonly scopeParameterTrusted: false
}

/** Capability + version detection report (plugin-only adaptation, read-only). */
export interface HostCapabilityReport {
  readonly schemaVersion: 1
  readonly probedAt: number
  /** Any capability partial/absent, or any host version unresolvable. */
  readonly degraded: boolean
  readonly capabilities: readonly HostCapabilityResult[]
  readonly versions: Readonly<Record<string, string | null>>
  readonly permissionContext: PermissionContextReport
}
/** GET overview answer. */
export interface MaestroOverview {
  readonly clis: Readonly<Record<MaestroCliId, MaestroCliStatus>>
  readonly enabled: boolean
  readonly defaultCli: MaestroCliId
  readonly minTaskDifficulties: Readonly<Record<MaestroCliId, 'low' | 'medium' | 'high' | 'extreme'>>
  /**
   * The configured page model (`provider::model`) per CLI, verbatim and
   * possibly empty. Exposed because it is the fallback that decides which vendor
   * a dispatched task actually talks to — reading it off the running plugin is
   * how an operator confirms the card value reached the live config.
   */
  readonly dshModels: Readonly<Record<MaestroCliId, string>>
  /** 内置 dsh 子代理：随宿主提供，不可安装/升级；类型与门槛决定路由建议。 */
  readonly dsh: {
    readonly minTaskDifficulty: 'low' | 'medium' | 'high' | 'extreme'
    readonly taskTypes: readonly string[]
    /** 宿主 dsh 版本（读不到时为 null，界面显示「版本未知」）。 */
    readonly version: string | null
  }
  readonly tasks: readonly MaestroTaskSummary[]
  /**
   * Public host interfaces this build actually resolved, plus their versions.
   * Absent/partial entries are how an operator tells a host-release mismatch
   * (a member that did not exist yet) apart from a real dispatch failure.
   */
  readonly hostCapabilities?: HostCapabilityReport
}

/** Uniform non-2xx body. */
export interface MaestroRouteError {
  readonly error: string
}

/** POST cancel / dispatch answers. */
export interface MaestroTaskRef {
  readonly id: string
  readonly phase: MaestroPhase
}
