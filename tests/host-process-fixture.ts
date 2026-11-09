import { execFile, type ChildProcess, type ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { promisify } from 'node:util'

const execHost = promisify(execFile)

export interface HostProcessOptions extends Omit<ExecFileOptionsWithStringEncoding, 'encoding'> {
  input: string
  /** Bound cleanup after requesting termination of this child only. */
  cleanupGraceMs?: number
  /** Observe the real child; never supplies a replacement process. */
  onChild?: (child: ChildProcess) => void
}

export interface HostProcessResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signalCode: NodeJS.Signals | null
}

/** Test-only host launch: a settlement is not observable until this child's close. */
export async function runHostProcess(command: string, args: readonly string[], options: HostProcessOptions): Promise<HostProcessResult> {
  const { input, onChild, cleanupGraceMs = 1_000, ...execOptions } = options
  if (!Number.isFinite(cleanupGraceMs) || cleanupGraceMs < 0) throw new RangeError('invalid host cleanup grace')
  const output = execHost(command, [...args], { ...execOptions, encoding: 'utf8' })
  const child = output.child
  let hasClosed = false
  // Bind before hooks, input writes, errors and all termination requests.
  const closed = new Promise<void>(resolve => child.once('close', () => { hasClosed = true; resolve() }))
  let failed = false
  let firstError: unknown
  const remember = (error: unknown) => { if (!failed) { failed = true; firstError = error } }
  // Observe launch errors synchronously, before promise microtasks or derivative EPIPE.
  child.once('error', remember)
  const completion = output.catch((error: unknown) => { remember(error); throw error })
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let forceTimer: ReturnType<typeof setTimeout> | undefined
  let stdinFailure: ((error: Error) => void) | undefined
  const stdin = child.stdin
  const killOwnChild = (signal: NodeJS.Signals) => {
    if (!hasClosed) { try { child.kill(signal) } catch { /* Cleanup errors must not replace the first failure. */ } }
  }
  try {
    // execFile owns the original timeout/error; this timer only bounds termination.
    if (execOptions.timeout !== undefined && execOptions.timeout > 0) {
      deadlineTimer = setTimeout(() => killOwnChild('SIGKILL'), execOptions.timeout + cleanupGraceMs)
    }
    onChild?.(child)
    if (!stdin) throw new Error('host stdin unavailable')
    const inputWritten = new Promise<void>((resolve, reject) => {
      // Both writable failure surfaces converge here; kill/reap happens in catch.
      const fail = (error: Error) => { remember(error); reject(error) }
      stdinFailure = fail
      stdin.once('error', fail)
      stdin.end(input, (error?: Error | null) => { if (error) fail(error); else resolve() })
    })
    const [result] = await Promise.all([completion, inputWritten])
    await closed
    if (failed) throw firstError
    // A graceful exit after execFile's timeout signal must not become success.
    if (child.killed) throw Object.assign(new Error('host process terminated before completion'), { code: 'HOST_PROCESS_TERMINATED' })
    return { ...result, exitCode: child.exitCode, signalCode: child.signalCode }
  } catch (error) {
    remember(error)
    if (!hasClosed) {
      killOwnChild('SIGTERM')
      forceTimer = setTimeout(() => killOwnChild('SIGKILL'), cleanupGraceMs)
    }
    // Also consume a later execFile rejection; successful stdout never replaces firstError.
    await Promise.allSettled([completion, closed])
    throw firstError
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    if (forceTimer !== undefined) clearTimeout(forceTimer)
    if (stdinFailure !== undefined) stdin?.removeListener('error', stdinFailure)
    child.removeListener('error', remember)
  }
}
