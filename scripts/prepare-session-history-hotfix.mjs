#!/usr/bin/env node
// Prepare a code-only hotfix plan. Never changes the installed plugin or logs.
import { createHash } from 'node:crypto'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const names = ['session-access', 'usage', 'usage-journal', 'child-session', 'native-recovery', 'tool', 'index']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function regular(path) {
  const stat = await lstat(path)
  // Reading package-manager hard links is safe. The offline installer uses
  // ReplaceFile, never an in-place write to shared package-store contents.
  if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('REGULAR_FILE_REQUIRED'), { refusedPath: path })
  const canonical = await realpath(path)
  if (canonical.toLowerCase() !== resolve(path).toLowerCase()) throw new Error('CANONICAL_FILE_REQUIRED')
  return readFile(path)
}

try {
  const [target, output, ...extra] = process.argv.slice(2)
  if (!target || !output || extra.length || !isAbsolute(target) || !isAbsolute(output)) throw new Error('ABSOLUTE_PLUGIN_AND_NEW_PLAN_PATH_REQUIRED')
  const installed = JSON.parse(await regular(join(target, 'package.json')))
  const local = JSON.parse(await regular(join(root, 'package.json')))
  if (installed.name !== 'dsh-maestro-codex' || installed.name !== local.name || installed.version !== local.version) throw new Error('PLUGIN_IDENTITY_OR_VERSION_MISMATCH')
  const files = []
  for (const name of names) {
    const relativePath = `lib/${name}.js`
    const before = await regular(join(target, relativePath))
    const after = await regular(join(root, relativePath))
    files.push({ path: relativePath, beforeSha256: hash(before), afterSha256: hash(after), bytes: after.length })
  }
  const plan = { schemaVersion: 1, plugin: local.name, version: local.version, sourceRoot: root, targetRoot: resolve(target), files }
  const file = await open(output, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(plan, null, 2) + '\n'); await file.sync() } finally { await file.close() }
  console.log(JSON.stringify({ status: 'prepared-not-installed', planPath: output, files: files.length, changed: files.filter(file => file.beforeSha256 !== file.afterSha256).length }))
} catch (error) {
  console.error(JSON.stringify({ status: 'preparation-refused', code: /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'PREPARATION_FAILED', refusedPath: error?.refusedPath, links: error?.links }))
  process.exitCode = 1
}
