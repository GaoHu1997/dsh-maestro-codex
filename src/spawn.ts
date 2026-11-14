/**
 * Child-process plumbing shared by the CLI channels and the npm manager:
 * command resolution (Windows `.cmd` shims included), an injectable spawn
 * seam for tests, incremental line streaming, timeout, and abort that kills
 * the whole tree on Windows.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { constants, existsSync, readFileSync, statSync } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { childEnvironment, type ChildEnvironment, type ChildEnvironmentPolicy } from './child-environment.js'

/** The spawn seam: everything a runner needs, injectable for tests. */
export type SpawnFn = (file: string, args: readonly string[], options: SpawnOptionsLike) => ChildProcess

export interface SpawnOptionsLike {
  cwd?: string | undefined
  env?: ChildEnvironment | undefined
  /** Delegated CLIs scrub ambient credentials; other callers retain inheritance. */
  environmentPolicy?: ChildEnvironmentPolicy | undefined
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
  env: childEnvironment(process.env, options.env, options.environmentPolicy ?? 'inherit'),
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

/** Standard npm setup, excluding the package-specific forwarding line. */
const NPM_NODE_SHIM_SETUP = [
  '@echo off', 'goto start', ':find_dp0', 'set dp0=%~dp0', 'exit /b',
  ':start', 'setlocal', 'call :find_dp0', 'if exist "%dp0%/node.exe" (',
  'set "_prog=%dp0%/node.exe"', ') else (', 'set "_prog=node"',
  'set pathext=%pathext:;.js;=;%', ')',
]

const NPM_NODE_ENTRIES: Readonly<Record<string, RegExp>> = {
  'codex.cmd': /^(?:node_modules[\\/]|\.\.[\\/])@openai[\\/]codex[\\/]bin[\\/]codex\.js$/i,
  'grok.cmd': /^(?:node_modules[\\/]|\.\.[\\/])@xai-official[\\/]grok[\\/]bin[\\/]grok$/i,
}

/**
 * npm's `%*` forwarding adds a cmd parse that corrupts nested JSON, paths and
 * percent literals. Bypass only the standard npm Node bootstrap, never a custom
 * launcher's hooks/arguments. Unknown templates retain the original cmd path.
 * Both global (`node_modules/...`) and local (`../...`) entries are taken from
 * the shim itself: an existing alternate installation must not redirect it.
 */
function npmNodeLaunchPlan(file: string, args: readonly string[]): LaunchPlan | undefined {
  const entryPattern = NPM_NODE_ENTRIES[path.basename(file).toLowerCase()]
  if (entryPattern === undefined) return undefined
  try {
    // Only ASCII indentation is harmless; trailing spaces affect unquoted SET.
    const lines = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.replace(/^[ \t]+/, '')).filter(line => line !== '')
    const forwarding = lines.pop() ?? ''
    if (lines.length !== NPM_NODE_SHIM_SETUP.length
      || lines.some((line, index) => line.replaceAll('\\', '/').toLowerCase() !== NPM_NODE_SHIM_SETUP[index])) return undefined
    const relativeEntry = /^endLocal\s+&\s+goto\s+#_undefined_#\s+2>NUL\s+\|\|\s+title\s+%COMSPEC%\s+&\s+"%_prog%"\s+"%dp0%[\\/]([^"]+)"\s+%\*$/i.exec(forwarding)?.[1]
    if (relativeEntry === undefined || !entryPattern.test(relativeEntry)) return undefined
    const dir = path.dirname(path.resolve(file))
    const entry = path.resolve(dir, ...relativeEntry.split(/[\\/]/))
    if (!statSync(entry).isFile()) return undefined
    const node = path.join(dir, 'node.exe')
    // Match npm's sibling-Node preference and PATH fallback. process.execPath
    // may be the desktop Electron application, not a standalone Node binary.
    return { file: existsSync(node) ? node : 'node.exe', args: [entry, ...args] }
  } catch {
    return undefined
  }
}

export function launchPlan(file: string, args: readonly string[]): LaunchPlan {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const nodePlan = npmNodeLaunchPlan(file, args)
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
  env?: ChildEnvironment | undefined
  /** Delegated CLIs scrub ambient credentials; other callers retain inheritance. */
  environmentPolicy?: ChildEnvironmentPolicy | undefined
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
    ...(options.environmentPolicy === undefined ? {} : { environmentPolicy: options.environmentPolicy }),
    ...(launch.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: launch.windowsVerbatimArguments }),
  })

  let timedOut = false
  let settled = false
  let stderrTail = ''
  let stopping = false
  let exited = false
  let closer: ReturnType<typeof watchChildClose>
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let warningTimer: ReturnType<typeof setTimeout> | undefined
  const clearTimers = (): void => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    if (warningTimer !== undefined) clearTimeout(warningTimer)
    timeoutTimer = undefined
    warningTimer = undefined
  }
  const armTimeout = (): void => {
    if (settled || stopping || exited) return
    clearTimers()
    timeoutTimer = setTimeout(() => {
      stopping = true
      timedOut = true
      clearTimers()
      closer.stop()
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
  const onExit = (): void => {
    exited = true
    clearTimers()
  }
  child.once('exit', onExit)
  armTimeout()

  const abort = (): void => {
    if (settled || stopping) return
    stopping = true
    clearTimers()
    closer.stop()
  }

  const flushers: Array<() => void> = []
  const unwire: Array<() => void> = []
  const wire = (stream: NodeJS.ReadableStream | null, onLine: ((line: string) => void) | undefined, isStderr: boolean): void => {
    if (stream === null) return
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    let discarding = false
    let ended = false
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
    const flush = (): void => {
      if (ended || settled) return
      ended = true
      accept(decoder.end())
      const rest = buffer.replace(/\r$/, '')
      if (!discarding && rest.trim() !== '') onLine?.(rest)
      buffer = ''
    }
    flushers.push(flush)
    const onData = (chunk: Buffer): void => {
      if (!settled && !ended) accept(decoder.write(chunk))
    }
    stream.on('data', onData)
    stream.on('end', flush)
    unwire.push(() => {
      stream.removeListener('data', onData)
      stream.removeListener('end', flush)
    })
    stream.on('error', (error: Error) => {
      if (!settled) stderrTail = appendTail(stderrTail, `\n[maestro] ${isStderr ? 'stderr' : 'stdout'} stream error: ${error.message}`)
    })
  }
  wire(child.stdout, options.onStdoutLine, false)
  wire(child.stderr, options.onStderrLine, true)

  const outcome = new Promise<ChildOutcome>((resolvePromise) => {
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      for (const flush of flushers) flush()
      settled = true
      for (const cleanup of unwire) cleanup()
      clearTimers()
      closer.dispose()
      child.removeListener('exit', onExit)
      child.stdout?.removeListener('data', activity)
      child.stderr?.removeListener('data', activity)
      options.signal.removeEventListener('abort', abort)
      resolvePromise({ code, signal, timedOut, stderrTail })
    }
    closer = watchChildClose(child, (code, signal, forced) => {
      if (forced) stderrTail = appendTail(stderrTail, '\n[maestro] 未收到子进程 close；已结束等待，进程终止或输出完整性未确认')
      settle(code, signal)
    })
    child.on('error', (error) => {
      if (settled) return
      // Surface spawn failures (ENOENT, access denied) through the exit path.
      stderrTail = appendTail(stderrTail, String(error instanceof Error ? error.message : error))
      settle(null, null)
    })
  })

  if (options.signal.aborted) abort()
  else options.signal.addEventListener('abort', abort, { once: true })
  if (child.stdin !== null) {
    // EPIPE when the child exits before the pipe closes must not kill the host.
    child.stdin.on('error', () => { /* ignored */ })
    if (options.stdin !== undefined) child.stdin.end(options.stdin)
    else child.stdin.end()
  }
  return { child, outcome }
}

function appendTail(current: string, addition: string): string {
  const next = (current + addition).slice(-STDERR_TAIL_LIMIT)
  return next
}

/** Allow buffered output to drain, but never wait forever for inherited pipes. */
export const PROCESS_CLOSE_GRACE_MS = 5_000
/** Includes the Windows taskkill command's five-second timeout. */
export const PROCESS_STOP_GRACE_MS = 6_000

/** Observe close independently of output/idle timers, including after termination. */
export function watchChildClose(
  child: ChildProcess,
  onClose: (code: number | null, signal: NodeJS.Signals | null, forced: boolean) => void,
): { stop(): void; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let stopping = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    child.removeListener('exit', onExit)
    child.removeListener('close', close)
  }
  const close = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (disposed) return
    dispose()
    onClose(code, signal, false)
  }
  const arm = (graceMs: number): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      if (disposed) return
      dispose()
      // No close means output/termination is unconfirmed. Never manufacture
      // exit 0 from the wrapper's exit event while a descendant holds pipes.
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL') } catch { /* best effort */ }
      }
      onClose(null, null, true)
      child.stdin?.destroy?.()
      child.stdout?.destroy?.()
      child.stderr?.destroy?.()
      child.unref?.()
    }, graceMs)
  }
  const onExit = (): void => {
    if (!disposed && !stopping) arm(PROCESS_CLOSE_GRACE_MS)
  }
  child.once('exit', onExit)
  child.once('close', close)
  return {
    stop: () => {
      if (disposed || stopping) return
      stopping = true
      arm(PROCESS_STOP_GRACE_MS)
      void killTree(child).catch(() => { /* bounded fallback above owns settlement */ })
    },
    dispose,
  }
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
