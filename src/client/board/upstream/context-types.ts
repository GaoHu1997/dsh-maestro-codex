/** Structural host types selected verbatim from DSH-better-sidebar 0.28.2.
 * Server services and the sidebar activation stay with the host.
 * See source-manifest.json and LICENSE for provenance.
 */
import type { ProcessActivitySummary } from './process-activity.ts'

/** The client session list row the sidebar reads (cwd for the explorer). */
export interface SidebarSessionSummary {
  id: string
  cwd?: string
  displayTitle: string
  /** Coarse durable origin for navigation filtering (subagent children). */
  origin?: 'subagent'
  /** Durable direct parent session id (present on subagent children). */
  parentId?: string
  /** Whether the session's agent is currently running. */
  running?: boolean
}

/** Durable parent/child address that selects subagent transport in the client. */
export interface SidebarSubagentAddress {
  parentSessionId: string
  childSessionId: string
  /** `unknown` keeps a child visible without claiming continuation support. */
  mode: 'one-shot' | 'continuable' | 'unknown'
}

/** Lifecycle status set of one background job (closed wire union). */
export type SidebarJobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/**
 * One tree child's live view as the `subagents.live` route reports it: the
 * catalog's activity flag plus the fold of the child's newest process range
 * (see ./process-activity.ts).
 *
 * `running` is the catalog's flag and is therefore always present on a CHILD
 * row; the fold's fields are optional. The route used to report running
 * children only, so "absent from the map" meant "not running" — a reading that
 * cannot survive a route which also reports settled children's summaries.
 */
export interface SidebarChildLiveView {
  /**
   * The catalog's activity flag. Present on every CHILD row; ABSENT on the
   * topology root, which the host cannot classify (the caller already knows
   * its session's running state from the session list).
   */
  running?: boolean
  /** The child's newest assistant text (the card's detail line). */
  text?: string
  /** The newest range's merged activity; absent when that range called nothing. */
  summary?: ProcessActivitySummary
  /** Epoch ms of the newest event observed. */
  lastEventTime?: number
}

/**
 * One background job as the client mirror sees it (wire `JobView` shape:
 * id/kind/label/status/detail?/startedAt/finishedAt?).
 */
export interface SidebarJobView {
  /** Registry-issued `<kind>-N` identity, stable for the job's whole life. */
  id: string
  /** Producer kind (`bash`, `pwsh`, `subagent`, …; open string by design). */
  kind: string
  /** Producer-supplied one-line label: the command, or the delegation description. */
  label: string
  /**
   * Owning session; absent for an unowned job, which every caller can see.
   * The client service's roster is keyed by WATCHED session, so this is what
   * tells a row whether it belongs to the tree on screen.
   */
  owner?: string
  /** Current lifecycle state. */
  status: SidebarJobStatus
  /** The producer's live progress line ('3/10'), cleared at settlement. */
  progress?: string
  /** Kind-specific status detail ('exit code: 3'), present once supplied. */
  detail?: string
  /** Epoch ms when the job was registered. */
  startedAt: number
  /** Epoch ms when the job settled; absent while live. */
  finishedAt?: number
}

/**
 * The host jobs registry face the sidebar routes touch (structural mirror of
 * `JobRegistry`).
 *
 * DSH 0.1.7 moved the access fence from the live `Agent` to the reading
 * session id: `caller` is a `SessionId` string on every member. The plugin no
 * longer needs `ctx.agents` in order to call the registry, and the Tasks page
 * reads `list` through the plugin's own `jobs.list` route (the client session
 * snapshot stopped mirroring background jobs in the same release).
 */
/**
 * One job's retained output as the HOST's client service observes it
 * (mirror of `@deepseek-ai/dsh-api-job-controller/client`'s observed entry).
 * `gapBefore` marks output the observer missed between frames; `error` carries
 * a producer-side failure; `streaming` is true while the job still writes.
 */
export interface SidebarObservedJob {
  text: string
  gapBefore: boolean
  streaming: boolean
  error?: string
}

/** The host client jobs service's snapshot (roster by session + observations). */
export interface SidebarJobsSnapshot {
  /** Whole-set roster per WATCHED session: empty arrays are how a session ends. */
  rows: Record<string, SidebarJobView[]>
  /** Retained output per observed job id. */
  observed: Record<string, SidebarObservedJob | undefined>
}

/**
 * The host's CLIENT jobs service (`ctx.jobs`, mounted by the web profile's
 * `@deepseek-ai/dsh-api-job-controller/client`), structurally mirrored: the
 * plugin never imports the host package.
 *
 * It replaces the plugin's own three-route jobs transport: `watchRows` keeps
 * one session's roster current as a push stream, `observe` streams a job's
 * retained output WITHOUT moving the model's consuming cursor, and `kill` is
 * the same registry admission the old route forwarded.
 */
export interface SidebarClientJobsService {
  state: {
    getSnapshot(): SidebarJobsSnapshot
    subscribe(listener: () => void): () => void
  }
  /** Watch one session's roster; returns the release function (ref-counted). */
  watchRows(sessionId: string): () => void
  /**
   * Observe one job's output; returns the release function. `sessionId` may be
   * undefined for a job whose owner the roster has not resolved yet.
   */
  observe(sessionId: string | undefined, jobId: string): () => void
  /** Request cancellation of one job (owned by `sessionId`). */
  kill(sessionId: string, jobId: string): Promise<void>
}

/**
 * One durable roster row of the Lead Session's `agentTeam` projection. Phase
 * is the DURABLE lifecycle (the Lead row is always `active`); turn activity is
 * overlaid from the session's own status (see ./client/team-projection.ts).
 */
export interface SidebarTeamMemberProjection {
  /** The member's session id (the teammate's child session under the lead). */
  id: string
  name: string
  role: 'lead' | 'teammate'
  phase: 'provisioning' | 'active' | 'failed'
  /** The provisioning failure, when the durable row records one. */
  error?: string
}

/**
 * The Lead Session's published team state: durable roster identities and
 * phases, member errors, the non-deleted task views (0.1.6's `TeamView` shape,
 * enriched per task exactly like the service's own views), and the first
 * rejected Team record when the board had to stop at its last valid state.
 */
export interface SidebarTeamProjection {
  members: readonly SidebarTeamMemberProjection[]
  tasks: readonly SidebarTeamTaskView[]
  failure?: string
}

/** One shared task-board row (durable fields plus derived readiness). */
export interface SidebarTeamTaskView {
  id: string
  revision: number
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  ownerName?: string
  blockedBy: string[]
  writeScopes: string[]
  ready: boolean
  writeScopeWarnings: string[]
}

/** The client session list snapshot the sidebar subscribes to. */
export interface SidebarSessionList {
  byId: Record<string, SidebarSessionSummary>
  /**
   * Host-computed projection values per session (DSH 0.1.7). The only field
   * this plugin reads is `subagentCatalog`, the direct-child list the 0.1.6
   * runtime published as `subagentsByParent`.
   *
   * Three facts the 0.1.6 snapshot carried are gone and must not be brought
   * back: there is no `current` session id (`ctx.sidebarRight.mounted` is the
   * sanctioned feed for "which session's seat is on screen"), there is no
   * background-jobs mirror (the `jobs.list` route reads the registry itself),
   * and there is no per-parent observe handshake — 0.1.7 loads every session's
   * projections once per connection, so a catalog surface reads them instead
   * of observing and unobserving (0.1.6's `setSubagentCatalogOpen` is deleted,
   * not renamed).
   */
  projectionsBySession?: Readonly<Record<string, SidebarProjectionSnapshot>>
}

/** One session's projection values, as the client snapshot publishes them. */
export interface SidebarProjectionSnapshot {
  values: {
    subagentCatalog?: readonly SidebarSubagentCatalogEntry[]
    /** The Lead Session's team board (only the team's Lead carries one). */
    agentTeam?: SidebarTeamProjection
    /** Provider-reported token usage, accumulated over the session's log. */
    tokenUsage?: SidebarTokenUsage
    /** Turn timing of a descriptor-backed CHILD session (see ./session-metrics.ts). */
    subagentTiming?: SidebarSubagentTiming
  }
  state: 'idle' | 'loading' | 'ready' | 'error'
  error: { code?: string; message?: string } | null
}

/**
 * The host's `tokenUsage` projection: provider-reported usage accumulated over
 * the session's whole durable log, in four DISJOINT buckets (`uncachedInputTokens`
 * is what the provider billed at full price; reasoning tokens are already inside
 * `outputTokens`). It is a SESSION total, not a per-turn figure.
 */
export interface SidebarTokenUsage {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * The host's `subagentTiming` projection: how long a descriptor-backed child
 * session actually worked.
 *
 * Neither half is a session AGE. `settledMs` sums CLOSED turn durations and is
 * 0 until the child's first `turn/end`; `active` exists only while an open turn
 * is running, and a session with no `subagent/descriptor` — the topology ROOT,
 * any ordinary session — never gets one at all.
 */
export interface SidebarSubagentTiming {
  settledMs: number
  /** The open turn: `since` = its `turn/start` time, `through` = the newest folded event. */
  active?: { since: number; through: number }
}

/** One direct-child row of the host's `subagentCatalog` projection. */
export interface SidebarSubagentCatalogEntry {
  /** Child session id (`childId` in the durable event). */
  id: string
  /** Epoch ms the child was created. */
  createdAt: number
  /** `unknown` keeps a child visible without claiming continuation support. */
  mode: 'one-shot' | 'continuable' | 'unknown'
  /** Mode-specific label; continuable children always carry one. */
  label?: string
}

/** Minimal structural mirror of one session event (the subagent history tail). */
export interface SidebarSessionEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
}

/** Explicit task-markdown adapter; no sidebar explorer service is assumed. */
export interface Context {
  get?(key: string): unknown
  openMarkdownFile?(sessionId: string, destination: string, options?: { line?: number }): void
}
