#!/usr/bin/env node
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { isDeepStrictEqual } from 'node:util'
import { decodeSessionLog, repairSessionLogBytes, SessionLogRepairError, sha256 } from './session-log-codec.mjs'

// A narrowly scoped migration for the former four-event CLI accounting writer.
// It never guesses the historical CLI outcome or replays usage into the parent.
const HASH = /^[a-f0-9]{64}$/
const MAX_BYTES = 128 * 1024 * 1024
const LEGACY_TYPES = 'request/context,maestro/cli-child,step/start,assistant/attempt'
const HELP = `Usage:
  node scripts/repair-cli-session-logs.mjs --dsh-root ABSOLUTE_DSH_ROOT ABSOLUTE_LOG_PATH
  node scripts/repair-cli-session-logs.mjs --dsh-root ABSOLUTE_DSH_ROOT --apply --expect-sha256 HASH ABSOLUTE_LOG_PATH

Default: read-only dry-run. --apply and --dry-run are mutually exclusive.
Use the same installed DSH runtime as the log writer.
With packaged Electron, run with ELECTRON_RUN_AS_NODE=1 so ASAR modules are available.
Only the exact legacy four-event CLI accounting shape is repaired. All other corrupt
logs are refused. The installed v4 catalog validates the complete replacement.
Apply obtains the same kernel writer lease as DSH; an active writer refuses repair.
The original bytes receive a verified, durable backup before atomic replacement.
Original header, metadata, timestamps and usage are preserved; only seq shifts by one.
Running again on an already valid artifact makes no change. No usage is added to a ledger.
`
const fail = code => { throw new SessionLogRepairError(code) }
const comparable = path => process.platform === 'win32' ? path.toLowerCase() : path
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino
const sameFile = (a, b) => identity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink

function parseRows(bytes, encoding) {
  // Reuse the strict UTF-8/JSON/duplicate-key/header/envelope checks. The old
  // metadata-marking transformation is intentionally NOT used as output.
  repairSessionLogBytes(bytes, { encoding })
  const decoded = decodeSessionLog(bytes, { encoding })
  const rows = decoded.plaintext.toString('utf8').slice(0, -1).split('\n').map(line => JSON.parse(line))
  return { rows, decoded }
}
function legacyShape(rows) {
  const [header, context, marker, step, attempt] = rows
  if (rows.length !== 5 || header.isSeeded !== false || header.origin !== 'subagent'
    || typeof header.parentSession !== 'string' || !header.parentSession
    || rows.slice(1).map(event => event.type).join(',') !== LEGACY_TYPES) return false
  if (rows.slice(1).some(event => Object.hasOwn(event, 'surfaceOp') || Object.hasOwn(event, 'sourceEventSeqs'))) return false
  const meta = marker.data
  return marker.ignorable === true && meta?.version === 1 && meta.kind === 'cli-record'
    && meta.executor === 'external-cli' && typeof meta.taskId === 'string' && meta.taskId.startsWith('task-')
    && header.id === `cli-${meta.taskId}` && meta.childSessionId === header.id && meta.parentSessionId === header.parentSession
    && ['cli:codex', 'cli:claude'].includes(meta.source) && typeof meta.usageId === 'string' && meta.usageId.length > 0
    && meta.accounting === 'native-mirror-of-parent-cli-ledger' && meta.parentAndNativeSameSpend === true
    && meta.nativeInputSemantics === 'uncached' && typeof context.data?.provider === 'string' && context.data.provider.length > 0
    && typeof context.data?.model === 'string' && context.data.model.length > 0
    && step.data?.turn === 1 && step.data.step === 1 && attempt.data?.turn === 1 && attempt.data.step === 1
    && Array.isArray(attempt.data.stream)
}
function usageOf(rows) {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, attempts: 0, messages: 0 }
  for (const event of rows.slice(1)) {
    if (event.type !== 'assistant/attempt' && event.type !== 'assistant/message') continue
    total[event.type === 'assistant/attempt' ? 'attempts' : 'messages']++
    // A stream carries cumulative usage: the last sample owns the settlement.
    const samples = (event.data.stream ?? []).filter(entry => entry.type === 'chunk' && entry.chunk?.type === 'usage')
    const usage = event.data.usage ?? samples.at(-1)?.chunk.usage
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
      const value = usage?.[key]
      if (value === undefined) continue
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('INVALID_LEGACY_USAGE')
      total[key] += value
    }
  }
  return total
}

/** Pure plan: validate with the installed host, preserving all accounting data. */
export function planCliSessionRepair(raw, options = {}) {
  if (typeof options.validateRows !== 'function') fail('HOST_VALIDATOR_REQUIRED')
  const { rows, decoded } = parseRows(raw, options.encoding)
  const originalSha256 = sha256(raw)
  const usage = usageOf(rows)
  const stats = { sessionId: rows[0].id, encoding: decoded.encoding, originalSha256,
    resultSha256: originalSha256, headerSha256: sha256(Buffer.from(JSON.stringify(rows[0]))),
    originalEvents: rows.length - 1, resultEvents: rows.length - 1, addedEvents: 0, usage }
  let alreadyValid = false
  try { options.validateRows(rows); alreadyValid = true } catch { /* Only the exact known legacy shape may be transformed below. */ }
  if (alreadyValid) return { bytes: raw, rows, stats, changed: false }
  if (!legacyShape(rows)) fail('NOT_RECOGNIZED_LEGACY_CLI_LOG')
  const [header, ...events] = rows
  const first = events[0].time, last = events.at(-1).time
  if (last < first) fail('INVALID_LEGACY_TIMELINE')
  const repaired = [header, ...[
    { type: 'turn/start', time: first, data: { turn: 1 } },
    ...events,
    { type: 'step/end', time: last, data: { turn: 1, step: 1 } },
    { type: 'turn/end', time: last, data: { turn: 1, reason: { kind: 'error', error: {
      code: 'LEGACY_CLI_OUTCOME_UNKNOWN',
      message: 'Legacy CLI outcome unavailable; preserve original assistant/attempt accounting.',
    } } } },
  ].map((event, seq) => ({ ...event, seq }))]
  options.validateRows(repaired)
  if (!isDeepStrictEqual(header, repaired[0]) || !isDeepStrictEqual(usage, usageOf(repaired))) fail('ACCOUNTING_CONSERVATION_FAILED')
  for (let index = 0; index < events.length; index++) {
    const { seq, ...before } = events[index]
    const { seq: shifted, ...after } = repaired[index + 2]
    if (shifted !== seq + 1 || !isDeepStrictEqual(before, after)) fail('ORIGINAL_EVENT_CHANGED')
  }
  const plaintext = Buffer.from(repaired.map(row => JSON.stringify(row)).join('\n') + '\n')
  let bytes = plaintext
  if (decoded.encoding === 'zstd') {
    // Persistence requires the header to occupy its own complete frame.
    const originalHeaderFrame = raw.subarray(decoded.frames[0].start, decoded.frames[0].end)
    const eventText = Buffer.from(repaired.slice(1).map(row => JSON.stringify(row)).join('\n') + '\n')
    bytes = Buffer.concat([originalHeaderFrame, zstdCompressSync(eventText)])
  }
  const checked = parseRows(bytes, decoded.encoding).rows
  if (!isDeepStrictEqual(checked, repaired)) fail('REENCODE_VERIFICATION_FAILED')
  options.validateRows(checked)
  return { bytes, rows: repaired, changed: true, stats: { ...stats, resultSha256: sha256(bytes), resultEvents: repaired.length - 1, addedEvents: 3 } }
}

async function checkedPath(input, directory = false) {
  if (typeof input !== 'string' || !input || input.includes('\0') || !isAbsolute(input)) fail('ABSOLUTE_PATH_REQUIRED')
  if (process.platform === 'win32' && (/^\\\\/.test(input) || input.slice(parse(input).root.length).includes(':'))) fail('SPECIAL_PATH_REFUSED')
  const target = resolve(input), root = parse(target).root
  let current = root
  const parts = target.slice(root.length).split(sep).filter(Boolean)
  const rootStat = await lstat(root, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('UNSAFE_PATH_COMPONENT')
  for (const [index, part] of parts.entries()) {
    if (process.platform === 'win32' && (/[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('SPECIAL_PATH_REFUSED')
    current = join(current, part)
    const stat = await lstat(current, { bigint: true })
    if (stat.isSymbolicLink()) fail('LINK_REFUSED')
    if (index < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile()) fail('SPECIAL_FILE_REFUSED')
  }
  if (comparable(resolve(await realpath(target))) !== comparable(target)) fail('NONCANONICAL_PATH_REFUSED')
  return target
}
async function stableRead(input) {
  const path = await checkedPath(input)
  const before = await lstat(path, { bigint: true })
  if (before.nlink !== 1n) fail('HARD_LINK_REFUSED')
  if (before.size <= 0n || before.size > BigInt(MAX_BYTES)) fail('INVALID_INPUT_SIZE')
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
  if (process.platform === 'win32') return false
  const handle = await open(path, 'r')
  try { await handle.sync(); return true } finally { await handle.close() }
}
async function createDurable(path, bytes) {
  await checkedPath(dirname(path), true)
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  const stored = await stableRead(path)
  if (!stored.bytes.equals(bytes)) fail('DURABLE_FILE_VERIFY_FAILED')
  await syncDirectory(dirname(path))
  return stored
}

/** Hold DSH's real writer lease across read, verified backup and atomic publish. */
export async function repairCliSessionLogFile(input, options = {}) {
  const runtime = options.runtime
  if (typeof runtime?.validateRows !== 'function') fail('HOST_VALIDATOR_REQUIRED')
  const source = await stableRead(input)
  const filename = source.path.slice(source.path.lastIndexOf(sep) + 1)
  if (!/^session\.v4\.jsonl(?:\.zst|\.zstd)?$/.test(filename)) fail('V4_LOG_FILENAME_REQUIRED')
  const encoding = filename.endsWith('.jsonl') ? 'jsonl' : 'zstd'
  const plan = planCliSessionRepair(source.bytes, { encoding, validateRows: runtime.validateRows })
  const report = { path: source.path, ...plan.stats }
  if (options.apply !== true) return { status: 'dry-run', changed: plan.changed, ...report }
  if (!plan.changed) return { status: 'unchanged', changed: false, ...report }
  if (!HASH.test(options.expectSha256 ?? '') || options.expectSha256 !== plan.stats.originalSha256) fail('EXPECTED_SHA256_REQUIRED_OR_MISMATCH')
  if (typeof runtime.acquireLease !== 'function') fail('HOST_WRITER_LEASE_REQUIRED')
  if ((source.stat.mode & 0o200n) === 0n) fail('READONLY_SOURCE_REFUSED')
  const lease = await runtime.acquireLease(dirname(source.path), plan.stats.sessionId)
  if (typeof lease?.release !== 'function') fail('INVALID_HOST_WRITER_LEASE')
  let tempPath, tempStat, published = false
  try {
    const current = await stableRead(source.path)
    if (!sameFile(source.stat, current.stat) || !source.bytes.equals(current.bytes)) fail('SOURCE_CHANGED')
    const backupPath = `${source.path}.maestro-cli-original-${plan.stats.originalSha256}.bak`
    let backup
    try { backup = await createDurable(backupPath, source.bytes) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      backup = await stableRead(backupPath)
      if (!backup.bytes.equals(source.bytes)) fail('BACKUP_ALREADY_EXISTS_WITH_DIFFERENT_BYTES')
    }
    tempPath = `${source.path}.maestro-cli-repair-${randomUUID()}.tmp`
    const temporary = await createDurable(tempPath, plan.bytes)
    tempStat = temporary.stat
    const verification = planCliSessionRepair(temporary.bytes, { encoding, validateRows: runtime.validateRows })
    if (verification.changed || verification.stats.originalSha256 !== plan.stats.resultSha256
      || !isDeepStrictEqual(verification.stats.usage, plan.stats.usage)) fail('TEMP_VERIFY_FAILED')
    const beforeRename = await stableRead(source.path)
    if (!sameFile(source.stat, beforeRename.stat) || !source.bytes.equals(beforeRename.bytes)) fail('SOURCE_CHANGED')
    await checkedPath(tempPath)
    if (!sameFile(tempStat, await lstat(tempPath, { bigint: true }))) fail('TEMP_CHANGED')
    await rename(tempPath, source.path)
    published = true
    const directorySynced = await syncDirectory(dirname(source.path))
    const final = await stableRead(source.path)
    if (!identity(tempStat, final.stat) || sha256(final.bytes) !== plan.stats.resultSha256) fail('POST_RENAME_VERIFY_FAILED')
    runtime.validateRows(parseRows(final.bytes, encoding).rows)
    return { status: 'applied', changed: true, ...report, backupPath, backupSha256: sha256(backup.bytes), directorySynced }
  } finally {
    // Never delete or roll back an unverified/replaced path after publication.
    if (!published && tempPath && tempStat) {
      try {
        await checkedPath(tempPath)
        const current = await lstat(tempPath, { bigint: true })
        if (current.nlink === 1n && identity(current, tempStat)) await unlink(tempPath)
      } catch { /* Preserve unknown artifacts for review. */ }
    }
    await lease.release()
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) { console.log(HELP); return }
  let dshRoot, path, expectSha256, apply = false, dryRun = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--apply') apply = true
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--dsh-root') dshRoot = argv[++index]
    else if (arg === '--expect-sha256') expectSha256 = argv[++index]
    else if (arg.startsWith('-') || path) fail('INVALID_ARGUMENTS')
    else path = arg
  }
  // Reject incompatible modes before loading the host or opening any log.
  if (apply && dryRun) fail('INVALID_ARGUMENTS')
  if (!dshRoot || !path) fail('DSH_ROOT_AND_LOG_REQUIRED')
  const { loadArtifactRuntime } = await import('./lib/session-artifact-runtime.mjs')
  const runtime = await loadArtifactRuntime(dshRoot)
  console.log(JSON.stringify(await repairCliSessionLogFile(path, { runtime, apply, expectSha256 })))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ ok: false, code: error instanceof SessionLogRepairError ? error.code : 'CLI_LOG_REPAIR_FAILED' })); process.exitCode = 1 })
}
