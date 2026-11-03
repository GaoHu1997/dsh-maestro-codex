import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectCli } from '../src/cli-manager.js'
import { readLocalCliVersion } from '../src/cli-local-version.js'
import { pickWindowsCandidate, whereAll } from '../src/spawn.js'
import { CLI_PACKAGES, type MaestroCliId } from '../src/wire.js'
import { scriptedSpawn } from './fake-child.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, realpath: vi.fn(actual.realpath), stat: vi.fn(actual.stat) }
})

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(realpath).mockReset()
  vi.mocked(stat).mockReset()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
  const result = await mkdtemp(path.join(tmpdir(), 'maestro CLI detect '))
  directories.push(result)
  return result
}

async function packageFixture(cli: MaestroCliId, bin: string, version = '1.2.3') {
  const prefix = await directory()
  const root = path.join(prefix, 'node_modules', CLI_PACKAGES[cli])
  const entry = path.join(root, bin)
  await mkdir(path.dirname(entry), { recursive: true })
  if (/\.exe$/i.test(bin)) {
    // Native bins are virtual fixtures: never write an invalid executable.
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(realpath).mockImplementation(async file => String(file) === entry ? entry : actual.realpath(file))
    vi.mocked(stat).mockImplementation(async file => String(file) === entry
      ? { isFile: () => true } as Awaited<ReturnType<typeof stat>>
      : actual.stat(file))
  } else {
    await writeFile(entry, 'fake CLI entry')
  }
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: CLI_PACKAGES[cli], version, bin: { [cli]: bin } }))
  const shim = path.join(prefix, `${cli}.cmd`)
  await writeFile(shim, `@ECHO OFF\n"%~dp0node_modules\\${CLI_PACKAGES[cli].replaceAll('/', '\\')}\\${bin.replaceAll('/', '\\')}" %*\n`)
  return { prefix, root, entry, shim }
}

const fallback = (spawnFn: ReturnType<typeof scriptedSpawn>['spawnFn'], extra = {}) =>
  detectCli({ cli: 'codex', override: process.execPath, spawnFn, ...extra })

describe('fast local CLI versions', () => {
  it.each([
    ['claude', 'cli.js'], ['claude', 'bin/claude.exe'], ['codex', 'bin/codex.js'],
  ] as const)('reads %s %s from its actual npm shim without spawning', async (cli, bin) => {
    const fixture = await packageFixture(cli, bin)
    const spawn = scriptedSpawn(child => child.finish('wrong 9.9.9'))
    const result = await detectCli({ cli, override: fixture.shim, spawnFn: spawn.spawnFn })
    expect(result).toEqual({ installed: true, version: '1.2.3', path: fixture.shim, error: undefined })
    expect(spawn.launches).toHaveLength(0)
  })

  it('supports a native Claude wrapper with an absolute exe path', async () => {
    const fixture = await packageFixture('claude', 'bin/claude.exe', '2.1.312')
    await writeFile(fixture.shim, `@ECHO OFF\n"${fixture.entry}" %*\n`)
    expect(await readLocalCliVersion('claude', fixture.shim)).toBe('2.1.312')
    expect(await readLocalCliVersion('claude', fixture.entry)).toBe('2.1.312')
  })

  it('supports a package with a string bin and prerelease/build version', async () => {
    const fixture = await packageFixture('codex', 'bin/codex.js')
    await writeFile(path.join(fixture.root, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.166.0-alpha.6+local', bin: 'bin/codex.js' }))
    expect(await readLocalCliVersion('codex', fixture.shim)).toBe('0.166.0-alpha.6+local')
  })

  it('supports POSIX npm sh wrappers', async () => {
    const fixture = await packageFixture('codex', 'bin/codex.js')
    const shim = path.join(fixture.prefix, 'codex')
    await writeFile(shim, '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/node_modules/@openai/codex/bin/codex.js" "$@"\n')
    expect(await readLocalCliVersion('codex', shim)).toBe('1.2.3')
  })

  it.skipIf(process.platform === 'win32')('follows npm/pnpm bin symlinks to the owning package', async () => {
    const fixture = await packageFixture('codex', 'bin/codex.js')
    const shim = path.join(fixture.prefix, 'codex')
    await symlink(fixture.entry, shim)
    expect(await readLocalCliVersion('codex', shim)).toBe('1.2.3')
  })

  it('does not borrow an adjacent package version for a custom wrapper', async () => {
    const fixture = await packageFixture('codex', 'bin/codex.js')
    await writeFile(fixture.shim, `@ECHO OFF\nREM "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js"\nother-cli --version\n`)
    const spawn = scriptedSpawn(child => child.finish('codex-cli 7.8.9'))
    expect(await detectCli({ cli: 'codex', override: fixture.shim, spawnFn: spawn.spawnFn })).toMatchObject({ installed: true, version: '7.8.9' })
    expect(spawn.launches).toHaveLength(1)
  })

  it.each([
    '@ECHO OFF\nSET dp0=D:/another-install\n"%dp0%/node_modules/@openai/codex/bin/codex.js" %*\n',
    '@ECHO OFF\necho "%~dp0node_modules/@openai/codex/bin/codex.js" %*\nother-cli %*\n',
    '#!/bin/sh\nbasedir=/another-install\nexec node "$basedir/node_modules/@openai/codex/bin/codex.js" "$@"\n',
  ])('does not trust an unrelated or merely printed package path: %s', async wrapper => {
    const fixture = await packageFixture('codex', 'bin/codex.js')
    await writeFile(fixture.shim, wrapper)
    const spawn = scriptedSpawn(child => child.finish('codex-cli 7.8.9'))
    expect(await detectCli({ cli: 'codex', override: fixture.shim, spawnFn: spawn.spawnFn })).toMatchObject({ installed: true, version: '7.8.9' })
    expect(spawn.launches).toHaveLength(1)
  })

  it('supports the standard npm cmd dp0 initialization', async () => {
    const fixture = await packageFixture('codex', 'bin/codex.js')
    await writeFile(fixture.shim, '@ECHO OFF\nSET dp0=%~dp0\n"node" "%dp0%/node_modules/@openai/codex/bin/codex.js" %*\n')
    expect(await readLocalCliVersion('codex', fixture.shim)).toBe('1.2.3')
  })

  it.each(['wrong-name', 'bad-version', 'wrong-bin', 'missing-bin', 'directory-bin', 'malformed'])('falls back for %s metadata', async kind => {
    const fixture = await packageFixture('codex', 'bin/codex.js')
    const metadata = path.join(fixture.root, 'package.json')
    const pkg = JSON.parse(await readFile(metadata, 'utf8'))
    if (kind === 'wrong-name') pkg.name = '@other/codex'
    if (kind === 'bad-version') pkg.version = 'unknown'
    if (kind === 'wrong-bin') pkg.bin.codex = 'bin/another.js'
    if (kind === 'missing-bin') delete pkg.bin
    if (kind === 'directory-bin') {
      await rm(fixture.entry)
      await mkdir(fixture.entry)
    }
    await writeFile(metadata, kind === 'malformed' ? '{broken' : JSON.stringify(pkg))
    const spawn = scriptedSpawn(child => child.finish('codex-cli 4.5.6'))
    expect(await detectCli({ cli: 'codex', override: fixture.shim, spawnFn: spawn.spawnFn })).toMatchObject({ installed: true, version: '4.5.6' })
    expect(spawn.launches).toHaveLength(1)
  })
})

describe('bounded --version fallback', () => {
  it('keeps a valid stdout version when later lines are only noise', async () => {
    const spawn = scriptedSpawn(child => child.finish('\u001b[32mcodex-cli 0.165.0\u001b[0m\n\nstartup warning\n'))
    expect(await fallback(spawn.spawnFn)).toMatchObject({ installed: true, version: '0.165.0', error: undefined })
  })

  it('accepts a version from stderr too', async () => {
    const spawn = scriptedSpawn(child => {
      child.finish('', 0, 'codex-cli 0.165.0\n')
    })
    expect(await fallback(spawn.spawnFn)).toMatchObject({ installed: true, version: '0.165.0', error: undefined })
  })

  it('accepts a version from stderr without a final newline', async () => {
    const spawn = scriptedSpawn(child => child.finish('', 0, 'codex-cli 0.165.0'))
    expect(await fallback(spawn.spawnFn)).toMatchObject({ installed: true, version: '0.165.0', error: undefined })
  })

  it('does not confuse a version failure with a missing installation', async () => {
    const spawn = scriptedSpawn(child => child.finish('', 1, 'startup failed'))
    expect(await fallback(spawn.spawnFn)).toMatchObject({ installed: true, version: '', path: process.execPath, error: '--version 退出码 1：startup failed' })
  })

  it('handles a synchronous spawn error as a version warning', async () => {
    const result = await detectCli({ cli: 'codex', override: process.execPath, spawnFn: () => { throw new Error('EACCES spawn') } })
    expect(result.installed).toBe(true)
    expect(result.error).toContain('EACCES spawn')
  })

  it('reports unknown rather than uninstalled when stdout has no version', async () => {
    const spawn = scriptedSpawn(child => child.finish('startup warning'))
    const result = await fallback(spawn.spawnFn)
    expect(result.installed).toBe(true)
    expect(result.version).toBe('')
    expect(result.error).toContain('未输出版本号')
  })

  it('returns at the deadline even when killing a child does not close it', async () => {
    const spawn = scriptedSpawn(child => {
      vi.spyOn(child, 'kill').mockImplementation(() => { child.killed = true; return true })
    })
    const started = performance.now()
    try {
      const result = await fallback(spawn.spawnFn, { versionTimeoutMs: 30 })
      expect(result).toMatchObject({ installed: true, version: '', path: process.execPath })
      expect(result.error).toContain('查询超时（30ms）')
      expect(performance.now() - started).toBeLessThan(1_500)
      expect(spawn.launches[0]?.killed).toBe(true)
    } finally {
      spawn.launches[0]?.finish('', 0)
    }
  })

  it('honors a pre-aborted caller without starting a child', async () => {
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    const spawn = scriptedSpawn(child => child.finish('1.0.0'))
    await expect(fallback(spawn.spawnFn, { signal: controller.signal })).rejects.toThrow('caller cancelled')
    expect(spawn.launches).toHaveLength(0)
  })

  it('propagates cancellation while --version is running', async () => {
    const controller = new AbortController()
    const spawn = scriptedSpawn(() => queueMicrotask(() => controller.abort(new Error('caller cancelled'))))
    await expect(fallback(spawn.spawnFn, { signal: controller.signal })).rejects.toThrow('caller cancelled')
    expect(spawn.launches[0]?.killed).toBe(true)
  })

  it('rejects a directory or missing override without spawning', async () => {
    const dir = await directory()
    const spawn = scriptedSpawn(child => child.finish('1.0.0'))
    for (const override of [dir, path.join(dir, 'missing.exe')]) {
      expect(await detectCli({ cli: 'codex', override, spawnFn: spawn.spawnFn })).toMatchObject({ installed: false, version: '', path: '' })
    }
    expect(spawn.launches).toHaveLength(0)
  })
})

describe('filesystem PATH lookup', () => {
  it('keeps confirmed local hits when another PATH entry is stalled', { timeout: 25_000 }, async () => {
    const dir = await directory()
    const offline = path.join(dir, 'offline')
    const name = 'maestro-partial-path'
    const executable = path.join(dir, process.platform === 'win32' ? `${name}.cmd` : name)
    await writeFile(executable, 'fake executable')
    if (process.platform !== 'win32') await chmod(executable, 0o755)
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(stat).mockImplementation(file => String(file).startsWith(`${offline}${path.sep}`)
      ? new Promise(() => {})
      : actual.stat(file))
    const hits = await whereAll(name, { env: { PATH: [offline, dir].join(path.delimiter), PATHEXT: '.CMD' }, cwd: dir, timeoutMs: 20 })
    expect(hits.map(value => value.toLowerCase())).toEqual([executable.toLowerCase()])
  })

  it('reports a stalled lookup instead of incorrectly claiming nothing is installed', async () => {
    const dir = await directory()
    vi.mocked(stat).mockImplementation(() => new Promise(() => {}))
    await expect(whereAll('maestro-stalled-path', { env: { PATH: dir, PATHEXT: '.CMD' }, cwd: dir, timeoutMs: 20 })).rejects.toThrow('PATH 查找超时（20ms）')
  })
  it('finds commands in quoted/spaced PATH entries, de-duplicates and skips directories', async () => {
    const first = await directory()
    const second = await directory()
    const name = 'maestro-detection-fixture'
    const filename = process.platform === 'win32' ? `${name}.cmd` : name
    const executable = path.join(first, filename)
    await writeFile(executable, 'fake executable')
    if (process.platform !== 'win32') await chmod(executable, 0o755)
    await mkdir(path.join(second, filename))
    const env = { PATH: [`"${first}"`, first, second].join(path.delimiter), PATHEXT: '.EXE;.CMD;.PS1' }
    const hits = await whereAll(name, { env, cwd: second })
    expect(hits.map(value => value.toLowerCase())).toEqual([executable.toLowerCase()])
  })

  it.skipIf(process.platform !== 'win32')('retains only supported Windows launch targets when sh/ps1 files exist', { timeout: 25_000 }, async () => {
    const dir = await directory()
    await writeFile(path.join(dir, 'maestro-lookup'), 'shell shim')
    await writeFile(path.join(dir, 'maestro-lookup.ps1'), 'powershell shim')
    const env = { Path: dir, PathExt: '.EXE;.CMD;.PS1' }
    expect(pickWindowsCandidate(await whereAll('maestro-lookup', { env, cwd: dir }))).toBeUndefined()
    await writeFile(path.join(dir, 'maestro-lookup.cmd'), 'cmd shim')
    expect(pickWindowsCandidate(await whereAll('maestro-lookup', { env, cwd: dir }))?.toLowerCase()).toBe(path.join(dir, 'maestro-lookup.cmd').toLowerCase())
    const native = path.join(dir, 'maestro-lookup.exe')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(stat).mockImplementation(async file => String(file).toLowerCase() === native.toLowerCase()
      ? { isFile: () => true } as Awaited<ReturnType<typeof stat>>
      : actual.stat(file))
    expect(pickWindowsCandidate(await whereAll('maestro-lookup', { env, cwd: dir }))?.toLowerCase()).toBe(native.toLowerCase())
  })

  it.skipIf(process.platform === 'win32')('requires executable permission on POSIX', async () => {
    const dir = await directory()
    await writeFile(path.join(dir, 'maestro-unusable'), 'not executable')
    expect(await whereAll('maestro-unusable', { env: { PATH: dir }, cwd: dir })).toEqual([])
  })
})
