/**
 * Shared wire contract between the host half (HTTP routes under
 * `/plugin/dsh-maestro-codex`) and the browser half (settings card + task
 * monitor). Zero runtime dependencies: constants and types only, imported by
 * both builds.
 */

/** The plugin entry id — also the settings namespace and the route prefix tail. */
export const PLUGIN_ID = 'dsh-maestro-codex'

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
export type MaestroCliId = 'claude' | 'codex'

export const MAESTRO_CLI_IDS: readonly MaestroCliId[] = ['claude', 'codex']

/** Lifecycle phase of one dispatched task. */
export type MaestroPhase = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'timeout'

/** Terminal phases (a task in one of these will not run again). */
export const TERMINAL_PHASES: readonly MaestroPhase[] = ['done', 'failed', 'cancelled', 'timeout']

/** One streamed progress event of a task. */
export interface MaestroTaskEvent {
  /** Monotonic sequence inside the task; the client polls with `after`. */
  readonly seq: number
  /** Wall-clock ms epoch of the event. */
  readonly at: number
  /** Event kind: phase transitions, streamed text, tool/command notes, errors. */
  readonly kind: 'phase' | 'text' | 'note' | 'error' | 'result'
  readonly text: string
}

/** The kinds a task event may carry (restore validates persisted rows against it). */
export const MAESTRO_EVENT_KINDS: readonly MaestroTaskEvent['kind'][] = ['phase', 'text', 'note', 'error', 'result']

/** npm package that provides each CLI (install/update/uninstall target). */
export const CLI_PACKAGES: Record<MaestroCliId, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
}

/** Human label per CLI. */
export const CLI_LABELS: Record<MaestroCliId, string> = {
  claude: 'claude cli',
  codex: 'codex cli',
}

/**
 * The task-type catalog the card offers as clickable chips. Config still holds
 * a plain keyword list per CLI (routing scores these against the task text);
 * the card only decides which catalog entries are on.
 */
export const TASK_TYPE_CATALOG: readonly string[] = [
  '需求分析', '代码生成', '代码审查', '文档写作', '数据处理', '项目测试', '重构', '调试修复',
]

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

/** Detected install state of one CLI. */
export interface MaestroCliStatus {
  readonly installed: boolean
  readonly version: string
  readonly path: string
  readonly error?: string
}

/** Task summary as listed in the monitor. */
export interface MaestroTaskSummary {
  readonly id: string
  readonly cli: MaestroCliId
  readonly title: string
  readonly phase: MaestroPhase
  readonly model: string
  /** The session (agent) that dispatched the task; absent = no owner (npm jobs). */
  readonly sessionId?: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly exitCode?: number
  readonly durationMs?: number
  /** The event ring dropped older entries: a client must not trust gaps as idle time. */
  readonly truncated?: boolean
}

/** Task detail: summary plus the outcome fields and events after a cursor. */
export interface MaestroTaskDetail {
  readonly summary: MaestroTaskSummary
  readonly cwd?: string
  readonly finalText?: string
  readonly error?: string
  readonly stats?: Readonly<Record<string, string | number | boolean>>
  /** Events strictly after `after`; `nextCursor` feeds the next poll. */
  readonly events: readonly MaestroTaskEvent[]
  readonly nextCursor: number
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
  readonly tasks: readonly MaestroTaskSummary[]
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
