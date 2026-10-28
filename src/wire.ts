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

/** GET ROUTE_PREFIX/tasks — the full task list (summaries). */
export const ROUTE_TASKS = `${ROUTE_PREFIX}/tasks`

/** GET ROUTE_PREFIX/task?id=<id>&cursor=<seq> — one task's detail plus events after the cursor. */
export const ROUTE_TASK_DETAIL = `${ROUTE_PREFIX}/task`

/** POST ROUTE_PREFIX/task/cancel {id} — abort one queued/running task. */
export const ROUTE_TASK_CANCEL = `${ROUTE_PREFIX}/task/cancel`

/** POST ROUTE_PREFIX/dispatch {cli,task,cwd?} — manual dispatch from the card (smoke-test entry). */
export const ROUTE_DISPATCH = `${ROUTE_PREFIX}/dispatch`

/** POST ROUTE_PREFIX/cli/refresh {cli} — re-detect one CLI's install state. */
export const ROUTE_CLI_REFRESH = `${ROUTE_PREFIX}/cli/refresh`

/** POST ROUTE_PREFIX/cli/install {cli} — install (or update) via npm -g. */
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
  readonly models: readonly string[]
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
  readonly startedAt: number
  readonly endedAt?: number
  readonly exitCode?: number
  readonly durationMs?: number
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
