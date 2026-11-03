#!/usr/bin/env node
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { repairSessionLogFile } from './repair-maestro-session-logs.mjs'
import { MAESTRO_METADATA_TYPES } from './session-log-codec.mjs'

// Read-only inventory. It never applies a repair, loads a Session, or prints data.
const MAX_DIRECTORIES = 10_000
const MAX_LOGS = 5_000
const LOG_NAMES = new Set(['session.v4.jsonl.zstd', 'session.v4.jsonl.zst', 'session.v4.jsonl'])
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const codeOf = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'SCAN_FAILED'

export async function scanSessionLogs(rootInput) {
  if (!isAbsolute(rootInput)) throw new Error('ABSOLUTE_SESSION_ROOT_REQUIRED')
  const root = resolve(rootInput)
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(root), root)) throw new Error('UNSAFE_SESSION_ROOT')
  const paths = []
  const skipped = []
  const refused = []
  let directories = 0
  async function walk(directory, depth) {
    if (++directories > MAX_DIRECTORIES) throw new Error('DIRECTORY_SCAN_LIMIT')
    const current = await lstat(directory)
    if (!current.isDirectory() || current.isSymbolicLink() || !samePath(await realpath(directory), directory)) throw new Error('DIRECTORY_CHANGED')
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) { skipped.push({ path, reason: 'link' }); continue }
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (depth < 2) await walk(path, depth + 1)
        continue
      }
      if (entry.isFile() && LOG_NAMES.has(entry.name)) {
        if (paths.length >= MAX_LOGS) throw new Error('LOG_SCAN_LIMIT')
        paths.push(path)
      }
    }
  }
  await walk(root, 0)
  const logs = []
  for (const path of paths) {
    try { logs.push(await repairSessionLogFile(path)) }
    catch (error) { refused.push({ path, code: codeOf(error) }) }
  }
  const targets = Object.fromEntries(MAESTRO_METADATA_TYPES.map(type => [type, 0]))
  for (const log of logs) for (const type of Object.keys(targets)) targets[type] += log.targets[type].marked
  return {
    schemaVersion: 1, mode: 'dry-run', root, generatedAt: new Date().toISOString(),
    // Expected layout: root/workspace/session/session.v4.jsonl[.zstd].
    scope: 'format-v4 files at depth 0..2; no links, hidden descendants, or other formats',
    summary: {
      discovered: paths.length, inspected: logs.length, affected: logs.filter(log => log.changed > 0).length,
      unchanged: logs.filter(log => log.changed === 0).length, refused: refused.length, skippedLinks: skipped.length,
      events: logs.reduce((sum, log) => sum + log.eventCount, 0),
      markedEvents: logs.reduce((sum, log) => sum + log.changed, 0), targets,
    }, logs, refused, skipped,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, flag, reportPath, ...rest] = process.argv.slice(2)
    if (!root || rest.length || (flag !== undefined && (flag !== '--report' || !reportPath || !isAbsolute(reportPath)))) {
      throw new Error('Usage: node scripts/scan-maestro-session-logs.mjs ABSOLUTE_SESSION_ROOT [--report ABSOLUTE_NEW_REPORT_PATH]')
    }
    const report = await scanSessionLogs(root)
    if (reportPath) {
      // Exclusive create: a prior report can never be overwritten by this scan.
      const file = await open(reportPath, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); await file.sync() } finally { await file.close() }
      console.log(JSON.stringify({ ...report.summary, reportPath, refused: report.refused }))
    } else console.log(JSON.stringify(report))
    if (report.refused.length) process.exitCode = 2
  } catch (error) {
    console.error(JSON.stringify({ status: 'scan-refused', code: codeOf(error) }))
    process.exitCode = 1
  }
}
