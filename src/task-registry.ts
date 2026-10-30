/**
 * The in-memory task registry: every dispatched CLI run (and every npm
 * install/update/uninstall job) becomes one task with a bounded event log the
 * browser card polls. Tasks live for the host process lifetime; the registry
 * prunes the oldest finished tasks past the cap.
 */

import type { MaestroCliId, MaestroPhase, MaestroTaskEvent, MaestroTaskSummary } from './wire.js'
import { cleanLogText, MAESTRO_EVENT_KINDS, TERMINAL_PHASES } from './wire.js'

/** Event ring cap per task — the agent-facing value needs the summary, the UI needs the tail. */
const EVENTS_CAP = 800

/** Terminal phases whose note is a failure reason. `done`/`cancelled` notes are
 * labels ("执行完成") — writing them into `error` made every successful task
 * render the failure banner in the card and the board. */
const FAILURE_PHASES: readonly MaestroPhase[] = ['failed', 'timeout']

/** Finished-task cap before the oldest ones are pruned. */
const TASKS_CAP = 60

export interface MaestroTask {
  readonly id: string
  readonly cli: MaestroCliId
  readonly title: string
  readonly cwd: string | undefined
  /** The CLI model actually handed to the child; updated once the route resolves. */
  model: string
  /** The session (agent) that owns this task; undefined for owner-less jobs
   * (npm installs), which stay visible in every session's board. */
  readonly sessionId: string | undefined
  phase: MaestroPhase
  startedAt: number
  endedAt: number | undefined
  exitCode: number | undefined
  error: string | undefined
  finalText: string | undefined
  stats: Record<string, string | number | boolean> | undefined
  readonly events: MaestroTaskEvent[]
  /** Next event sequence (events are 1-based). */
  cursor: number
  /** Whether a client already consumed events below the ring's floor. */
  truncated: boolean
}

export interface TaskEventsPage {
  readonly task: MaestroTask
  readonly events: readonly MaestroTaskEvent[]
  readonly nextCursor: number
}

export function isTerminalPhase(phase: MaestroPhase): boolean {
  return (TERMINAL_PHASES as readonly string[]).includes(phase)
}

export class TaskRegistry {
  private readonly tasks = new Map<string, MaestroTask>()

  /** Create one task; returns the record for the runner to update. */
  create(input: { id: string; cli: MaestroCliId; title: string; cwd?: string | undefined; model: string; sessionId?: string | undefined }): MaestroTask {
    const task: MaestroTask = {
      id: input.id,
      cli: input.cli,
      title: input.title,
      cwd: input.cwd,
      model: input.model,
      sessionId: input.sessionId,
      phase: 'queued',
      startedAt: Date.now(),
      endedAt: undefined,
      exitCode: undefined,
      error: undefined,
      finalText: undefined,
      stats: undefined,
      events: [],
      cursor: 0,
      truncated: false,
    }
    this.tasks.set(task.id, task)
    this.push(task, 'phase', '已创建，等待调度')
    this.prune()
    return task
  }

  /** Append one event; the ring keeps the newest EVENTS_CAP entries. */
  push(task: MaestroTask, kind: MaestroTaskEvent['kind'], text: string): MaestroTaskEvent {
    // Terminal escape sequences would render as mojibake in the browser log.
    const cleaned = cleanLogText(text)
    const trimmed = cleaned.length > 4000 ? `${cleaned.slice(0, 4000)}…` : cleaned
    task.cursor += 1
    const event: MaestroTaskEvent = { seq: task.cursor, at: Date.now(), kind, text: trimmed }
    task.events.push(event)
    if (task.events.length > EVENTS_CAP) {
      task.events.splice(0, task.events.length - EVENTS_CAP)
      task.truncated = true
    }
    return event
  }

  /** Replays one persisted event verbatim (seq/at preserved; ring still capped). */
  private replay(task: MaestroTask, seq: number, at: number, kind: MaestroTaskEvent['kind'], text: string): void {
    const cleaned = cleanLogText(text)
    const trimmed = cleaned.length > 4000 ? `${cleaned.slice(0, 4000)}…` : cleaned
    // 非连续 seq（手改/截断的历史文件）也要让游标越过它们，否则续读会重复投递。
    task.cursor = Math.max(task.cursor, seq)
    task.events.push({ seq, at, kind, text: trimmed })
    if (task.events.length > EVENTS_CAP) {
      task.events.splice(0, task.events.length - EVENTS_CAP)
      task.truncated = true
    }
  }

  /** Transition the phase (and stamp the end on terminal transitions). */
  setPhase(task: MaestroTask, phase: MaestroPhase, note?: string): void {
    task.phase = phase
    if (isTerminalPhase(phase)) {
      task.endedAt = Date.now()
      // `error` is the failure reason — a failed lookup for the UI's error
      // banner. Success/cancel labels only live in the event trail.
      if (note !== undefined && FAILURE_PHASES.includes(phase)) task.error = note
    }
    this.push(task, 'phase', note ?? `阶段 → ${phase}`)
  }

  /** The route resolved after create(); record the model the child really got. */
  setModel(task: MaestroTask, model: string): void {
    task.model = model
  }

  /**
   * Seed one finished task from a persisted record (boot-time history, see
   * `persist.ts`). Skips live phases, duplicate ids and empty records; restored
   * tasks age out through the normal prune once live dispatches fill the cap.
   */
  restore(record: {
    id: string
    cli: MaestroCliId
    title: string
    cwd?: string | undefined
    model?: string | undefined
    sessionId?: string | undefined
    phase: MaestroPhase
    startedAt: number
    endedAt?: number | undefined
    exitCode?: number | undefined
    error?: string | undefined
    finalText?: string | undefined
    stats?: Record<string, string | number | boolean> | undefined
    truncated?: boolean | undefined
    events?: readonly MaestroTaskEvent[] | undefined
  }): MaestroTask | undefined {
    if (!isTerminalPhase(record.phase)) return undefined
    if (this.tasks.has(record.id)) return undefined
    const task: MaestroTask = {
      id: record.id,
      cli: record.cli,
      title: record.title,
      cwd: record.cwd,
      model: record.model ?? '',
      sessionId: record.sessionId,
      phase: record.phase,
      startedAt: record.startedAt,
      endedAt: record.endedAt ?? record.startedAt,
      exitCode: record.exitCode,
      error: record.error,
      finalText: record.finalText,
      stats: record.stats,
      events: [],
      cursor: 0,
      truncated: record.truncated === true,
    }
    for (const event of record.events ?? []) {
      // 回放的是磁盘上可能被动过的 JSON：seq/at/kind/text 全部校验，坏行跳过。
      if (typeof event?.seq !== 'number' || !Number.isInteger(event.seq) || event.seq <= 0) continue
      if (typeof event.text !== 'string') continue
      if (!(MAESTRO_EVENT_KINDS as readonly string[]).includes(event.kind)) continue
      // 原始时间戳必须保留：重置为 now 会让重启后的历史时间线全部挤在启动一刻。
      const at = typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : record.startedAt
      this.replay(task, event.seq, at, event.kind, event.text)
    }
    if (task.events.length > EVENTS_CAP) {
      task.events.splice(0, task.events.length - EVENTS_CAP)
      task.truncated = true
    }
    this.tasks.set(task.id, task)
    return task
  }

  get(id: string): MaestroTask | undefined {
    return this.tasks.get(id)
  }

  /**
   * Newest first.
   * @param sessions - when given, drops tasks owned by sessions outside the
   * set; owner-less tasks (npm jobs) always stay. Absent = the full list.
   */
  list(sessions?: ReadonlySet<string> | undefined): MaestroTaskSummary[] {
    return [...this.tasks.values()]
      .filter(task => sessions === undefined || task.sessionId === undefined || sessions.has(task.sessionId))
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(task => this.summaryOf(task))
  }

  summaryOf(task: MaestroTask): MaestroTaskSummary {
    return {
      id: task.id,
      cli: task.cli,
      title: task.title,
      phase: task.phase,
      model: task.model,
      ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
      startedAt: task.startedAt,
      ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
      ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
      ...(task.endedAt === undefined ? {} : { durationMs: task.endedAt - task.startedAt }),
      ...(task.truncated ? { truncated: true } : {}),
    }
  }

  /** Events strictly after `cursor` (0 = from the beginning). */
  eventsSince(id: string, cursor: number): TaskEventsPage | undefined {
    const task = this.tasks.get(id)
    if (task === undefined) return undefined
    const safeCursor = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0
    const events = task.events.filter(event => event.seq > safeCursor)
    return { task, events, nextCursor: task.cursor }
  }

  private prune(): void {
    if (this.tasks.size <= TASKS_CAP) return
    const finished = [...this.tasks.values()]
      .filter(task => isTerminalPhase(task.phase))
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))
    const overflow = this.tasks.size - TASKS_CAP
    for (const task of finished.slice(0, overflow)) this.tasks.delete(task.id)
  }
}

/**
 * Semaphore over the configured concurrency: dispatches wait their turn, and
 * a caller aborting while queued leaves the queue without starting a child.
 */
export class Limiter {
  private active = 0
  private readonly queue: Array<() => void> = []
  private recheck: NodeJS.Timeout | undefined

  constructor(private readonly limit: () => number) {}

  /** @returns the awaitable grant plus the release handle (`release` after the run). */
  acquire(signal: AbortSignal): { waited: Promise<void>; release: () => void } {
    if (signal.aborted) {
      const reason = signal.reason instanceof Error ? signal.reason : new Error('aborted while queued')
      return { waited: Promise.reject(reason), release: () => {} }
    }
    let release!: () => void
    const waited = new Promise<void>((resolvePromise, rejectPromise) => {
      let onAbort: (() => void) | undefined
      const start = (): void => {
        if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
        this.active += 1
        release = () => {
          this.active -= 1
          this.pump()
        }
        resolvePromise()
      }
      onAbort = () => {
        const index = this.queue.indexOf(start)
        if (index >= 0) {
          this.queue.splice(index, 1)
          if (this.queue.length === 0) this.stopRecheck()
          rejectPromise(signal.reason instanceof Error ? signal.reason : new Error('aborted while queued'))
        }
        // Already granted: nothing to unwind here; the runner observes the signal.
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (this.active < Math.max(1, this.limit())) start()
      else this.queue.push(start)
      // 上限可能在排队期间被调大（配置页热改并发数）：新 acquire 顺手放行
      // 已排队的等待者，不必等某次 release 才 pump。
      this.pump()
    })
    return { waited, release: () => { if (release !== undefined) release() } }
  }

  private pump(): void {
    while (this.active < Math.max(1, this.limit())) {
      const start = this.queue.shift()
      if (start === undefined) {
        this.stopRecheck()
        return
      }
      start()
    }
    // 队列非空但槽位仍满：上限是读配置的函数，没有变更推送——只在有人排队时
    // 低频复查，调大上限后无需等到某次 release / 新派发才放行。
    if (this.queue.length > 0) this.armRecheck()
  }

  private armRecheck(): void {
    if (this.recheck !== undefined) return
    const timer = setInterval(() => { this.pump() }, 250)
    timer.unref?.()
    this.recheck = timer
  }

  private stopRecheck(): void {
    if (this.recheck === undefined) return
    clearInterval(this.recheck)
    this.recheck = undefined
  }
}
