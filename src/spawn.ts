/**
 * Child-process plumbing shared by the CLI channels and the npm manager:
 * command resolution (Windows `.cmd` shims included), an injectable spawn
 * seam for tests, incremental line streaming, timeout, and abort that kills
 * the whole tree on Windows.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { constants, existsSync, readFileSync } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

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

/** Every PATH hit, without starting where.exe/a shell for each detection. */
export async function whereAll(name: string, options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {}): Promise<string[]> {
  const windows = process.platform === 'win32'
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const envValue = (key: string): string | undefined => windows
    ? Object.entries(env).find(([candidate]) => candidate.toUpperCase() === key)?.[1]
    : env[key]
  const pathValue = envValue('PATH') ?? ''
  const extensions = windows && path.extname(name) === ''
    ? ['', ...new Set((envValue('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').map(value => value.trim()).filter(value => /^\.[a-z0-9]+$/i.test(value)))]
    : ['']
  // where.exe searches cwd first on Windows. Empty PATH entries mean cwd on
  // POSIX; an absent PATH is not an implicit search of the current directory.
  const directories = [
    ...(windows ? [cwd] : []),
    ...(pathValue === '' ? [] : pathValue.split(path.delimiter).map(value => value.trim().replace(/^"(.*)"$/, '$1') || cwd)),
  ]
  const seen = new Set<string>()
  const candidates = directories.flatMap(directory => extensions.map(extension => path.resolve(cwd, directory, `${name}${extension}`)))
    .filter(candidate => {
      const key = windows ? candidate.toLowerCase() : candidate
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  const hits: (string | undefined)[] = candidates.map(() => undefined)
  const search = Promise.all(candidates.map(async (candidate, index) => {
    try {
      if (!(await stat(candidate)).isFile()) return
      if (!windows) await access(candidate, constants.X_OK)
      hits[index] = candidate
    } catch {
      // Missing or inaccessible candidates do not hide other PATH hits.
    }
  }))
  // An offline PATH entry must not discard already-confirmed local hits.
  const timeoutMs = options.timeoutMs ?? 1_000
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const expired = await Promise.race([
      search.then(() => false),
      new Promise<boolean>(resolvePromise => { timer = setTimeout(() => resolvePromise(true), timeoutMs) }),
    ])
    const found = hits.filter((candidate): candidate is string => candidate !== undefined)
    if (expired && found.length === 0) throw new Error(`PATH 查找超时（${timeoutMs}ms）`)
    return found
  } finally {
    clearTimeout(timer)
  }
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

/**
 * npm's Codex shim forwards `%*` through cmd.exe. That extra parse corrupts
 * quotes in TOML overrides containing JSON. Recognize the npm launcher and use
 * its JS entry + Node directly; custom batch launchers retain their semantics.
 */
function codexNodeLaunchPlan(file: string, args: readonly string[]): LaunchPlan | undefined {
  if (path.basename(file).toLowerCase() !== 'codex.cmd') return undefined
  try {
    const shim = readFileSync(file, 'utf8')
    if (!/"%_prog%"\s+"%dp0%[\\/]node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js"\s+%\*\s*$/im.test(shim)
      || !/SET\s+"_prog=node"/i.test(shim)) return undefined
    const dir = path.dirname(path.resolve(file))
    const entry = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if (!existsSync(entry)) return undefined
    const node = path.join(dir, 'node.exe')
    // Match npm's sibling-Node preference and PATH fallback. Do not use
    // process.execPath: in the desktop host that is the Electron application.
    return { file: existsSync(node) ? node : 'node.exe', args: [entry, ...args] }
  } catch {
    return undefined
  }
}

export function launchPlan(file: string, args: readonly string[]): LaunchPlan {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const nodePlan = codexNodeLaunchPlan(file, args)
    if (nodePlan !== undefined) return nodePlan
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
 * `timedOut`. By default this is a wall-clock deadline (npm/version checks).
 * CLI channels opt into idle mode: only actual nonempty stdout/stderr chunks
 * reset the watchdog; this protects against silence, not semantic stagnation.
 */
export function runProcess(options: {
  spawnFn?: SpawnFn
  file: string
  args: readonly string[]
  cwd?: string | undefined
  env?: Record<string, string> | undefined
  stdin?: string | undefined
  timeoutMs: number
  /** Defaults to wall-clock; CLI channels explicitly select idle. */
  timeoutMode?: 'idle' | 'wall-clock'
  /** Observational only: never counts as child output or resets the watchdog. */
  onTimeoutWarning?: (remainingMs: number) => void
  timeoutWarningLeadMs?: number
  signal: AbortSignal
  onStdoutLine?: ((line: string) => void) | undefined
  onStderrLine?: ((line: string) => void) | undefined
}): { child: ChildProcess; outcome: Promise<ChildOutcome> } {
  options.signal.throwIfAborted()
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
  let stopping = false
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let warningTimer: ReturnType<typeof setTimeout> | undefined
  const clearTimers = (): void => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    if (warningTimer !== undefined) clearTimeout(warningTimer)
    timeoutTimer = undefined
    warningTimer = undefined
  }
  const armTimeout = (): void => {
    if (settled || stopping) return
    clearTimers()
    timeoutTimer = setTimeout(() => {
      stopping = true
      timedOut = true
      clearTimers()
      void killTree(child)
    }, options.timeoutMs)
    const leadMs = Math.min(options.timeoutMs, Math.max(0,
      options.timeoutWarningLeadMs ?? Math.min(2 * 60_000, Math.round(options.timeoutMs / 5))))
    if (options.onTimeoutWarning !== undefined && leadMs > 0 && leadMs < options.timeoutMs) {
      warningTimer = setTimeout(() => {
        if (settled || stopping) return
        // A warning is observability, not progress; the deadline stays armed.
        try { options.onTimeoutWarning?.(leadMs) } catch { /* best effort */ }
      }, options.timeoutMs - leadMs)
    }
  }
  const activity = (chunk: Buffer): void => {
    // Count bytes, not parsed lines: stderr, whitespace and partial JSONL all
    // prove the child wrote output; empty chunks and our own notes do not.
    if (options.timeoutMode === 'idle' && chunk.length > 0) armTimeout()
  }
  child.stdout?.on('data', activity)
  child.stderr?.on('data', activity)
  armTimeout()

  const abort = (): void => {
    stopping = true
    clearTimers()
    void killTree(child)
  }
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
    if (stream === null) return
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    let discarding = false
    const accept = (text: string): void => {
      if (isStderr) stderrTail = appendTail(stderrTail, text)
      if (onLine === undefined) return
      let start = 0
      while (start < text.length) {
        const newline = text.indexOf('\n', start)
        const end = newline < 0 ? text.length : newline
        if (!discarding) {
          const part = text.slice(start, end)
          if (buffer.length + part.length > MAX_LINE_CHARS) {
            stderrTail = appendTail(stderrTail, `\n[maestro] dropped an oversized line (limit ${MAX_LINE_CHARS} chars)`)
            buffer = ''
            discarding = true
          } else buffer += part
        }
        if (newline < 0) break
        if (!discarding) {
          const line = buffer.replace(/\r$/, '')
          if (line !== '') onLine(line)
        }
        buffer = ''
        discarding = false
        start = newline + 1
      }
    }
    stream.on('data', (chunk: Buffer) => accept(decoder.write(chunk)))
    stream.on('end', () => {
      accept(decoder.end())
      const rest = buffer.replace(/\r$/, '')
      if (!discarding && rest.trim() !== '') onLine?.(rest)
      buffer = ''
    })
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
      clearTimers()
      child.stdout?.removeListener('data', activity)
      child.stderr?.removeListener('data', activity)
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
