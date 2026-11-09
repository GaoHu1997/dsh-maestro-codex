import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { zstdCompressSync } from 'node:zlib'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeSessionLog, sha256 } from '../scripts/session-log-codec.mjs'
import { repairSessionLogFile } from '../scripts/repair-maestro-session-logs.mjs'
import { parseTreeRepairArgs, repairSessionLogTree } from '../scripts/repair-maestro-session-tree.mjs'

const SECRET = 'SYNTHETIC_TREE_SECRET_NEVER_PRINT_THIS'
const header = '{"type":"session","version":4,"id":"synthetic-tree","createdAt":1,"isSeeded":false,"delegationDepth":0}\r\n'
const rows = [
  '{"type":"turn/start","seq":0,"time":1,"data":{}}\n',
  ` { "type":"maestro/cli-access","seq":1,"time":2,"data":{"token":"${SECRET}","text":"中文","ignorable":false} }\r\n`,
  '{"type":"maestro/cli-usage","seq":2,"time":3,"data":{"value":1.00e+2}}\n',
  '{"type":"maestro/cli-child","seq":3,"time":4,"data":{}}\n',
  '{"type":"other/required","seq":4,"time":5,"data":{"untouched":true}}\n',
]
const plain = Buffer.from(header + rows.join(''))
const clean = Buffer.from(header + rows[0])
const markedPlain = Buffer.from(header + rows.map((row, i) => {
  if (i < 1 || i > 3) return row
  const at = row.lastIndexOf('}')
  return row.slice(0, at) + ',"ignorable":true' + row.slice(at)
}).join(''))
const compressed = () => Buffer.concat([
  zstdCompressSync(Buffer.from(header)), zstdCompressSync(Buffer.from(rows[0])),
  zstdCompressSync(Buffer.from(rows.slice(1).join(''))),
])
const defaults = () => [
  { name: 'workspace-a/session-a/session.v4.jsonl', bytes: plain },
  { name: 'workspace-a/session-b/session.v4.jsonl.zst', bytes: compressed() },
  { name: 'workspace-b/session-c/session.v4.jsonl.zstd', bytes: compressed() },
  { name: 'workspace-b/session-d/session.v4.jsonl', bytes: clean },
]
const roots: string[] = []
const servers = new Set<Server>()
const script = fileURLToPath(new URL('../scripts/repair-maestro-session-tree.mjs', import.meta.url))
const run = promisify(execFile)
const TEST_HEADROOM_MS = 5_000
const OFFLINE_VERDICT_MS = 10_000
const CLI_PROCESS_TIMEOUT_MS = 15_000
const CLI_TEST_TIMEOUT_MS = CLI_PROCESS_TIMEOUT_MS + TEST_HEADROOM_MS
const CLI_REFUSAL_TEST_TIMEOUT_MS = process.platform === 'win32'
  ? 4 * CLI_PROCESS_TIMEOUT_MS + TEST_HEADROOM_MS : 20_000
// One preflight plus two checks per applied file; each round checks IPv4/IPv6.
function offlineTestTimeout(rounds: number, nonWindowsTimeout = 25_000): number {
  return process.platform === 'win32'
    ? rounds * 2 * OFFLINE_VERDICT_MS + TEST_HEADROOM_MS : nonWindowsTimeout
}
function cliRunner(testTimeoutMs: number) {
  const deadline = performance.now() + testTimeoutMs - TEST_HEADROOM_MS
  return (args: string[]) => run(process.execPath, [script, ...args], {
    timeout: Math.max(1, Math.min(CLI_PROCESS_TIMEOUT_MS, Math.floor(deadline - performance.now()))), windowsHide: true,
  })
}
async function fixture(specs = defaults()) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'maestro-tree-repair-test-'))
  roots.push(root)
  const logs = []
  for (const { name, bytes } of specs) {
    const path = join(root, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    logs.push({ path, bytes })
  }
  return { root, logs }
}
async function snapshot(root: string) {
  const entries: Record<string, unknown> = {}
  async function walk(path: string) {
    const stat = await lstat(path, { bigint: true })
    const key = relative(root, path)
    if (stat.isSymbolicLink()) { entries[key] = 'link'; return }
    entries[key] = {
      kind: stat.isDirectory() ? 'directory' : 'file', mtime: String(stat.mtimeNs),
      hash: stat.isDirectory() ? undefined : sha256(await readFile(path)),
    }
    if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await walk(join(path, name))
  }
  await walk(root)
  return entries
}
async function listener(host = '127.0.0.1') {
  const server = createServer(socket => socket.destroy())
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve) })
  servers.add(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('synthetic listener failed')
  return { server, port: address.port }
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  servers.delete(server)
}
async function offlineOptions() {
  const { server, port } = await listener()
  await close(server)
  return { apply: true, confirmDshFullyExited: true, ports: [port] }
}
async function failure(promise: Promise<unknown>) {
  try { await promise } catch (error: any) { return error }
  throw new Error('expected synthetic operation to be refused')
}
async function cliFailure(promise: Promise<unknown>) {
  const error = await failure(promise)
  expect(typeof error.code).toBe('number')
  expect(error).toMatchObject({ killed: false, signal: null })
  return error
}
afterEach(async () => {
  for (const server of servers) await close(server)
  // Only canonical absolute roots returned by our own mkdtemp are removed.
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('offline Maestro session-tree repair', () => {
  it('defaults to a payload-free, all-tree read-only plan with no file or mtime changes', async () => {
    const { root } = await fixture()
    const before = await snapshot(root)
    const report = await repairSessionLogTree(root)
    expect(report).toMatchObject({ status: 'dry-run', mode: 'dry-run', transactional: false, planned: 3, repaired: 0, markedEvents: 0, applied: [] })
    expect(report.scan.summary).toMatchObject({ discovered: 4, inspected: 4, affected: 3, unchanged: 1, refused: 0, skippedLinks: 0, events: 16, markedEvents: 9 })
    expect(report.remaining).toHaveLength(3)
    expect(JSON.stringify(report)).not.toContain(SECRET)
    expect(await snapshot(root)).toEqual(before)
  })

  it('repairs mixed multi-frame formats, preserves every original backup, and verifies changed:0', { timeout: offlineTestTimeout(1 + 2 * 3) }, async () => {
    const { root, logs } = await fixture()
    const report = await repairSessionLogTree(root, await offlineOptions())
    expect(report).toMatchObject({ status: 'applied', repaired: 3, markedEvents: 9, planned: 3, remaining: [] })
    expect(report.verification).toHaveLength(3)
    for (const [index, result] of report.applied.entries()) {
      expect(result.path).toBe(logs[index].path)
      expect(result.originalSha256).toBe(sha256(logs[index].bytes))
      expect((await readFile(result.backupPath)).equals(logs[index].bytes)).toBe(true)
      const repaired = await readFile(result.path)
      expect(sha256(repaired)).toBe(result.resultSha256)
      expect(decodeSessionLog(repaired).plaintext.equals(markedPlain)).toBe(true)
      expect(report.verification[index]).toEqual({ path: result.path, changed: 0, sha256: result.resultSha256 })
      expect((await repairSessionLogFile(result.path)).changed).toBe(0)
      expect(await readdir(dirname(result.path))).toHaveLength(2)
    }
    expect((await readFile(logs[3].path)).equals(clean)).toBe(true)
    expect(await readdir(dirname(logs[3].path))).toHaveLength(1)
    expect(JSON.stringify(report)).not.toContain(SECRET)
  })

  it('rescans a repaired tree as a byte-identical no-op with no additional backups', { timeout: offlineTestTimeout(1 + 2 * 3 + 1) }, async () => {
    const { root } = await fixture()
    const options = await offlineOptions()
    await repairSessionLogTree(root, options)
    const before = await snapshot(root)
    const repeated = await repairSessionLogTree(root, options)
    expect(repeated).toMatchObject({ status: 'unchanged', planned: 0, repaired: 0, markedEvents: 0, applied: [], verification: [], remaining: [] })
    expect(repeated.scan.summary).toMatchObject({ affected: 0, unchanged: 4, markedEvents: 0 })
    expect(await snapshot(root)).toEqual(before)
  })

  it.each(['affected', 'unchanged', 'empty'])('refuses unconfirmed apply even for an %s tree', async (kind) => {
    const specs = kind === 'affected' ? defaults() : kind === 'empty' ? [] : [{ name: 'workspace/session/session.v4.jsonl', bytes: clean }]
    const { root } = await fixture(specs)
    const before = await snapshot(root)
    const error = await failure(repairSessionLogTree(root, { apply: true }))
    expect(error).toMatchObject({ code: 'EXPLICIT_OFFLINE_CONFIRMATION_REQUIRED', report: { status: 'refused', repaired: 0, applied: [] } })
    expect(await snapshot(root)).toEqual(before)
  })

  it('refuses the entire plan when even the last scanned log is malformed', async () => {
    const { root } = await fixture([...defaults(), { name: 'workspace-z/broken/session.v4.jsonl', bytes: Buffer.from(header + `{"${SECRET}": broken}\n`) }])
    const before = await snapshot(root)
    const error = await failure(repairSessionLogTree(root, await offlineOptions()))
    expect(error).toMatchObject({ code: 'SCAN_REFUSALS_OR_LINKS', report: { repaired: 0, applied: [], scan: { summary: { affected: 3, refused: 1 } } } })
    expect(error.report.scan.refused[0].code).toBe('INVALID_JSON')
    expect(JSON.stringify(error.report)).not.toContain(SECRET)
    expect(await snapshot(root)).toEqual(before)
  })

  it('refuses all writes if any directory link/junction was skipped', async () => {
    const { root } = await fixture()
    const outside = await fixture()
    await symlink(join(outside.root, 'workspace-a'), join(root, 'linked-workspace'), process.platform === 'win32' ? 'junction' : 'dir')
    const before = await snapshot(root)
    const outsideBefore = await snapshot(outside.root)
    const error = await failure(repairSessionLogTree(root, await offlineOptions()))
    expect(error).toMatchObject({ code: 'SCAN_REFUSALS_OR_LINKS', report: { repaired: 0, applied: [], scan: { summary: { skippedLinks: 1 } } } })
    expect(await snapshot(root)).toEqual(before)
    expect(await snapshot(outside.root)).toEqual(outsideBefore)
  })

  it.each(['127.0.0.1', '::1'])('refuses a listening %s port before creating any backups', { timeout: offlineTestTimeout(1, 5_000) }, async (host, context) => {
    const { root } = await fixture()
    const before = await snapshot(root)
    let opened: Awaited<ReturnType<typeof listener>>
    try { opened = await listener(host) } catch (error: any) {
      if (host === '::1' && ['EAFNOSUPPORT', 'EPROTONOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) { context.skip(); return }
      throw error
    }
    const error = await failure(repairSessionLogTree(root, { apply: true, confirmDshFullyExited: true, ports: [opened.port] }))
    expect(error).toMatchObject({ code: 'DSH_PORT_IS_LISTENING', report: { repaired: 0, applied: [], error: { phase: 'offline-check' } } })
    expect(await snapshot(root)).toEqual(before)
  })

  it('also checks the requested ports when there are no files to change', { timeout: offlineTestTimeout(1, 5_000) }, async () => {
    const { root } = await fixture([])
    const { port } = await listener()
    const error = await failure(repairSessionLogTree(root, { apply: true, confirmDshFullyExited: true, ports: [port] }))
    expect(error.code).toBe('DSH_PORT_IS_LISTENING')
    expect(await readdir(root)).toEqual([])
  })

  it('uses this invocation\'s new scan hash, never a previous dry-run report', { timeout: offlineTestTimeout(1 + 2 * 3) }, async () => {
    const { root, logs } = await fixture()
    const oldPlan = await repairSessionLogTree(root)
    const updated = Buffer.from(plain.toString().replace('"untouched":true', '"untouched":false'))
    await writeFile(logs[0].path, updated)
    const report = await repairSessionLogTree(root, await offlineOptions())
    expect(report.repaired).toBe(3)
    expect(report.applied[0].originalSha256).toBe(sha256(updated))
    expect(report.applied[0].originalSha256).not.toBe(oldPlan.scan.logs[0].originalSha256)
    expect((await readFile(report.applied[0].backupPath)).equals(updated)).toBe(true)
  })

  it('stops at the first file failure, reports confirmed progress, and never rolls back or continues', { timeout: offlineTestTimeout(1 + 2 + 1) }, async () => {
    const { root, logs } = await fixture()
    const collision = `${logs[1].path}.maestro-original-${sha256(logs[1].bytes)}.bak`
    await writeFile(collision, SECRET, { flag: 'wx', mode: 0o600 })
    const error = await failure(repairSessionLogTree(root, await offlineOptions()))
    const report = error.report
    expect(error.code).toBe('BACKUP_ALREADY_EXISTS')
    expect(report).toMatchObject({ status: 'partial', transactional: false, repaired: 1, markedEvents: 3, manualInspectionRequired: true })
    expect(report.error).toMatchObject({ code: 'BACKUP_ALREADY_EXISTS', phase: 'apply', path: logs[1].path, possibleBackupPath: collision })
    expect(report.applied).toHaveLength(1)
    expect(report.verification).toHaveLength(1)
    expect(report.remaining).toEqual([logs[1].path, logs[2].path])
    expect((await readFile(report.applied[0].backupPath)).equals(logs[0].bytes)).toBe(true)
    expect((await readFile(logs[0].path)).equals(markedPlain)).toBe(true)
    for (const log of logs.slice(1)) expect((await readFile(log.path)).equals(log.bytes)).toBe(true)
    expect(await readFile(collision, 'utf8')).toBe(SECRET)
    expect(await readdir(dirname(logs[1].path))).toHaveLength(2)
    expect(await readdir(dirname(logs[2].path))).toHaveLength(1)
    expect(JSON.stringify(report)).not.toContain(SECRET)
  })

  it('requires an absolute root and validates ports without touching the tree', async () => {
    expect(await failure(repairSessionLogTree('relative-root'))).toMatchObject({ code: 'ABSOLUTE_SESSION_ROOT_REQUIRED' })
    const { root } = await fixture()
    const before = await snapshot(root)
    for (const ports of [[], [0], [65536], [1.5]]) {
      expect(await failure(repairSessionLogTree(root, { apply: true, confirmDshFullyExited: true, ports }))).toMatchObject({ code: 'INVALID_PORT' })
    }
    expect(await snapshot(root)).toEqual(before)
  })
})

describe('tree-repair CLI', () => {
  it('defaults to dry-run and can only append listener ports to mandatory 14983', () => {
    const root = join(tmpdir(), 'synthetic-session-root')
    expect(parseTreeRepairArgs([root])).toMatchObject({ root, options: { apply: false, confirmDshFullyExited: false, ports: [14983] } })
    expect(parseTreeRepairArgs(['--apply', '--confirm-dsh-fully-exited', '--port', '12345', '--port', '54321', root]).options.ports).toEqual([14983, 12345, 54321])
    expect(() => parseTreeRepairArgs(['--apply', '--dry-run', root])).toThrow('INVALID_ARGUMENTS')
    expect(() => parseTreeRepairArgs(['--confirm-dsh-fully-exited', root])).toThrow('INVALID_ARGUMENTS')
    expect(() => parseTreeRepairArgs(['--port', '0', root])).toThrow('INVALID_PORT')
    expect(() => parseTreeRepairArgs(['--expect-sha256', 'a'.repeat(64), root])).toThrow('FRESH_SCAN_REQUIRED')
    expect(() => parseTreeRepairArgs(['--report', root])).toThrow('INVALID_ARGUMENTS')
    expect(() => parseTreeRepairArgs(['--ports', '12345', root])).toThrow('INVALID_ARGUMENTS')
  })

  it('executes a default CLI scan with no payload disclosure or artifacts', { timeout: CLI_TEST_TIMEOUT_MS }, async () => {
    const runCli = cliRunner(CLI_TEST_TIMEOUT_MS)
    const { root } = await fixture()
    const before = await snapshot(root)
    const result = await runCli([root])
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'dry-run', repaired: 0, planned: 3 })
    expect(result.stdout + result.stderr).not.toContain(SECRET)
    expect(await snapshot(root)).toEqual(before)
  })

  it('returns static, payload-free errors for unconfirmed apply and malformed logs', async () => {
    const runCli = cliRunner(CLI_REFUSAL_TEST_TIMEOUT_MS)
    const { root } = await fixture()
    const before = await snapshot(root)
    const unconfirmed = await cliFailure(runCli(['--apply', root]))
    expect(unconfirmed.code).toBe(1)
    expect(JSON.parse(unconfirmed.stderr).error.code).toBe('EXPLICIT_OFFLINE_CONFIRMATION_REQUIRED')
    expect(await snapshot(root)).toEqual(before)
    const broken = await fixture([{ name: 'workspace/session/session.v4.jsonl', bytes: Buffer.from(header + `{"${SECRET}": broken}\n`) }])
    const brokenBefore = await snapshot(broken.root)
    const refused = await cliFailure(runCli(['--apply', '--confirm-dsh-fully-exited', broken.root]))
    expect(refused.code).toBe(1)
    expect(JSON.parse(refused.stderr)).toMatchObject({ repaired: 0, error: { code: 'SCAN_REFUSALS_OR_LINKS' }, scan: { refused: [{ code: 'INVALID_JSON' }] } })
    expect(refused.stdout + refused.stderr).not.toContain(SECRET)
    const dryRun = await cliFailure(runCli([broken.root]))
    expect(dryRun.code).toBe(2)
    expect(JSON.parse(dryRun.stdout).status).toBe('dry-run')
    expect(dryRun.stdout + dryRun.stderr).not.toContain(SECRET)
    const invalid = await cliFailure(runCli([`--${SECRET}`]))
    expect(invalid.code).toBe(1)
    expect(JSON.parse(invalid.stderr).code).toBe('INVALID_ARGUMENTS')
    expect(invalid.stdout + invalid.stderr).not.toContain(SECRET)
    expect(await snapshot(broken.root)).toEqual(brokenBefore)
  // Windows gets four finite startup budgets; other platforms share the existing case deadline.
  }, CLI_REFUSAL_TEST_TIMEOUT_MS)
})
