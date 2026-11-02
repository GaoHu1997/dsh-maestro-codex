/**
 * The in-memory task registry: every dispatched CLI run (and every npm
 * install/update/uninstall job) becomes one task with a bounded event log the
 * browser card polls. Tasks live for the host process lifetime; the registry
 * prunes the oldest finished tasks past the cap.
 */

import type { MaestroCliId, MaestroPhase, MaestroResultState, MaestroTaskEvent, MaestroTaskResult, MaestroTaskSummary } from './wire.js'
import { cleanLogText, MAESTRO_EVENT_KINDS, TERMINAL_PHASES, tokenUsageOfStats } from './wire.js'
import { fallbackResult, stageOf } from './stage.js'

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
  readonly kind: 'cli' | 'npm'
  readonly title: string
  /** The full task text (the session page's user message); title is a truncated echo. */
  prompt: string | undefined
  readonly cwd: string | undefined
  /** The CLI model actually handed to the child; updated once the route resolves. */
  model: string
  /** The session (agent) that owns this task; undefined for owner-less jobs
   * (npm installs), which stay visible in every session's board. */
  readonly sessionId: string | undefined
  /** The task this one continues (a session-page reply); undefined = a root turn. */
  readonly replyTo: string | undefined
  phase: MaestroPhase
  startedAt: number
  endedAt: number | undefined
  exitCode: number | undefined
  error: string | undefined
  finalText: string | undefined
  stats: Record<string, string | number | boolean> | undefined
  /**
   * Running usage snapshot, replaced frame by frame while the CLI streams.
   *
   * Deliberately separate from `stats`: `stats` is the settled record (and
   * `accumulateAttemptStats` sums retries into it), so writing live numbers
   * there would double-count them the moment the run settles. The summary
   * falls back to this only while `stats` is still undefined.
   */
  liveStats: Record<string, string | number | boolean> | undefined
  /**
   * 结构化收尾（协议行解析结果）。`undefined` = 还没有结论，摘要里按 phase
   * 兜底推导；`setResult` 只在真读到协议行时写入，绝不从日志里猜。
   */
  result: MaestroTaskResult | undefined
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
  /** Synchronous reservation shared by every entry point and history anchor. */
  private readonly resumes = new Set<string>()

  resumeBusy(cli: MaestroCliId, sessionRef: string): boolean {
    return this.resumes.has(JSON.stringify([cli, sessionRef])) || this.list().some(task =>
      task.cli === cli && task.sessionRef === sessionRef && !isTerminalPhase(task.phase))
  }

  claimResume(cli: MaestroCliId, sessionRef: string): () => void {
    const key = JSON.stringify([cli, sessionRef])
    if (this.resumeBusy(cli, sessionRef)) throw new Error('同一 CLI 会话已有续接正在执行，请等待结束')
    this.resumes.add(key)
    return () => { this.resumes.delete(key) }
  }

  /** Create one task; returns the record for the runner to update. */
  create(input: {
    id: string
    cli: MaestroCliId
    kind?: 'cli' | 'npm'
    title: string
    cwd?: string | undefined
    model: string
    sessionId?: string | undefined
    prompt?: string | undefined
    replyTo?: string | undefined
    /** 起始阶段：正常派发是 `queued`，启动恢复直接用 `interrupted`。 */
    phase?: MaestroPhase | undefined
    /** 恢复任务的说明（写进事件流，人能看到"这不是它自己失败的"）。 */
    note?: string | undefined
  }): MaestroTask {
    const task: MaestroTask = {
      id: input.id,
      cli: input.cli,
      kind: input.kind ?? 'cli',
      title: input.title,
      prompt: input.prompt,
      cwd: input.cwd,
      model: input.model,
      sessionId: input.sessionId,
      replyTo: input.replyTo,
      phase: input.phase ?? 'queued',
      startedAt: Date.now(),
      endedAt: input.phase !== undefined && isTerminalPhase(input.phase) ? Date.now() : undefined,
      exitCode: undefined,
      error: undefined,
      finalText: undefined,
      stats: undefined,
      liveStats: undefined,
      result: undefined,
      events: [],
      cursor: 0,
      truncated: false,
    }
    this.tasks.set(task.id, task)
    this.push(task, 'phase', input.note ?? '已创建，等待调度')
    this.prune()
    return task
  }

  /** Append one event; the ring keeps the newest EVENTS_CAP entries. */
  push(task: MaestroTask, kind: MaestroTaskEvent['kind'], text: string, detail?: string): MaestroTaskEvent {
    // Terminal escape sequences would render as mojibake in the browser log.
    const cleaned = cleanLogText(text)
    const trimmed = cleaned.length > 4000 ? `${cleaned.slice(0, 4000)}…` : cleaned
    const cleanDetail = detail === undefined ? undefined : cleanLogText(detail)
    const trimmedDetail = cleanDetail === undefined || cleanDetail.length <= 4000 ? cleanDetail : `${cleanDetail.slice(0, 4000)}…`
    if (cleaned.length > 4000 || (cleanDetail?.length ?? 0) > 4000) task.truncated = true
    task.cursor += 1
    const event: MaestroTaskEvent = { seq: task.cursor, at: Date.now(), kind, text: trimmed, ...(trimmedDetail === undefined ? {} : { detail: trimmedDetail }) }
    task.events.push(event)
    if (task.events.length > EVENTS_CAP) {
      task.events.splice(0, task.events.length - EVENTS_CAP)
      task.truncated = true
    }
    return event
  }

  /** Replays one persisted event verbatim (seq/at preserved; ring still capped). */
  private replay(task: MaestroTask, seq: number, at: number, kind: MaestroTaskEvent['kind'], text: string, detail?: string): void {
    const cleaned = cleanLogText(text)
    const trimmed = cleaned.length > 4000 ? `${cleaned.slice(0, 4000)}…` : cleaned
    const cleanDetail = detail === undefined ? undefined : cleanLogText(detail)
    const trimmedDetail = cleanDetail === undefined || cleanDetail.length <= 4000 ? cleanDetail : `${cleanDetail.slice(0, 4000)}…`
    if (cleaned.length > 4000 || (cleanDetail?.length ?? 0) > 4000) task.truncated = true
    // 非连续 seq（手改/截断的历史文件）也要让游标越过它们，否则续读会重复投递。
    task.cursor = Math.max(task.cursor, seq)
    task.events.push({ seq, at, kind, text: trimmed, ...(trimmedDetail === undefined ? {} : { detail: trimmedDetail }) })
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
   * Replace the running usage snapshot (called on every CLI frame that carries
   * counts). The object is copied so a channel reusing its own accumulator
   * cannot mutate what the board already rendered.
   */
  setLiveStats(task: MaestroTask, stats: Record<string, string | number | boolean>): void {
    task.liveStats = { ...stats }
  }

  /**
   * 记录结构化收尾。只由 `result-protocol.parseResultLine` 的成功结果调用——
   * 摘要里那条兜底不写进 task，因为它随 phase 变化，存下来会过期。
   */
  setResult(task: MaestroTask, result: MaestroTaskResult): void {
    task.result = result
  }

  /**
   * Seed one finished task from a persisted record (boot-time history, see
   * `persist.ts`). Skips live phases, duplicate ids and empty records; restored
   * tasks age out through the normal prune once live dispatches fill the cap.
   */
  restore(record: {
    id: string
    cli: MaestroCliId
    kind?: 'cli' | 'npm' | undefined
    title: string
    prompt?: string | undefined
    cwd?: string | undefined
    model?: string | undefined
    sessionId?: string | undefined
    replyTo?: string | undefined
    phase: MaestroPhase
    startedAt: number
    endedAt?: number | undefined
    exitCode?: number | undefined
    error?: string | undefined
    finalText?: string | undefined
    stats?: Record<string, string | number | boolean> | undefined
    result?: MaestroTaskResult | undefined
    truncated?: boolean | undefined
    events?: readonly MaestroTaskEvent[] | undefined
  }): MaestroTask | undefined {
    if (!isTerminalPhase(record.phase)) return undefined
    if (this.tasks.has(record.id)) return undefined
    const task: MaestroTask = {
      id: record.id,
      cli: record.cli,
      kind: record.kind === 'npm' ? 'npm' : 'cli',
      title: record.title,
      prompt: record.prompt,
      cwd: record.cwd,
      model: record.model ?? '',
      sessionId: record.sessionId,
      replyTo: record.replyTo,
      phase: record.phase,
      startedAt: record.startedAt,
      endedAt: record.endedAt ?? record.startedAt,
      exitCode: record.exitCode,
      error: record.error,
      finalText: record.finalText,
      stats: record.stats,
      liveStats: undefined,
      result: record.result,
      events: [],
      cursor: 0,
      truncated: record.truncated === true,
    }
    for (const event of record.events ?? []) {
      // 回放的是磁盘上可能被动过的 JSON：seq/at/kind/text/detail 全部校验，坏行跳过。
      if (typeof event?.seq !== 'number' || !Number.isInteger(event.seq) || event.seq <= 0) continue
      if (typeof event.text !== 'string') continue
      if (!(MAESTRO_EVENT_KINDS as readonly string[]).includes(event.kind)) continue
      if (event.detail !== undefined && typeof event.detail !== 'string') continue
      // 原始时间戳必须保留：重置为 now 会让重启后的历史时间线全部挤在启动一刻。
      const at = typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : record.startedAt
      this.replay(task, event.seq, at, event.kind, event.text, event.detail)
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
    // A retry's live snapshot belongs to a NEW attempt. Add it to previous
    // settled attempts; do not let an old partial settlement hide new spend.
    const visibleStats = { ...task.stats, ...task.liveStats }
    if (!isTerminalPhase(task.phase)) {
      for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteTokens'] as const) {
        const settled = task.stats?.[key]
        const live = task.liveStats?.[key]
        const settledKnown = typeof settled === 'number' && Number.isFinite(settled) && settled >= 0
        const liveKnown = typeof live === 'number' && Number.isFinite(live) && live >= 0
        if (settledKnown && liveKnown) visibleStats[key] = settled + live
        if (task.liveStats !== undefined && !liveKnown) visibleStats[`usagePartial_${key}`] = true
      }
    }
    const usage = tokenUsageOfStats(isTerminalPhase(task.phase) ? task.stats : visibleStats)
    // The runner records the CLI session reference inside the extensible stats
    // contract (`stats.sessionRef`, persisted with the rest of the stats); the
    // session page resumes through it.
    const sessionRef = typeof task.stats?.['sessionRef'] === 'string' ? task.stats['sessionRef'] : ''
    // 收尾只在摘要里算，不写回 task：兜底值随 phase 变化，存下来会变成过期结论。
    const result = task.result ?? fallbackResult(task.phase)
    // npm 作业是"装/升级 CLI"：跑完就结束，没有人要验收什么。
    const stage = task.kind === 'npm' && result.state === 'ready' ? 'idle' : stageOf({ phase: task.phase, result })
    return {
      id: task.id,
      cli: task.cli,
      kind: task.kind,
      title: task.title,
      ...(task.prompt === undefined || task.prompt === ''
        ? {}
        // 与旧 title 同一条规则：压平截 80 字。标题改成任务名后，截断的完整
        // 输入挪到这里，看板把它画成节点描述行。
        : { inputPreview: task.prompt.replace(/\s+/g, ' ').slice(0, 80) }),
      phase: task.phase,
      stage,
      result,
      model: task.model,
      ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
      startedAt: task.startedAt,
      ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
      ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
      ...(task.endedAt === undefined ? {} : { durationMs: task.endedAt - task.startedAt }),
      ...(usage === undefined ? {} : { usage }),
      ...(sessionRef === '' ? {} : { sessionRef }),
      ...(task.replyTo === undefined || task.replyTo === '' ? {} : { replyTo: task.replyTo }),
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

/** 排队优先级：人的消息（续接回复）优先于机器发起的新任务。 */
export type LimiterPriority = 'normal' | 'human'

/**
 * Semaphore over the configured concurrency: dispatches wait their turn, and
 * a caller aborting while queued leaves the queue without starting a child.
 *
 * 人的消息（看板/页面上回的一句话）走 `priority: 'human'`：它插在所有普通
 * 派发前面，并且允许在普通任务占满槽位时多占一个溢出槽。理由很实际——一个
 * 跑满 8 个长任务的机器上，人会因为"排队等 8 个任务跑完"而拿不到回答，而人
 * 等的是十几秒的续接，机器等的是分钟级的批处理。溢出只给 1 个槽，不允许人把
 * 并发彻底顶穿。
 */
export class Limiter {
  private active = 0
  private readonly queue: Array<() => void> = []
  private readonly humanQueue: Array<() => void> = []
  private recheck: NodeJS.Timeout | undefined

  constructor(
    private readonly limit: () => number,
    /** 人的消息可额外占用的槽位数（0 = 不溢出）。 */
    private readonly humanOverflow = 1,
  ) {}

  /** 当前在跑的数量（诊断/测试用）。 */
  activeCount(): number {
    return this.active
  }

  /** 排队等待的数量（诊断/测试用）。 */
  waitingCount(): number {
    return this.queue.length + this.humanQueue.length
  }

  /** @returns the awaitable grant plus the release handle (`release` after the run). */
  acquire(signal: AbortSignal, options?: { readonly priority?: LimiterPriority | undefined }): { waited: Promise<void>; release: () => void } {
    if (signal.aborted) {
      const reason = signal.reason instanceof Error ? signal.reason : new Error('aborted while queued')
      return { waited: Promise.reject(reason), release: () => {} }
    }
    const priority: LimiterPriority = options?.priority ?? 'normal'
    const lane = priority === 'human' ? this.humanQueue : this.queue
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
        const index = lane.indexOf(start)
        if (index >= 0) {
          lane.splice(index, 1)
          if (this.queue.length === 0 && this.humanQueue.length === 0) this.stopRecheck()
          rejectPromise(signal.reason instanceof Error ? signal.reason : new Error('aborted while queued'))
        }
        // Already granted: nothing to unwind here; the runner observes the signal.
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (this.grantNow(priority)) start()
      else lane.push(start)
      // 上限可能在排队期间被调大（配置页热改并发数）：新 acquire 顺手放行
      // 已排队的等待者，不必等某次 release 才 pump。
      this.pump()
    })
    return { waited, release: () => { if (release !== undefined) release() } }
  }

  /** 这次 acquire 能否立刻开跑（人的优先级插队、且允许溢出槽）。 */
  private grantNow(priority: LimiterPriority): boolean {
    const capacity = Math.max(1, this.limit())
    if (priority === 'human') {
      // 人已经在排队时，轮到谁先来后到按 humanQueue 处理；此处只看槽位。
      return this.active < capacity + Math.max(0, this.humanOverflow)
    }
    // 普通任务不抢在排队的人前面。
    return this.active < capacity && this.humanQueue.length === 0
  }

  private pump(): void {
    const capacity = Math.max(1, this.limit())
    // 先放人：人的消息优先于一切机器发起的新任务。
    while (this.humanQueue.length > 0 && this.active < capacity + Math.max(0, this.humanOverflow)) {
      const start = this.humanQueue.shift()
      if (start === undefined) break
      start()
    }
    while (this.queue.length > 0 && this.active < capacity && this.humanQueue.length === 0) {
      const start = this.queue.shift()
      if (start === undefined) break
      start()
    }
    // 队列非空但槽位仍满：上限是读配置的函数，没有变更推送——只在有人排队时
    // 低频复查，调大上限后无需等到某次 release / 新派发才放行。
    if (this.queue.length > 0 || this.humanQueue.length > 0) this.armRecheck()
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
