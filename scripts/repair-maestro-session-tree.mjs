#!/usr/bin/env node
import { connect } from 'node:net'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRepairArgs, repairSessionLogFile } from './repair-maestro-session-logs.mjs'
import { scanSessionLogs } from './scan-maestro-session-logs.mjs'
import { SessionLogRepairError } from './session-log-codec.mjs'

const HELP = `Usage:
  node scripts/repair-maestro-session-tree.mjs [--dry-run] ABSOLUTE_SESSION_ROOT
  node scripts/repair-maestro-session-tree.mjs --apply --confirm-dsh-fully-exited [--port PORT] ABSOLUTE_SESSION_ROOT

Default: read-only scan of format-v4 logs at root/workspace/session depth (0..2).
Apply ALWAYS builds a fresh scan plan; old reports/hashes are not accepted.
Any refused log or skipped link blocks the ENTIRE apply before any writes.
ALL DSH processes, including headless writers, must have fully exited. Keep them
closed until this command finishes. Closed ports alone do NOT prove writer safety.
CLI always checks 14983 on IPv4/IPv6; repeat --port to ADD other known listeners.
Only the existing single-file repair API creates backups and replaces logs.
This is NOT a tree transaction: the first error stops work WITHOUT rollback.
Keep all backups and manually inspect successful AND failed files after an error;
a failed single-file call may already have created a backup or published a repair.
Backups contain original sensitive data; protect the directory (Windows ACLs inherit).
repaired/markedEvents count confirmed applications; scan.summary describes the plan.
Successful apply verifies changed:0 and the result hash for every planned file.
This metadata-only repair is NOT a complete DSH session replay validation.
Exit codes: 0 success, 1 refusal/partial failure, 2 dry-run found refusals/links.
`
const SCAN_CODES = new Set(['ABSOLUTE_SESSION_ROOT_REQUIRED', 'UNSAFE_SESSION_ROOT', 'DIRECTORY_SCAN_LIMIT', 'DIRECTORY_CHANGED', 'LOG_SCAN_LIMIT'])
// Allowlist, not arbitrary error.message/error.code text (including scanner errors).
const PUBLIC_CODES = new Set(`
INVALID_ARGUMENTS INVALID_EXPECTED_SHA256 INVALID_PORT FRESH_SCAN_REQUIRED
ABSOLUTE_SESSION_ROOT_REQUIRED SCAN_REFUSALS_OR_LINKS PLAN_CHANGED IDEMPOTENCE_VERIFY_FAILED
ABSOLUTE_PATH_REQUIRED SPECIAL_PATH_REFUSED UNSAFE_PATH_COMPONENT LINK_REFUSED
SPECIAL_FILE_REFUSED NONCANONICAL_PATH_REFUSED HARD_LINK_REFUSED INVALID_INPUT_SIZE
SOURCE_CHANGED LOG_EXTENSION_REQUIRED EXPECTED_SHA256_REQUIRED_OR_MISMATCH
EXPLICIT_OFFLINE_CONFIRMATION_REQUIRED READONLY_SOURCE_REFUSED DSH_PORT_IS_LISTENING
OFFLINE_CHECK_INCONCLUSIVE BACKUP_ALREADY_EXISTS BACKUP_VERIFY_FAILED
DURABLE_FILE_VERIFY_FAILED TEMP_ALREADY_EXISTS TEMP_VERIFY_FAILED TEMP_CHANGED POST_RENAME_VERIFY_FAILED
INVALID_LIMIT TRUNCATED_ZSTD_FRAME UNSUPPORTED_ZSTD_MAGIC ZSTD_RESERVED_BITS
ZSTD_WINDOW_LIMIT ZSTD_DICTIONARY_UNSUPPORTED DECODED_SIZE_LIMIT TOO_MANY_ZSTD_FRAMES
TOO_MANY_ZSTD_BLOCKS ZSTD_RESERVED_BLOCK ZSTD_BLOCK_SIZE_LIMIT UNSUPPORTED_ENCODING
ZSTD_DECODE_FAILED ZSTD_CONTENT_SIZE_MISMATCH INVALID_JSON JSON_DEPTH_LIMIT
DUPLICATE_JSON_KEY INVALID_RECORD UNSUPPORTED_OR_INVALID_V4_HEADER INVALID_EVENT_ENVELOPE
TORN_JSONL_TAIL INVALID_UTF8 JSON_LINE_SIZE_LIMIT UNSAFE_INSERTION INVALID_ZSTD_HEADER_FRAME
ZSTD_ENCODE_FAILED REENCODE_VERIFICATION_FAILED REPAIR_VERIFICATION_FAILED
`.trim().split(/\s+/))
const IO_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EIO', 'EROFS', 'EBUSY', 'ENOTDIR', 'EMFILE', 'ENFILE'])
function publicCode(error, fallback = 'TREE_REPAIR_FAILED') {
  if (PUBLIC_CODES.has(error?.code)) return error.code
  if (IO_CODES.has(error?.code)) return `IO_${error.code}`
  if (SCAN_CODES.has(error?.message)) return error.message
  return fallback
}
function fail(code) { throw new SessionLogRepairError(code) }
class TreeRepairError extends SessionLogRepairError {
  constructor(code, report) { super(code); this.report = report }
}

// The file API also checks immediately before writing/renaming. This preflight
// ensures even an empty/already-repaired apply checks every requested port.
async function assertPortsClosed(ports) {
  for (const port of new Set(ports)) for (const host of ['127.0.0.1', '::1']) {
    await new Promise((resolvePromise, reject) => {
      let settled = false
      const socket = connect({ host, port })
      const finish = code => {
        if (settled) return
        settled = true
        socket.destroy()
        if (code) reject(new SessionLogRepairError(code))
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
}

/** Offline, sequential, fail-fast. Errors carry a payload-free .report of confirmed progress. */
export async function repairSessionLogTree(rootInput, options = {}) {
  const apply = options.apply === true
  const confirmed = options.confirmDshFullyExited === true
  const report = {
    schemaVersion: 1, mode: apply ? 'apply' : 'dry-run', status: 'refused', transactional: false,
    repaired: 0, markedEvents: 0, planned: 0, applied: [], verification: [], remaining: [],
    recovery: 'No automatic rollback. Preserve backups and manually inspect successful and failed files after any failure.',
  }
  let phase = 'preflight'
  let current
  try {
    if (apply && !confirmed) fail('EXPLICIT_OFFLINE_CONFIRMATION_REQUIRED')
    if (typeof rootInput !== 'string' || !isAbsolute(rootInput)) fail('ABSOLUTE_SESSION_ROOT_REQUIRED')
    report.root = resolve(rootInput)
    const requestedPorts = options.ports ?? [14983]
    if (!Array.isArray(requestedPorts) || !requestedPorts.length
      || requestedPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) fail('INVALID_PORT')
    const ports = [...requestedPorts]
    phase = 'scan'
    const scan = await scanSessionLogs(report.root)
    scan.refused = scan.refused.map(item => ({ path: item.path, code: publicCode(item, 'SCAN_FILE_REFUSED') }))
    report.scan = scan
    const plan = scan.logs.filter(log => log.changed > 0)
    report.planned = plan.length
    report.remaining = plan.map(log => log.path)
    if (!apply) { report.status = 'dry-run'; return report }
    if (scan.summary.refused || scan.summary.skippedLinks || scan.refused.length || scan.skipped.length) fail('SCAN_REFUSALS_OR_LINKS')
    phase = 'offline-check'
    await assertPortsClosed(ports)
    for (const log of plan) {
      current = log
      phase = 'apply'
      const result = await repairSessionLogFile(log.path, {
        apply: true, confirmDshFullyExited: confirmed, ports, expectSha256: log.originalSha256,
      })
      if (result.status === 'applied') {
        // Record the file API's confirmed success BEFORE our additional readback.
        report.applied.push({
          path: result.path, status: result.status, changed: result.changed,
          originalSha256: result.originalSha256, resultSha256: result.resultSha256, backupPath: result.backupPath,
        })
        report.repaired++
        report.markedEvents += result.changed
      }
      // In particular, do not silently accept the file API's changed:0 shortcut
      // if somebody replaced a planned file between scanning and applying.
      if (result.status !== 'applied' || result.originalSha256 !== log.originalSha256
        || result.resultSha256 !== log.resultSha256 || result.changed !== log.changed) fail('PLAN_CHANGED')
      phase = 'verify'
      const verification = await repairSessionLogFile(log.path, { apply: false })
      if (verification.changed !== 0 || verification.originalSha256 !== result.resultSha256) fail('IDEMPOTENCE_VERIFY_FAILED')
      report.verification.push({ path: log.path, changed: 0, sha256: verification.originalSha256 })
      report.remaining.shift()
      current = undefined
    }
    report.status = report.repaired ? 'applied' : 'unchanged'
    return report
  } catch (error) {
    const code = publicCode(error, phase === 'scan' ? 'SCAN_FAILED' : 'TREE_REPAIR_FAILED')
    report.status = report.repaired ? 'partial' : 'refused'
    report.error = { code, phase }
    report.manualInspectionRequired = phase === 'apply' || phase === 'verify'
    if (current) {
      report.error.path = current.path
      // This is only a candidate: a failed API call need not have made a backup.
      report.error.possibleBackupPath = `${current.path}.maestro-original-${current.originalSha256}.bak`
    }
    throw new TreeRepairError(code, report)
  }
}

export function parseTreeRepairArgs(args) {
  const request = parseRepairArgs(args)
  if (request.help) return request
  const { expectSha256, ...options } = request.options
  if (expectSha256 !== undefined) fail('FRESH_SCAN_REQUIRED')
  return { root: request.path, options }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const request = parseTreeRepairArgs(process.argv.slice(2))
    if (request.help) console.log(HELP)
    else {
      const report = await repairSessionLogTree(request.root, request.options)
      console.log(JSON.stringify(report))
      if (report.scan.summary.refused || report.scan.summary.skippedLinks) process.exitCode = 2
    }
  } catch (error) {
    console.error(JSON.stringify(error instanceof TreeRepairError ? error.report : { status: 'refused', code: publicCode(error) }))
    process.exitCode = 1
  }
}
