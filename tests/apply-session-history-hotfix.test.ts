import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { decodeSessionLog, sha256 } from '../scripts/session-log-codec.mjs'

const SECRET = 'SYNTHETIC_POWERSHELL_SECRET_NEVER_PRINT_THIS'
const modules = ['session-access', 'usage', 'usage-journal', 'child-session', 'native-recovery', 'tool', 'index']
const scriptsRoot = fileURLToPath(new URL('../scripts/', import.meta.url))
const header = '{"type":"session","version":4,"id":"synthetic-powershell","createdAt":1,"isSeeded":false,"delegationDepth":0}\r\n'
const rows = [
  '{"type":"turn/start","seq":0,"time":1,"data":{}}\n',
  '{"type":"turn/end","seq":1,"time":2,"data":{}}\n',
  '{"type":"turn/start","seq":2,"time":3,"data":{}}\n',
  ` { "type":"maestro/cli-access","seq":3,"time":4,"data":{"token":"${SECRET}","text":"中文","ignorable":false} }\r\n`,
  '{"type":"maestro/cli-usage","seq":4,"time":5,"data":{"value":1.00e+2}}\n',
  '{"type":"maestro/cli-child","seq":5,"time":6,"data":{}}\n',
  '{"type":"other/required","seq":6,"time":7,"data":{"untouched":true}}\n',
]
const original = Buffer.concat([
  zstdCompressSync(Buffer.from(header)),
  zstdCompressSync(Buffer.from(rows.slice(0, 3).join(''))),
  zstdCompressSync(Buffer.from(rows.slice(3).join(''))),
])
const markedPlain = Buffer.from(header + rows.map((row, index) => {
  if (index < 3 || index > 5) return row
  const at = row.lastIndexOf('}')
  return row.slice(0, at) + ',"ignorable":true' + row.slice(at)
}).join(''))
const roots: string[] = []
const servers = new Set<Server>()
const run = promisify(execFile)
const TEST_HEADROOM_MS = 5_000
const SHORT_PROCESS_TIMEOUT_MS = 30_000
// pwsh plus the Node ZSTD probe and Node tree scan are three real startups.
const READONLY_PROCESS_TIMEOUT_MS = 3 * 15_000
const OFFLINE_PROCESS_TIMEOUT_MS = 45_000
const LOG_FAILURE_PROCESS_TIMEOUT_MS = 90_000
const APPLY_TEST_TIMEOUT_MS = 180_000
function remainingProcessBudget(testTimeoutMs: number): () => number {
  const deadline = performance.now() + testTimeoutMs - TEST_HEADROOM_MS
  return () => Math.max(1, Math.floor(deadline - performance.now()))
}

async function fixture(alreadyInstalled = false) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'maestro-pwsh-hotfix-test-'))
  roots.push(base)
  const source = join(base, 'source with spaces')
  const target = join(base, 'desktop plugin')
  const sessions = join(base, 'sessions')
  const shared = join(base, 'shared-package-store.js')
  const log = join(sessions, 'workspace', 'session', 'session.v4.jsonl.zstd')
  for (const path of [join(source, 'lib'), join(source, 'scripts'), join(target, 'lib'), dirname(log)]) {
    await mkdir(path, { recursive: true })
  }
  for (const name of ['apply-session-history-hotfix.ps1', 'repair-maestro-session-tree.mjs', 'repair-maestro-session-logs.mjs', 'scan-maestro-session-logs.mjs', 'session-log-codec.mjs']) {
    await copyFile(join(scriptsRoot, name), join(source, 'scripts', name))
  }
  const files = []
  for (const [index, name] of modules.entries()) {
    const before = Buffer.from(`export const synthetic = ${JSON.stringify(name + '-old')};\n`)
    const after = Buffer.from(`export const synthetic = ${JSON.stringify(name + '-fixed')};\n`)
    const path = `lib/${name}.js`
    const sourcePath = join(source, path)
    const targetPath = join(target, path)
    await writeFile(sourcePath, after, { flag: 'wx' })
    if (index === 0 && !alreadyInstalled) {
      await writeFile(shared, before, { flag: 'wx' })
      await link(shared, targetPath)
    } else {
      await writeFile(targetPath, alreadyInstalled ? after : before, { flag: 'wx' })
    }
    const beforeSha256 = sha256(before)
    files.push({ path, beforeSha256, afterSha256: sha256(after), before, after, sourcePath, targetPath, backup: `${targetPath}.maestro-history-original-${beforeSha256}.bak` })
  }
  await writeFile(join(target, 'package.json'), JSON.stringify({ name: 'dsh-maestro-codex', version: '0.1.4' }), { flag: 'wx' })
  await writeFile(log, original, { flag: 'wx', mode: 0o600 })
  const plan = join(source, 'plan.json')
  await writeFile(plan, JSON.stringify({
    schemaVersion: 1, plugin: 'dsh-maestro-codex', version: '0.1.4', sourceRoot: source, targetRoot: target,
    files: files.map(({ path, beforeSha256, afterSha256 }) => ({ path, beforeSha256, afterSha256 })),
  }), { flag: 'wx' })
  return { base, source, target, sessions, shared, log, plan, files, entry: join(source, 'scripts', 'apply-session-history-hotfix.ps1') }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
type CliFailure = Error & { code: number; stdout: string; stderr: string }

function invoke(value: Fixture, args: string[] = [], timeoutMs = SHORT_PROCESS_TIMEOUT_MS) {
  return run('pwsh', ['-NoProfile', '-NonInteractive', '-File', value.entry, '-PlanPath', value.plan, '-SessionsRoot', value.sessions, '-NodePath', process.execPath, ...args], {
    timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8',
  })
}
async function failure(promise: Promise<unknown>): Promise<CliFailure> {
  try { await promise } catch (error) {
    if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string'
      && 'stderr' in error && typeof error.stderr === 'string'
      && 'code' in error && typeof error.code === 'number'
      && 'killed' in error && error.killed === false && 'signal' in error && error.signal === null) {
      return error as CliFailure
    }
    throw error
  }
  throw new Error('expected synthetic PowerShell invocation to be refused')
}
async function snapshot(root: string) {
  const result: Record<string, { hash: string; mtime: string }> = {}
  async function walk(path: string) {
    const stat = await lstat(path, { bigint: true })
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(join(path, name))
    } else {
      result[relative(root, path)] = { hash: sha256(await readFile(path)), mtime: String(stat.mtimeNs) }
    }
  }
  await walk(root)
  return result
}
async function reports(value: Fixture) {
  const names = (await readdir(value.source)).filter(name => /^session-history-repair-.*\.json$/.test(name))
  return Promise.all(names.map(async name => {
    const path = join(value.source, name)
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain(SECRET)
    return { path, value: JSON.parse(text) }
  }))
}
async function listener(host: string) {
  const server = createServer(socket => socket.destroy())
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve) })
  servers.add(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('synthetic listener failed')
  return address.port
}
async function unchanged(value: Fixture, targetBefore: Awaited<ReturnType<typeof snapshot>>, sessionsBefore: Awaited<ReturnType<typeof snapshot>>) {
  expect(await snapshot(value.target)).toEqual(targetBefore)
  expect(await snapshot(value.sessions)).toEqual(sessionsBefore)
}
afterEach(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    servers.delete(server)
  }
  // Only canonical absolute roots returned by this test's own mkdtemp are removed.
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

// Exercise the actual pwsh entry point and .NET Windows File.Replace binding.
// Offline checks keep the production 10s verdict window and mandatory port 14983.
describe.skipIf(process.platform !== 'win32')('Windows session-history hotfix entry point', () => {
  it('defaults to read-only verification and saves a payload-free fresh scan', async () => {
    const value = await fixture()
    const targetBefore = await snapshot(value.target)
    const sessionsBefore = await snapshot(value.sessions)
    const result = await invoke(value, [], READONLY_PROCESS_TIMEOUT_MS)
    expect(result.stdout).toContain('7 runtime modules need replacement')
    expect(result.stdout).toContain('Nothing was installed or repaired')
    expect(result.stdout + result.stderr).not.toContain(SECRET)
    const saved = await reports(value)
    expect(saved).toHaveLength(1)
    expect(saved[0].value).toMatchObject({ status: 'dry-run', planned: 1, repaired: 0, scan: { summary: { affected: 1, markedEvents: 3 } } })
    expect(result.stdout).toContain(saved[0].path)
    await unchanged(value, targetBefore, sessionsBefore)
  }, READONLY_PROCESS_TIMEOUT_MS + TEST_HEADROOM_MS)

  it('requires explicit full-shutdown confirmation before making any backups', async () => {
    const value = await fixture()
    const targetBefore = await snapshot(value.target)
    const sessionsBefore = await snapshot(value.sessions)
    const result = await failure(invoke(value, ['-Apply']))
    expect(result.code).toBe(1)
    expect(result.stdout + result.stderr).toContain('Confirm ALL DSH processes')
    await unchanged(value, targetBefore, sessionsBefore)
    expect(await reports(value)).toEqual([])
  }, SHORT_PROCESS_TIMEOUT_MS + TEST_HEADROOM_MS)

  it.each(['127.0.0.1', '::1'])('refuses a listening extra %s port before any writes', async (host, context) => {
    const value = await fixture()
    const targetBefore = await snapshot(value.target)
    const sessionsBefore = await snapshot(value.sessions)
    let port: number
    try { port = await listener(host) } catch (error) {
      if (host === '::1' && error instanceof Error && 'code' in error && ['EAFNOSUPPORT', 'EPROTONOSUPPORT', 'EADDRNOTAVAIL'].includes(String(error.code))) { context.skip(); return }
      throw error
    }
    const result = await failure(invoke(value, ['-Apply', '-ConfirmDshFullyExited', '-AdditionalPort', String(port)], OFFLINE_PROCESS_TIMEOUT_MS))
    expect(result.code).toBe(1)
    expect(result.stdout + result.stderr).toContain('DSH_PORT_IS_LISTENING')
    await unchanged(value, targetBefore, sessionsBefore)
    expect(await reports(value)).toEqual([])
  }, OFFLINE_PROCESS_TIMEOUT_MS + TEST_HEADROOM_MS)

  it('checks both comma-separated ports through pwsh -Command before any writes', async () => {
    const value = await fixture()
    const targetBefore = await snapshot(value.target)
    const sessionsBefore = await snapshot(value.sessions)
    const port = await listener('127.0.0.1')
    const quote = (path: string) => `'${path.replaceAll("'", "''")}'`
    const command = `& ${quote(value.entry)} -PlanPath ${quote(value.plan)} -SessionsRoot ${quote(value.sessions)} -NodePath ${quote(process.execPath)} -Apply -ConfirmDshFullyExited -AdditionalPort 14983,${port}`
    const result = await failure(run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
      timeout: OFFLINE_PROCESS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8',
    }))
    expect(result.code).toBe(1)
    expect(result.stdout + result.stderr).toContain(`DSH_PORT_IS_LISTENING: ${port}`)
    await unchanged(value, targetBefore, sessionsBefore)
    expect(await reports(value)).toEqual([])
  }, OFFLINE_PROCESS_TIMEOUT_MS + TEST_HEADROOM_MS)

  it.each(['source', 'target'])('refuses changed %s code instead of overwriting it', async (kind) => {
    const value = await fixture()
    const file = kind === 'source' ? value.files[0].sourcePath : value.files[0].targetPath
    await writeFile(file, 'synthetic-unreviewed-change')
    const targetBefore = await snapshot(value.target)
    const sessionsBefore = await snapshot(value.sessions)
    const result = await failure(invoke(value))
    expect(result.code).toBe(1)
    expect(result.stdout + result.stderr).toContain(kind === 'source' ? 'BUILD_CHANGED' : 'INSTALLED_FILE_CHANGED')
    await unchanged(value, targetBefore, sessionsBefore)
    expect(await reports(value)).toEqual([])
  }, SHORT_PROCESS_TIMEOUT_MS + TEST_HEADROOM_MS)

  it('atomically applies all modules, reuses verified backups, preserves shared hard links and old temporary evidence, and repeats as a no-op', async () => {
    // Fixture work, assertions and both pwsh calls share this finite outer budget.
    const remainingTimeout = remainingProcessBudget(APPLY_TEST_TIMEOUT_MS)
    const value = await fixture()
    const first = value.files[0]
    for (const file of value.files) await writeFile(file.backup, file.before, { flag: 'wx' })
    const backupsBefore = await snapshot(value.target)
    const oldTemporary = `${first.targetPath}.maestro-history-prior-failed-attempt.tmp`
    await writeFile(oldTemporary, first.after, { flag: 'wx' })
    expect((await lstat(first.targetPath)).nlink).toBe(2)
    const result = await invoke(value, ['-Apply', '-ConfirmDshFullyExited'], remainingTimeout())
    expect(result.stdout).toContain('Offline code and log repair completed')
    expect(result.stdout + result.stderr).not.toContain(SECRET)
    for (const file of value.files) {
      expect((await readFile(file.targetPath)).equals(file.after)).toBe(true)
      expect((await readFile(file.backup)).equals(file.before)).toBe(true)
      expect(String((await lstat(file.backup, { bigint: true })).mtimeNs)).toBe(backupsBefore[relative(value.target, file.backup)].mtime)
    }
    expect((await readFile(value.shared)).equals(first.before)).toBe(true)
    expect((await lstat(first.targetPath)).nlink).toBe(1)
    expect((await readFile(oldTemporary)).equals(first.after)).toBe(true)
    expect((await readdir(join(value.target, 'lib'))).filter(name => name.endsWith('.tmp'))).toEqual([oldTemporary.slice(dirname(oldTemporary).length + 1)])
    const saved = await reports(value)
    expect(saved).toHaveLength(1)
    expect(saved[0].value).toMatchObject({ status: 'applied', planned: 1, repaired: 1, markedEvents: 3, remaining: [] })
    expect(saved[0].value.verification).toMatchObject([{ path: value.log, changed: 0 }])
    expect(decodeSessionLog(await readFile(value.log)).plaintext.equals(markedPlain)).toBe(true)
    expect((await readFile(saved[0].value.applied[0].backupPath)).equals(original)).toBe(true)
    const targetBefore = await snapshot(value.target)
    const sessionsBefore = await snapshot(value.sessions)
    const repeated = await invoke(value, ['-Apply', '-ConfirmDshFullyExited'], remainingTimeout())
    expect(repeated.stdout).toContain('0 runtime modules need replacement')
    const repeatedReport = (await reports(value)).find(report => report.path !== saved[0].path)
    expect(repeatedReport?.value).toMatchObject({ status: 'unchanged', planned: 0, repaired: 0 })
    await unchanged(value, targetBefore, sessionsBefore)
  }, APPLY_TEST_TIMEOUT_MS)

  it('verifies every code backup before installing the first module and never overwrites a corrupt backup', async () => {
    const value = await fixture()
    const corrupt = value.files.at(-1)!
    await writeFile(corrupt.backup, SECRET, { flag: 'wx' })
    const sessionsBefore = await snapshot(value.sessions)
    const result = await failure(invoke(value, ['-Apply', '-ConfirmDshFullyExited'], OFFLINE_PROCESS_TIMEOUT_MS))
    expect(result.code).toBe(1)
    expect(result.stdout + result.stderr).toContain('CODE_BACKUP_VERIFY_FAILED')
    expect(result.stdout + result.stderr).not.toContain(SECRET)
    for (const file of value.files) expect((await readFile(file.targetPath)).equals(file.before)).toBe(true)
    expect(await readFile(corrupt.backup, 'utf8')).toBe(SECRET)
    expect((await readdir(join(value.target, 'lib'))).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(await snapshot(value.sessions)).toEqual(sessionsBefore)
    expect(await reports(value)).toEqual([])
  }, OFFLINE_PROCESS_TIMEOUT_MS + TEST_HEADROOM_MS)

  it('saves a stderr failure report before returning LOG_REPAIR_STOPPED without deleting evidence', async () => {
    const value = await fixture(true)
    const backup = `${value.log}.maestro-original-${sha256(original)}.bak`
    await writeFile(backup, SECRET, { flag: 'wx', mode: 0o600 })
    const targetBefore = await snapshot(value.target)
    const sessionsBefore = await snapshot(value.sessions)
    const result = await failure(invoke(value, ['-Apply', '-ConfirmDshFullyExited'], LOG_FAILURE_PROCESS_TIMEOUT_MS))
    expect(result.code).toBe(1)
    expect(result.stdout + result.stderr).toContain('LOG_REPAIR_STOPPED')
    expect(result.stdout + result.stderr).not.toContain(SECRET)
    const saved = await reports(value)
    expect(saved).toHaveLength(1)
    expect(saved[0].value).toMatchObject({ status: 'refused', repaired: 0, error: { code: 'BACKUP_ALREADY_EXISTS', phase: 'apply', path: value.log, possibleBackupPath: backup } })
    expect(result.stdout).toContain(saved[0].path)
    await unchanged(value, targetBefore, sessionsBefore)
  }, LOG_FAILURE_PROCESS_TIMEOUT_MS + TEST_HEADROOM_MS)

  it('persists a minimal stderr argument error without masking it with StrictMode property failures', async () => {
    const value = await fixture()
    const targetBefore = await snapshot(value.target)
    const sessionsBefore = await snapshot(value.sessions)
    const result = await failure(invoke(value, ['-AdditionalPort', '0']))
    expect(result.code).toBe(1)
    expect(result.stdout + result.stderr).toContain('LOG_REPAIR_STOPPED')
    expect(result.stdout).toContain('Repair error: INVALID_PORT')
    const saved = await reports(value)
    expect(saved).toHaveLength(1)
    expect(saved[0].value).toEqual({ status: 'refused', code: 'INVALID_PORT' })
    await unchanged(value, targetBefore, sessionsBefore)
  }, SHORT_PROCESS_TIMEOUT_MS + TEST_HEADROOM_MS)
})
