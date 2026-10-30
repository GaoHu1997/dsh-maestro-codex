/**
 * Child-process plumbing shared by the CLI channels and the npm manager:
 * command resolution (Windows `.cmd` shims included), an injectable spawn
 * seam for tests, incremental line streaming, timeout, and abort that kills
 * the whole tree on Windows.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/** The spawn seam: everything a runner needs, injectable for tests. */
export type SpawnFn = (file: string, args: readonly string[], options: SpawnOptionsLike) => ChildProcess

export interface SpawnOptionsLike {
  cwd?: string | undefined
  env?: Record<string, string> | undefined
  /** `pipe` on all three stdios; the runner never inherits. */
  stdio?: readonly ('pipe' | 'ignore')[] | undefined
  windowsHide?: boolean | undefined
  /** Pass the argv through verbatim (the .cmd shim composition requires it). */
  windowsVerbatimArguments?: boolean | undefined
}

/** How a managed child ended. */
export interface ChildOutcome {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  /** Tail of stderr (bounded) for error reporting. */
  readonly stderrTail: string
}

const STDERR_TAIL_LIMIT = 4000

/**
 * Hard cap on one unterminated stdout line. A JSONL record cut at a byte
 * budget is worse than a dropped record: the fragments reach the channel as
 * garbage notes and the run silently loses its result. Only a pathological
 * single line (4M chars) is discarded, with a marker in the stderr tail.
 */
const MAX_LINE_CHARS = 4_000_000

export const systemSpawn: SpawnFn = (file, args, options) => spawn(file, args as string[], {
  cwd: options.cwd,
  env: options.env === undefined ? undefined : { ...process.env, ...options.env },
  stdio: (options.stdio ?? ['pipe', 'pipe', 'pipe']) as ('pipe' | 'ignore')[],
  windowsHide: options.windowsHide ?? true,
  windowsVerbatimArguments: options.windowsVerbatimArguments,
})

/**
 * Locate one command on PATH (or use the explicit override). Returns the
 * resolved path, or undefined when nothing usable matched. On Windows Node can
 * only execute `.exe`/`.cmd`/`.bat` targets — the npm sh/ps1 shims are skipped
 * so we never try to spawn a shell script directly.
 */
export async function resolveCommand(name: string, override: string): Promise<string | undefined> {
  const trimmedOverride = override.trim()
  if (trimmedOverride !== '') {
    return existsSync(trimmedOverride) ? trimmedOverride : undefined
  }
  const candidates = await whereAll(name)
  if (candidates.length === 0) return undefined
  if (process.platform !== 'win32') return candidates[0]
  return pickWindowsCandidate(candidates)
}

/** The best executable candidate on Windows: .exe, then .cmd/.bat; sh/ps1 shims are not spawnable. */
export function pickWindowsCandidate(candidates: readonly string[]): string | undefined {
  const exe = candidates.find(candidate => /\.exe$/i.test(candidate))
  if (exe !== undefined) return exe
  const cmd = candidates.find(candidate => /\.(cmd|bat)$/i.test(candidate))
  if (cmd !== undefined) return cmd
  return undefined
}

/** Every PATH hit for one command name, in `where`/`command -v` order. */
export async function whereAll(name: string): Promise<string[]> {
  if (process.platform === 'win32') {
    const out = await execFileText('where.exe', [name])
    return out.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  }
  const out = await execFileText('/bin/sh', ['-c', `command -v ${JSON.stringify(name)}`])
  return out.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
}

function execFileText(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args as string[], { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      // where.exe exits 1 on "no match" — treat any stdout as the answer.
      if (error !== undefined && stdout === '') {
        rejectPromise(error)
        return
      }
      resolvePromise(stdout)
    })
  })
}

/**
 * Quote one argument for a Windows `cmd.exe /c` command line. Doubles the
 * embedded quotes and wraps the whole token — the cmd shim convention npm's
 * `.cmd` launchers rely on.
 */
export function windowsQuote(token: string): string {
  if (token !== '' && !/[\s"^&|<>()%!]/.test(token)) return token
  return `"${token.replaceAll('"', '""')}"`
}

/**
 * Launch plan for a resolved command. Node refuses to spawn `.cmd`/`.bat`
 * files directly, and its default argv quoting breaks the cmd.exe wrapper
 * (the whole line ends up as one command name). The working composition —
 * verified against a spaced directory on zh-CN Windows — is a verbatim
 * argument of the shape `""file" arg1 "arg two""` handed to `cmd /d /s /c`.
 */
export interface LaunchPlan {
  file: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

export function launchPlan(file: string, args: readonly string[]): LaunchPlan {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const line = `""${file}" ${args.map(windowsQuote).join(' ')}"`
    return {
      file: `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\cmd.exe`,
      args: ['/d', '/s', '/c', line],
      windowsVerbatimArguments: true,
    }
  }
  return { file, args: args as string[] }
}

/**
 * Spawn one child through the resolved launch target and stream its stdout
 * line by line. The prompt reaches the CLI over stdin, so no argument ever
 * carries task text (no quoting surface, no length limit).
 *
 * Abort semantics: `signal` kills the tree immediately (taskkill /T /F on
 * Windows after a short grace kill), `timeoutMs` does the same and reports
 * `timedOut`.
 */
export function runProcess(options: {
  spawnFn?: SpawnFn
  file: string
  args: readonly string[]
  cwd?: string | undefined
  env?: Record<string, string> | undefined
  stdin?: string | undefined
  timeoutMs: number
  signal: AbortSignal
  onStdoutLine?: ((line: string) => void) | undefined
  onStderrLine?: ((line: string) => void) | undefined
}): { child: ChildProcess; outcome: Promise<ChildOutcome> } {
  const spawnFn = options.spawnFn ?? systemSpawn
  const launch = launchPlan(options.file, options.args)
  const child = spawnFn(launch.file, launch.args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(launch.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: launch.windowsVerbatimArguments }),
  })

  let timedOut = false
  let settled = false
  let stderrTail = ''
  const timer = setTimeout(() => {
    timedOut = true
    void killTree(child)
  }, options.timeoutMs)

  const abort = (): void => { void killTree(child) }
  if (options.signal.aborted) abort()
  else options.signal.addEventListener('abort', abort, { once: true })

  if (child.stdin !== null) {
    // EPIPE when the child exits before the pipe closes — the exit code
    // carries the failure; an unhandled 'error' here would kill the host.
    child.stdin.on('error', () => { /* ignored */ })
    if (options.stdin !== undefined) child.stdin.end(options.stdin)
    else child.stdin.end()
  }

  const wire = (stream: NodeJS.ReadableStream | null, onLine: ((line: string) => void) | undefined, isStderr: boolean): void => {
    if (stream === null || onLine === undefined) {
      if (stream !== null && isStderr) {
        stream.on('data', (chunk: Buffer) => { stderrTail = appendTail(stderrTail, chunk.toString('utf8')) })
      }
      return
    }
    let buffer = ''
    stream.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (isStderr) stderrTail = appendTail(stderrTail, text)
      buffer += text
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line !== '') onLine(line)
        index = buffer.indexOf('\n')
      }
      // A final line without a newline still matters (progress bars, final result).
      // Wait for the newline however long the line gets — cutting it here would
      // corrupt a JSONL record. Only a pathological line is dropped.
      if (buffer.length > MAX_LINE_CHARS) {
        stderrTail = appendTail(stderrTail, `\n[maestro] dropped an oversized line (${buffer.length} chars, no newline)`)
        buffer = ''
      }
    })
    stream.on('end', () => {
      const rest = buffer.replace(/\r$/, '')
      if (rest.trim() !== '' && onLine !== undefined) {
        if (rest.length > MAX_LINE_CHARS) {
          stderrTail = appendTail(stderrTail, `\n[maestro] dropped an oversized final line (${rest.length} chars)`)
        } else {
          onLine(rest)
        }
      }
    })
    // A stdio pipe error with no listener is an uncaught exception — the host
    // must survive the child; the close event still settles the outcome.
    stream.on('error', (error: Error) => {
      stderrTail = appendTail(stderrTail, `\n[maestro] ${isStderr ? 'stderr' : 'stdout'} stream error: ${error.message}`)
    })
  }
  wire(child.stdout, options.onStdoutLine, false)
  wire(child.stderr, options.onStderrLine, true)

  const outcome = new Promise<ChildOutcome>((resolvePromise) => {
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal.removeEventListener('abort', abort)
      resolvePromise({ code, signal, timedOut, stderrTail })
    }
    child.on('error', (error) => {
      settle(null, null)
      // Surface spawn failures (ENOENT, access denied) through the exit path:
      // encode them into the stderr tail the caller reports.
      stderrTail = appendTail(stderrTail, String(error instanceof Error ? error.message : error))
      ;(child as ChildProcess & { __spawnError?: string }).__spawnError = stderrTail
    })
    child.on('close', (code, signal) => settle(code, signal))
  })

  return { child, outcome: outcome.then(result => ({
    ...result,
    stderrTail: (child as ChildProcess & { __spawnError?: string }).__spawnError ?? result.stderrTail,
  })) }
}

function appendTail(current: string, addition: string): string {
  const next = (current + addition).slice(-STDERR_TAIL_LIMIT)
  return next
}

/**
 * Kill one child and its whole tree. Order matters: `taskkill /T /F` FIRST —
 * a plain `kill` only terminates the direct child, and on a .cmd shim tree the
 * orphaned grandchildren keep the stdio pipes open (the runner's `close` never
 * fires, so the task never settles). The plain kill is the non-Windows and
 * fallback path.
 */
export async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  if (process.platform === 'win32' && typeof pid === 'number') {
    await new Promise<void>((resolvePromise) => {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, () => resolvePromise())
    })
  }
  try {
    child.kill('SIGTERM')
  } catch { /* already dead */ }
}
