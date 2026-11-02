#!/usr/bin/env node
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { repairSessionLogBytes, SessionLogRepairError, sha256 } from './session-log-codec.mjs'

// OFFLINE MAINTENANCE ONLY. A closed TCP port is not a writer lock. The caller
// must also confirm ALL DSH processes (including headless hosts) have exited.
// Do not launch DSH until this command finishes. No lock-file/rename heuristic
// establishes writer safety on Windows: DSH uses a named kernel semaphore.
const MAX_FILE_BYTES = 128 * 1024 * 1024
const HASH = /^[a-f0-9]{64}$/
const HELP = `Usage:
  node scripts/repair-maestro-session-logs.mjs [--dry-run] ABSOLUTE_LOG_PATH
  node scripts/repair-maestro-session-logs.mjs --apply --confirm-dsh-fully-exited --expect-sha256 HASH [--port 14983] ABSOLUTE_LOG_PATH

Default: read-only dry-run, one explicitly selected format-v4 .jsonl, .jsonl.zst or .jsonl.zstd file.
Only the three Maestro private event types receive a top-level ignorable:true.
Other event types remain unchanged; successful marking is NOT a full harness replay validation.
Apply requires a matching dry-run SHA256, ALL DSH processes exited, and closed loopback ports.
Repeat --port for every known DSH listener; 14983 is always checked by default.
Ports being closed alone do NOT prove all writers are gone. No HTTP requests are sent.
An exclusive, fsynced, SHA256-verified byte-for-byte original backup is never overwritten.
Backups contain the original sensitive data: keep the parent directory access-restricted.
On Windows new files inherit the directory ACL; file mode 0600 is not an ACL-preservation guarantee.
Only standard dictionary-free concatenated ZSTD frames are supported. Torn/invalid data is refused.
No files are deleted except this invocation's verified temporary replacement on failure.
`
function fail(code) { throw new SessionLogRepairError(code) }
function comparable(path) { return process.platform === 'win32' ? path.toLowerCase() : path }
function identity(a, b) { return a.dev === b.dev && a.ino === b.ino }
function sameFile(a, b) {
  return identity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink
}

/** Reject links/junctions, alternate streams, noncanonical aliases and special filesystem objects. */
async function checkedPath(input, directory = false) {
  if (typeof input !== 'string' || !input || input.includes('\0') || !isAbsolute(input)) fail('ABSOLUTE_PATH_REQUIRED')
  if (process.platform === 'win32' && (/^\\\\/.test(input) || input.slice(parse(input).root.length).includes(':'))) fail('SPECIAL_PATH_REFUSED')
  const target = resolve(input)
  const root = parse(target).root
  let current = root
  const parts = target.slice(root.length).split(sep).filter(Boolean)
  const rootStat = await lstat(root, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('UNSAFE_PATH_COMPONENT')
  for (const [index, part] of parts.entries()) {
    if (process.platform === 'win32' && (/[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('SPECIAL_PATH_REFUSED')
    current = join(current, part)
    const stat = await lstat(current, { bigint: true })
    if (stat.isSymbolicLink()) fail('LINK_REFUSED')
    const parent = index < parts.length - 1 || directory
    if (parent ? !stat.isDirectory() : !stat.isFile()) fail('SPECIAL_FILE_REFUSED')
  }
  if (comparable(resolve(await realpath(target))) !== comparable(target)) fail('NONCANONICAL_PATH_REFUSED')
  return target
}

/** Read a stable regular file without following its final component. No bytes escape in a report. */
async function stableRead(input) {
  const path = await checkedPath(input)
  const before = await lstat(path, { bigint: true })
  if (before.nlink !== 1n) fail('HARD_LINK_REFUSED')
  if (before.size <= 0n || before.size > BigInt(MAX_FILE_BYTES)) fail('INVALID_INPUT_SIZE')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!sameFile(before, opened)) fail('SOURCE_CHANGED')
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (!sameFile(opened, after) || BigInt(bytes.length) !== after.size) fail('SOURCE_CHANGED')
    await checkedPath(path)
    if (!sameFile(after, await lstat(path, { bigint: true }))) fail('SOURCE_CHANGED')
    return { path, bytes, stat: after }
  } finally { await handle.close() }
}
async function syncDirectory(path) {
  // Node does not expose a portable directory durability barrier on Windows.
  // Each backup/temp file is still explicitly fsynced before rename.
  if (process.platform === 'win32') return false
  const handle = await open(path, 'r')
  try { await handle.sync(); return true } finally { await handle.close() }
}
async function createDurable(path, bytes, existsCode) {
  await checkedPath(dirname(path), true)
  let handle
  try { handle = await open(path, 'wx', 0o600) } catch (error) {
    if (error?.code === 'EEXIST') fail(existsCode)
    throw error
  }
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  const stored = await stableRead(path)
  if (!stored.bytes.equals(bytes) || sha256(stored.bytes) !== sha256(bytes)) fail('DURABLE_FILE_VERIFY_FAILED')
  await syncDirectory(dirname(path))
  return stored
}
function closedPort(host, port) {
  return new Promise((resolvePromise, reject) => {
    let settled = false
    const socket = connect({ host, port })
    const finish = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(new SessionLogRepairError(error))
      else resolvePromise()
    }
    // Verdict window 10s: a refused loopback connect can take seconds when a
    // filter driver delays SYNs (~2.4s measured on the target machine).
    socket.setTimeout(10000, () => finish('OFFLINE_CHECK_INCONCLUSIVE'))
    socket.once('connect', () => finish('DSH_PORT_IS_LISTENING'))
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') finish()
      else if (host === '::1' && ['EAFNOSUPPORT', 'EPROTONOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) finish()
      else finish('OFFLINE_CHECK_INCONCLUSIVE')
    })
  })
}
async function assertOffline(confirmed, ports) {
  if (confirmed !== true) fail('EXPLICIT_OFFLINE_CONFIRMATION_REQUIRED')
  if (!Array.isArray(ports) || ports.length === 0 || ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) fail('INVALID_PORT')
  for (const port of new Set(ports)) {
    await closedPort('127.0.0.1', port)
    await closedPort('::1', port)
  }
}
async function cleanOwnTemp(path, stat) {
  if (!path || !stat) return
  try {
    await checkedPath(path)
    const current = await lstat(path, { bigint: true })
    if (current.nlink !== 1n || !identity(current, stat)) return
    await unlink(path)
  } catch { /* Preserve an unverified/replaced path instead of deleting someone else's file. */ }
}

/** Reports only hashes/counts/paths. This does not acquire the private DSH writer semaphore. */
export async function repairSessionLogFile(input, options = {}) {
  const source = await stableRead(input)
  const encoding = /\.jsonl\.zstd?$/.test(source.path) ? 'zstd' : source.path.endsWith('.jsonl') ? 'jsonl' : undefined
  if (!encoding) fail('LOG_EXTENSION_REQUIRED')
  const plan = repairSessionLogBytes(source.bytes, { encoding })
  const report = { path: source.path, ...plan.stats }
  if (options.apply !== true) return { status: 'dry-run', ...report }
  // A repeated command is a no-op, even when it still carries the pre-repair hash.
  if (plan.stats.changed === 0) return { status: 'unchanged', ...report }
  if (!HASH.test(options.expectSha256 ?? '') || options.expectSha256 !== plan.stats.originalSha256) fail('EXPECTED_SHA256_REQUIRED_OR_MISMATCH')
  if ((source.stat.mode & 0o200n) === 0n) fail('READONLY_SOURCE_REFUSED')
  const ports = options.ports ?? [14983]
  await assertOffline(options.confirmDshFullyExited, ports)
  const current = await stableRead(source.path)
  if (!sameFile(source.stat, current.stat) || !current.bytes.equals(source.bytes)) fail('SOURCE_CHANGED')
  const backupPath = `${source.path}.maestro-original-${plan.stats.originalSha256}.bak`
  const backup = await createDurable(backupPath, source.bytes, 'BACKUP_ALREADY_EXISTS')
  if (sha256(backup.bytes) !== plan.stats.originalSha256) fail('BACKUP_VERIFY_FAILED')
  let tempPath
  let tempStat
  let published = false
  try {
    tempPath = `${source.path}.maestro-repair-${randomUUID()}.tmp`
    const temporary = await createDurable(tempPath, plan.bytes, 'TEMP_ALREADY_EXISTS')
    tempStat = temporary.stat
    const verification = repairSessionLogBytes(temporary.bytes, { encoding })
    if (verification.stats.changed !== 0 || verification.stats.originalSha256 !== plan.stats.resultSha256
      || verification.stats.eventCount !== plan.stats.eventCount || verification.stats.headerSha256 !== plan.stats.headerSha256) fail('TEMP_VERIFY_FAILED')
    await assertOffline(options.confirmDshFullyExited, ports)
    const beforeRename = await stableRead(source.path)
    if (!sameFile(source.stat, beforeRename.stat) || !beforeRename.bytes.equals(source.bytes)) fail('SOURCE_CHANGED')
    await checkedPath(tempPath)
    if (!sameFile(tempStat, await lstat(tempPath, { bigint: true }))) fail('TEMP_CHANGED')
    // The caller's offline guarantee is essential: path checks cannot close an
    // adversarial/active-writer TOCTOU race without the host's private lock.
    await rename(tempPath, source.path)
    published = true
    const directorySynced = await syncDirectory(dirname(source.path))
    const final = await stableRead(source.path)
    if (!identity(tempStat, final.stat) || sha256(final.bytes) !== plan.stats.resultSha256) fail('POST_RENAME_VERIFY_FAILED')
    return {
      status: 'applied', ...report, backupPath,
      backupSha256: sha256(backup.bytes), directorySynced,
    }
  } catch (error) {
    if (!published) await cleanOwnTemp(tempPath, tempStat)
    // Never roll back automatically after a rename: preserve the verified
    // original backup and require explicit review of any post-publish failure.
    throw error
  }
}

export function parseRepairArgs(args) {
  let apply = false
  let dryRun = false
  let confirmDshFullyExited = false
  let expectSha256
  const ports = [14983]
  const files = []
  let positional = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (positional) { files.push(arg); continue }
    if (arg === '--') { positional = true; continue }
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--apply') { apply = true; continue }
    if (arg === '--dry-run') { dryRun = true; continue }
    if (arg === '--confirm-dsh-fully-exited') { confirmDshFullyExited = true; continue }
    if (arg === '--expect-sha256') {
      expectSha256 = args[++i]
      if (!HASH.test(expectSha256 ?? '')) fail('INVALID_EXPECTED_SHA256')
      continue
    }
    if (arg === '--port') {
      const raw = args[++i]
      if (!raw || !/^[0-9]{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) fail('INVALID_PORT')
      ports.push(Number(raw)); continue
    }
    if (arg.startsWith('-')) fail('INVALID_ARGUMENTS')
    files.push(arg)
  }
  if (files.length !== 1 || (apply && dryRun) || (!apply && confirmDshFullyExited)) fail('INVALID_ARGUMENTS')
  return { path: files[0], options: { apply, confirmDshFullyExited, expectSha256, ports } }
}
function publicCode(error) {
  if (error instanceof SessionLogRepairError) return error.code
  if (['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EIO', 'EROFS', 'EBUSY', 'ENOTDIR'].includes(error?.code)) return `IO_${error.code}`
  return 'REPAIR_FAILED'
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const request = parseRepairArgs(process.argv.slice(2))
    if (request.help) console.log(HELP)
    else console.log(JSON.stringify(await repairSessionLogFile(request.path, request.options)))
  } catch (error) {
    console.error(JSON.stringify({ status: 'refused', code: publicCode(error) }))
    process.exitCode = 1
  }
}
