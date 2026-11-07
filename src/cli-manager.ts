/**
 * CLI lifecycle management: detect the installed state of claude/codex and
 * run npm -g install/update/uninstall jobs. npm is driven through this Node's
 * own `npm-cli.js` when it exists (no shell, no shim quoting), falling back to
 * the resolved `npm` command via the .cmd launch plan.
 */

import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { readLocalCliVersion } from './cli-local-version.js'
import { pickWindowsCandidate, resolveCommand, runProcess, systemSpawn, whereAll } from './spawn.js'
import { CLI_PACKAGES, type MaestroCliId } from './wire.js'

/** Which npm action to run for one CLI. */
export type NpmAction = 'install' | 'uninstall'

/** The npm-cli.js that ships with this Node distribution, if present. */
export function findNpmCliJs(execPath: string = process.execPath): string | undefined {
  const candidate = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(candidate) ? candidate : undefined
}

/** npm argv for one action: node npm-cli.js form, or the plain command form.
 * `version` pins the install target (`pkg@version`); uninstall always spells
 * the bare package. */
export function npmArgv(action: NpmAction, pkg: string, registry: string, npmCliJs: string | undefined, version?: string): { file: string; args: string[] } {
  const target = action === 'install' && version !== undefined && version !== '' ? `${pkg}@${version}` : pkg
  const base = action === 'install'
    ? ['install', '-g', target]
    : ['uninstall', '-g', pkg]
  if (registry !== '') base.push('--registry', registry)
  if (npmCliJs !== undefined) {
    return { file: process.execPath, args: [npmCliJs, ...base] }
  }
  return { file: 'npm', args: base }
}

/** Pull the first semver-looking token out of a CLI's `--version` output
 * (`codex-cli 0.152.1` → `0.152.1`). */
export function extractVersion(raw: string): string {
  const match = /\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?/.exec(raw)
  return match === null ? raw.trim() : match[0]
}

/** One CLI's published versions. */
export interface PackageVersions {
  /** The registry's `latest` dist-tag (empty when it could not be read). */
  latest: string
  /** Every published version, oldest first. */
  versions: string[]
}

/** Detected install state of one CLI. */
export interface CliDetection {
  installed: boolean
  version: string
  path: string
  error: string | undefined
}

/** Await only until the deadline/cancellation, even if a killed child never closes. */
async function probeWithin<T>(timeoutMs: number, external: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  external?.throwIfAborted()
  const controller = new AbortController()
  const signal = external === undefined ? controller.signal : AbortSignal.any([controller.signal, external])
  const timer = setTimeout(() => controller.abort(new DOMException(`检测超时（${timeoutMs}ms）`, 'TimeoutError')), timeoutMs)
  let onAbort: (() => void) | undefined
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    return await Promise.race([work(signal), aborted])
  } finally {
    clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** Resolve locally, read the owning package, then use a short --version fallback. */
export async function detectCli(options: {
  spawnFn?: typeof systemSpawn
  cli: MaestroCliId
  override: string
  versionTimeoutMs?: number
  /** Extra abort signal (the caller's cancellation); merged with each deadline. */
  signal?: AbortSignal | undefined
}): Promise<CliDetection> {
  const override = options.override.trim()
  let resolved: string | undefined
  let foundOnPath = false
  try {
    await probeWithin(2_000, options.signal, async () => {
      if (override !== '') {
        resolved = resolve(override)
      } else {
        const candidates = await whereAll(options.cli)
        foundOnPath = candidates.length > 0
        resolved = process.platform === 'win32' ? pickWindowsCandidate(candidates) : candidates[0]
      }
      if (resolved !== undefined && !(await stat(resolved).catch(() => undefined))?.isFile()) resolved = undefined
    })
  } catch (error) {
    options.signal?.throwIfAborted()
    return { installed: false, version: '', path: '', error: `CLI 路径检测失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (resolved === undefined) {
    return {
      installed: false,
      version: '',
      path: '',
      error: override !== ''
        ? `配置的 CLI 路径不存在或不是文件：${override}`
        : foundOnPath
          ? 'PATH 上只有不可执行的垫片（缺少 .exe/.cmd），可尝试在配置页重新安装'
          : `未在 PATH 中找到 ${options.cli}`,
    }
  }
  const file = resolved
  try {
    const localVersion = await probeWithin(500, options.signal, () => readLocalCliVersion(options.cli, file))
    if (localVersion !== undefined) return { installed: true, version: localVersion, path: file, error: undefined }
  } catch {
    options.signal?.throwIfAborted()
    // Unreadable/stale package metadata must not prevent the executable fallback.
  }
  const versionTimeoutMs = options.versionTimeoutMs ?? 3_000
  let stdoutVersion = ''
  let stderrVersion = ''
  const versionIn = (line: string): string => {
    const clean = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    return /\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/.exec(clean)?.[0] ?? ''
  }
  try {
    const ended = await probeWithin(versionTimeoutMs, options.signal, signal => runProcess({
      ...(options.spawnFn === undefined ? {} : { spawnFn: options.spawnFn }),
      file,
      args: ['--version'],
      timeoutMs: versionTimeoutMs,
      signal,
      onStdoutLine: line => { if (stdoutVersion === '') stdoutVersion = versionIn(line) },
      onStderrLine: line => { if (stderrVersion === '') stderrVersion = versionIn(line) },
    }).outcome)
    options.signal?.throwIfAborted()
    const version = stdoutVersion || stderrVersion || versionIn(ended.stderrTail)
    if (ended.timedOut) {
      return { installed: true, version: '', path: file, error: `--version 查询超时（${versionTimeoutMs}ms），已找到 CLI，版本暂时未知` }
    }
    if (ended.code !== 0) {
      const last = ended.stderrTail.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '').at(-1) ?? ''
      return { installed: true, version, path: file, error: `--version 退出码 ${ended.code ?? 'null'}${last === '' ? '' : `：${last}`}` }
    }
    return { installed: true, version, path: file, error: version === '' ? '--version 未输出版本号，已找到 CLI，版本暂时未知' : undefined }
  } catch (error) {
    options.signal?.throwIfAborted()
    const detail = error instanceof Error && error.name === 'TimeoutError'
      ? `查询超时（${versionTimeoutMs}ms）`
      : error instanceof Error ? error.message : String(error)
    return { installed: true, version: '', path: file, error: `--version ${detail}，已找到 CLI，版本暂时未知` }
  }
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
  /** Install target; absent = the registry's default (latest) version. */
  version?: string | undefined
  timeoutMs?: number
  signal: AbortSignal
  onLine: (line: string) => void
}): Promise<{ ok: boolean; exitCode: number | null; stderrTail: string; timedOut: boolean }> {
  const npmCliJs = findNpmCliJs()
  const argv = npmArgv(options.action, CLI_PACKAGES[options.cli], options.registry, npmCliJs, options.version)
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
  // EBADPLATFORM（真机实测踩过）：npm 镜像源的 dist-tags 可能过期，把 latest
  // 解析到一个不支持当前平台的远古版本。提示里给出可操作的解法，而不是让
  // 用户面对一行裸 npm 错误。
  let stderrTail = ended.stderrTail
  if (!ended.timedOut && ended.code !== 0 && /EBADPLATFORM/.test(stderrTail)) {
    stderrTail = `${stderrTail}\n提示：该安装包声明了平台限制，且当前 registry 解析到的版本可能已过期。请在插件配置页把 npm registry 换成官方源（https://registry.npmjs.org/）后重试。`
  }
  return { ok: !ended.timedOut && ended.code === 0, exitCode: ended.code, stderrTail, timedOut: ended.timedOut }
}

/**
 * Read one package's published versions and `latest` dist-tag from the npm
 * registry (`npm view <pkg> versions dist-tags --json`). Never throws: a
 * registry/network failure is returned as the error string so the card can
 * still show the installed CLI.
 */
export async function queryPackageVersions(options: {
  spawnFn?: typeof systemSpawn
  cli: MaestroCliId
  registry: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<{ ok: true; value: PackageVersions } | { ok: false; error: string }> {
  const pkg = CLI_PACKAGES[options.cli]
  const npmCliJs = findNpmCliJs()
  const args = ['view', pkg, 'versions', 'dist-tags', '--json']
  if (options.registry !== '') args.push('--registry', options.registry)
  const file = npmCliJs === undefined ? (await resolveCommand('npm', '')) ?? 'npm' : process.execPath
  const argv = npmCliJs === undefined ? args : [npmCliJs, ...args]
  const timeoutMs = options.timeoutMs ?? 30_000
  const timeoutSignal = AbortSignal.timeout(timeoutMs + 5_000)
  const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, options.signal])
  let stdout = ''
  const { outcome } = runProcess({
    ...(options.spawnFn === undefined ? {} : { spawnFn: options.spawnFn }),
    file,
    args: argv,
    timeoutMs,
    signal,
    onStdoutLine: line => { stdout += `${line}\n` },
  })
  const ended = await outcome
  if (ended.timedOut) return { ok: false, error: `查询 ${pkg} 版本超时` }
  if (ended.code !== 0) {
    const last = ended.stderrTail.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '').at(-1) ?? ''
    return { ok: false, error: `npm view 退出码 ${ended.code ?? 'null'}${last === '' ? '' : `：${last}`}` }
  }
  const parsed = parseJsonOutput(stdout)
  if (parsed === undefined) return { ok: false, error: `无法解析 npm view 输出：${stdout.trim().slice(0, 200)}` }
  const versions = versionsOf(parsed)
  if (versions.length === 0) return { ok: false, error: `${pkg} 在 npm registry 上没有可安装版本` }
  return { ok: true, value: { latest: latestOf(parsed, versions), versions } }
}

/** Tolerate npm banner lines around the JSON document. */
function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim()
  try {
    return JSON.parse(text) as unknown
  } catch {
    const start = text.search(/[{[]/)
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
    if (start < 0 || end <= start) return undefined
    try {
      return JSON.parse(text.slice(start, end + 1)) as unknown
    } catch {
      return undefined
    }
  }
}

function versionsOf(parsed: unknown): string[] {
  const raw = Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string')
    : (() => {
        if (typeof parsed !== 'object' || parsed === null) return []
        const value = (parsed as Record<string, unknown>)['versions']
        if (typeof value === 'string') return [value]
        return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
      })()
  // Stable releases only: no alpha/beta/rc, no platform-tagged builds.
  return raw.filter(version => /^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(version))
}

function latestOf(parsed: unknown, versions: readonly string[]): string {
  if (typeof parsed === 'object' && parsed !== null) {
    const tags = (parsed as Record<string, unknown>)['dist-tags'] ?? (parsed as Record<string, unknown>)['distTags']
    if (typeof tags === 'object' && tags !== null) {
      const latest = (tags as Record<string, unknown>)['latest']
      // A `latest` that points at a prerelease is not offered here.
      if (typeof latest === 'string' && versions.includes(latest)) return latest
    }
  }
  return versions.at(-1) ?? ''
}
