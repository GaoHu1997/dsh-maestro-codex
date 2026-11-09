/**
 * Bounded awaiting for host-side operations that are not processes.
 *
 * The CLI runners already have a watchdog for the child process itself, but a
 * dispatch also awaits host services (usage journal, effect queue, skill
 * registry, bridged host tools). Those promises have no process to kill: when
 * an implementation ignores its AbortSignal or a filesystem call never settles,
 * the old code waited forever and the tool call never returned — the same
 * symptom as the reconnect bug, one layer up.
 *
 * `awaitWithin` only bounds the wait; it does not claim the underlying work
 * stopped. Callers keep passing the same signal down so cooperative
 * implementations still abort, and late settlements are observed (never
 * rethrown as an unhandled rejection) but discarded.
 */

/** A wait that hit its deadline instead of the work settling by itself. */
export class DeadlineError extends Error {
  readonly timeoutMs: number

  constructor(message: string, timeoutMs: number) {
    super(message)
    this.name = 'DeadlineError'
    this.timeoutMs = timeoutMs
  }
}

export interface AwaitWithinOptions {
  /** Caller cancellation; rejects with the signal's reason exactly like the work would. */
  signal?: AbortSignal | undefined
  /** Upper bound for this wait. Must be a positive, finite number of milliseconds. */
  timeoutMs: number
  /** Human-readable subject used in the timeout message ("用量记账", "bridge 请求"). */
  label?: string | undefined
}

function timeoutError(label: string | undefined, timeoutMs: number): DeadlineError {
  const subject = label === undefined || label === '' ? '操作' : label
  const seconds = Math.max(1, Math.round(timeoutMs / 1000))
  return new DeadlineError(`${subject}在 ${String(seconds)} 秒内没有返回，已停止等待（底层操作可能仍在运行）`, timeoutMs)
}

/**
 * Await `work()` but never longer than `timeoutMs`, and stop early when the
 * signal aborts. `work` is started exactly once, immediately.
 */
export function awaitWithin<T>(work: () => Promise<T>, options: AwaitWithinOptions): Promise<T> {
  const { signal, timeoutMs } = options
  if (signal?.aborted === true) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? '已取消')))
  }
  let started: Promise<T>
  try {
    started = work()
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (onAbort !== undefined && signal !== undefined) {
        signal.removeEventListener('abort', onAbort)
        onAbort = undefined
      }
    }
    const settle = (apply: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      apply()
    }
    // Attached before any timer so a late settlement is always consumed.
    started.then(
      value => { settle(() => resolve(value)) },
      (error: unknown) => { settle(() => reject(error instanceof Error ? error : new Error(String(error)))) },
    )
    timer = setTimeout(() => { settle(() => reject(timeoutError(options.label, timeoutMs))) }, timeoutMs)
    if (signal !== undefined) {
      onAbort = () => {
        settle(() => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? '已取消'))))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    if (settled) cleanup()
  })
}
