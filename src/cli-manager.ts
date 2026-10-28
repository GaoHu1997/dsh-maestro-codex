/**
 * CLI lifecycle management: detect the installed state of claude/codex and
 * run npm -g install/update/uninstall jobs. npm is driven through this Node's
 * own `npm-cli.js` when it exists (no shell, no shim quoting), falling back to
 * the resolved `npm` command via the .cmd launch plan.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pickWindowsCandidate, resolveCommand, runProcess, systemSpawn, whereAll } from './spawn.js'
import { CLI_PACKAGES, type MaestroCliId } from './wire.js'

/** Which npm action to run for one CLI. */
export type NpmAction = 'install' | 'uninstall'

/** The npm-cli.js that ships with this Node distribution, if present. */
export function findNpmCliJs(execPath: string = process.execPath): string | undefined {
  const candidate = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(candidate) ? candidate : undefined
}

/** npm argv for one action: node npm-cli.js form, or the plain command form. */
export function npmArgv(action: NpmAction, pkg: string, registry: string, npmCliJs: string | undefined): { file: string; args: string[] } {
  const base = action === 'install'
    ? ['install', '-g', pkg]
    : ['uninstall', '-g', pkg]
  if (registry !== '') base.push('--registry', registry)
  if (npmCliJs !== undefined) {
    return { file: process.execPath, args: [npmCliJs, ...base] }
  }
  return { file: 'npm', args: base }
}

/** Detected install state of one CLI. */
export interface CliDetection {
  installed: boolean
  version: string
  path: string
  error: string | undefined
}

/** Detect one CLI: resolve it on PATH (or the configured override), then read `--version`. */
export async function detectCli(options: {
  spawnFn?: typeof systemSpawn
  cli: MaestroCliId
  override: string
  versionTimeoutMs?: number
  /** Extra abort signal (the caller's cancellation); merged with the version timeout. */
  signal?: AbortSignal | undefined
}): Promise<CliDetection> {
  const override = options.override.trim()
  let resolved: string | undefined
  let foundOnPath = false
  if (override !== '') {
    resolved = existsSync(override) ? override : undefined
  } else {
    const candidates = await whereAll(options.cli).catch(() => [] as string[])
    foundOnPath = candidates.length > 0
    resolved = process.platform === 'win32' ? pickWindowsCandidate(candidates) : candidates[0]
  }
  if (resolved === undefined || !existsSync(resolved)) {
    return {
      installed: false,
      version: '',
      path: '',
      error: override !== ''
        ? `配置的 CLI 路径不存在：${override}`
        : foundOnPath
          ? `PATH 上只有不可执行的垫片（缺少 .exe/.cmd），可尝试在配置页重新安装`
          : `未在 PATH 中找到 ${options.cli}`,
    }
  }
  const versionTimeoutMs = options.versionTimeoutMs ?? 15_000
  let version = ''
  const timeoutSignal = AbortSignal.timeout(versionTimeoutMs + 5_000)
  const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, options.signal])
  const { outcome } = runProcess({
    ...(options.spawnFn === undefined ? {} : { spawnFn: options.spawnFn }),
    file: resolved,
    args: ['--version'],
    timeoutMs: versionTimeoutMs,
    signal,
    onStdoutLine: line => { version = line.trim() },
  })
  const ended = await outcome
  if (ended.code !== 0) {
    const last = ended.stderrTail.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '').at(-1) ?? ''
    return { installed: false, version: '', path: resolved, error: `--version 退出码 ${ended.code ?? 'null'}${last === '' ? '' : `：${last}`}` }
  }
  return { installed: true, version, path: resolved, error: undefined }
}

/**
 * Run one npm job to completion, streaming stdout lines through `onLine`.
 * Never throws — the outcome is the answer. The raw `npm`/`npm.cmd` target
 * goes to runProcess, which applies the .cmd launch plan exactly once.
 */
export async function runNpmJob(options: {
  spawnFn?: typeof systemSpawn
  action: NpmAction
  cli: MaestroCliId
  registry: string
  timeoutMs?: number
  signal: AbortSignal
  onLine: (line: string) => void
}): Promise<{ ok: boolean; exitCode: number | null; stderrTail: string; timedOut: boolean }> {
  const npmCliJs = findNpmCliJs()
  const argv = npmArgv(options.action, CLI_PACKAGES[options.cli], options.registry, npmCliJs)
  const file = argv.file === process.execPath ? argv.file : (await resolveCommand('npm', '')) ?? argv.file
  const timeoutMs = options.timeoutMs ?? 10 * 60_000
  const { outcome } = runProcess({
    ...(options.spawnFn === undefined ? {} : { spawnFn: options.spawnFn }),
    file,
    args: argv.args,
    timeoutMs,
    signal: options.signal,
    onStdoutLine: options.onLine,
  })
  const ended = await outcome
  return { ok: !ended.timedOut && ended.code === 0, exitCode: ended.code, stderrTail: ended.stderrTail, timedOut: ended.timedOut }
}
