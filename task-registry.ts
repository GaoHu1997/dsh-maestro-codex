/**
 * The in-memory task registry: every dispatched CLI run (and every npm
 * install/update/uninstall job) becomes one task with a bounded event log the
 * browser card polls. Tasks live for the host process lifetime; the registry
 * prunes the oldest finished tasks past the cap.
 */

import type { MaestroCliId, MaestroPhase, MaestroTaskEvent, MaestroTaskSummary } from './wire.js'
import { TERMINAL_PHASES } from './wire.js'

/** Event ring cap per task — the agent-facing value needs the summary, the UI needs the tail. */
const EVENTS_CAP = 800

/** Finished-task cap before the oldest ones are pruned. */
const TASKS_CAP = 60

export interface MaestroTask {
  readonly id: string
  readonly cli: MaestroCliId
  readonly title: string
  readonly cwd: string | undefined
  readonly model: string
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
  private seq = 0

  /** Create one task; returns the record for the runner to update. */
  create(input: { id: string; cli: MaestroCliId; title: string; cwd?: string; model: string }): MaestroTask {
    const task: MaestroTask = {
      id: input.id,
      cli: input.cli,
      title: input.title,
      cwd: input.cwd,
      model: input.model,
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
    const trimmed = text.length > 4000 ? `${text.slice(0, 4000)}…` : text
    task.cursor += 1
    const event: MaestroTaskEvent = { seq: task.cursor, at: Date.now(), kind, text: trimmed }
    task.events.push(event)
    if (task.events.length > EVENTS_CAP) {
      task.events.splice(0, task.events.length - EVENTS_CAP)
      task.truncated = true
    }
    return event
  }

  /** Transition the phase (and stamp the end on terminal transitions). */
  setPhase(task: MaestroTask, phase: MaestroPhase, note?: string): void {
    task.phase = phase
    if (isTerminalPhase(phase)) {
      task.endedAt = Date.now()
      if (note !== undefined) task.error = note
    }
    this.push(task, 'phase', note ?? `阶段 → ${phase}`)
  }

  get(id: string): MaestroTask | undefined {
    return this.tasks.get(id)
  }

  /** Newest first, finished last within the same phase ordering. */
  list(): MaestroTaskSummary[] {
    return [...this.tasks.values()]
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
      startedAt: task.startedAt,
      ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
      ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
      ...(task.endedAt === undefined ? {} : { durationMs: task.endedAt - task.startedAt }),
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

  /** Best-effort cancel: flips non-terminal tasks and lets runners observe the signal. */
  cancel(id: string, abort: (task: MaestroTask) => void): boolean {
    const task = this.tasks.get(id)
    if (task === undefined || isTerminalPhase(task.phase)) return false
    abort(task)
    return true
  }

  private prune(): void {
    const finished = [...this.tasks.values()].filter(task => isTerminalPhase(task.phase))
    if (this.tasks.size <= TASKS_CAP) return
    const overflow = this.tasks.size - TASKS_CAP
    const removable = finished
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))
      .slice(0, overflow)
    for (const task of removable) this.tasks.delete(task.id)
  }
}

/**
 * Semaphore over the configured concurrency: dispatches wait their turn, and
 * a caller aborting while queued leaves the queue without starting a child.
 */
export class Limiter {
  private active = 0
  private readonly queue: Array<() => void> = []

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
          rejectPromise(signal.reason instanceof Error ? signal.reason : new Error('aborted while queued'))
        }
        // Already granted: nothing to unwind here; the runner observes the signal.
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (this.active < Math.max(1, this.limit())) start()
      else this.queue.push(start)
    })
    return { waited, release: () => { if (release !== undefined) release() } }
  }

  private pump(): void {
    while (this.active < Math.max(1, this.limit())) {
      const start = this.queue.shift()
      if (start === undefined) return
      start()
    }
  }
}
