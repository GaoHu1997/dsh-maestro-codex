/**
 * Reconnect/retry noise is output, but it is not progress.
 *
 * Every CLI channel runs the child under a byte-idle watchdog: any non-empty
 * stdout/stderr chunk restarts the no-output timer. A CLI stuck on a broken
 * upstream keeps printing `Reconnecting...` / `Retrying...` diagnostics every
 * few minutes, so the watchdog never fires even though the task does no work —
 * it hangs until a human cancels (that is exactly what happened to the ER run).
 *
 * This budget gives the recovery its own clock: the first recognised reconnect
 * diagnostic starts one deadline, repeated noise does not extend it, and a
 * productive protocol frame clears it so a genuinely recovered run keeps its
 * full idle protection.
 */

/** Diagnostics a CLI prints while re-establishing its upstream connection. */
const RECOVERY_DIAGNOSTIC = /reconnect|retrying?|\bretry\b|econnreset|socket hang up|network error|connection (?:failed|reset|closed|refused)/i

export interface RecoveryBudget {
  /** Caller cancellation + this budget's own deadline, for `runProcess`. */
  readonly signal: AbortSignal
  /** True once the recovery window expired and the run was asked to stop. */
  readonly timedOut: boolean
  /** Feed one diagnostic line (stderr or non-protocol stdout). */
  observeDiagnostic(line: string): void
  /** A real protocol frame arrived: the CLI is making progress; disarm. */
  markProgress(): void
  /** Release timers/listeners. */
  dispose(): void
}

export function createRecoveryBudget(callerSignal: AbortSignal, timeoutMs: number, onExpire?: () => void): RecoveryBudget {
  const controller = new AbortController()
  const combined = AbortSignal.any([callerSignal, controller.signal])
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  const onCallerAbort = (): void => { clear() }
  if (!callerSignal.aborted) callerSignal.addEventListener('abort', onCallerAbort, { once: true })
  return {
    signal: combined,
    get timedOut(): boolean { return timedOut },
    observeDiagnostic(line: string): void {
      if (timedOut || timer !== undefined || callerSignal.aborted) return
      if (!RECOVERY_DIAGNOSTIC.test(line)) return
      timer = setTimeout(() => {
        timer = undefined
        if (callerSignal.aborted) return
        timedOut = true
        // The caller asked us to stop an unhealthy child; this is a timeout,
        // not a cancellation — the dispatch reports it as such.
        try { onExpire?.() } catch { /* observational only */ }
        controller.abort(new Error('CLI 持续重连超过恢复期限'))
      }, timeoutMs)
    },
    markProgress(): void { clear() },
    dispose(): void {
      clear()
      callerSignal.removeEventListener('abort', onCallerAbort)
    },
  }
}
