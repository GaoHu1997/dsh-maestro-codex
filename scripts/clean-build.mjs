import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const equalPath = (left, right) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase()
  : left === right

function inside(parent, child) {
  const rest = relative(parent, child)
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`))
}

function assertPlainPath(path, directory = false) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error(`Refusing linked or special build path: ${path}`)
  }
  if (directory && !stat.isDirectory()) throw new Error(`Build directory is not a directory: ${path}`)
  if (!equalPath(realpathSync.native(path), resolve(path))) {
    throw new Error(`Refusing redirected build path: ${path}`)
  }
  return stat
}

function ancestors(path) {
  const result = []
  let current = parse(path).root
  result.push(current)
  for (const part of relative(current, path).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    result.push(current)
  }
  return result
}

// lstat rejects Windows symlinks/junctions; FileAttributes additionally rejects
// every other reparse tag before any directory is enumerated. No -Recurse is
// used: each child is checked before it can enter the traversal stack.
function assertNoWindowsReparse(paths, target) {
  if (process.platform !== 'win32') return
  const command = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = ConvertFrom-Json ([Console]::In.ReadToEnd())
function Assert-Plain($path) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw ('Refusing reparse build path: ' + $path)
  }
}
foreach ($path in $request.paths) { Assert-Plain $path }
if ($request.target) {
  Assert-Plain $request.target
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($request.target)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    Assert-Plain $directory
    foreach ($child in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
      Assert-Plain $child.FullName
      if ($child.PSIsContainer) { $pending.Push($child.FullName) }
    }
  }
}
`
  execFileSync(join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      input: JSON.stringify({ paths, target }), encoding: 'utf8', windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
    })
}

/** Clear only lib under this plugin; a nested root is permitted for tests. */
export function cleanBuildOutputs(root = PLUGIN_ROOT) {
  if (!isAbsolute(root)) throw new Error('Build root must be absolute')
  root = resolve(root)
  if (!inside(PLUGIN_ROOT, root)) throw new Error(`Build root is outside the plugin: ${root}`)
  const paths = ancestors(root)
  // Reject reparse ancestors even when lib is absent, before probing the target.
  assertNoWindowsReparse(paths, null)
  for (const path of paths) assertPlainPath(path, true)
  const target = resolve(root, 'lib')
  if (relative(root, target) !== 'lib' || !inside(PLUGIN_ROOT, target)) {
    throw new Error(`Unsafe build output target: ${target}`)
  }
  try { lstatSync(target) } catch (error) {
    if (error.code === 'ENOENT') return { target, removed: false }
    throw error
  }
  assertNoWindowsReparse(paths, target)
  assertPlainPath(target, true)
  const pending = [target]
  while (pending.length) {
    const directory = pending.pop()
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      const stat = assertPlainPath(path)
      if (stat.isDirectory()) pending.push(path)
    }
  }
  // Validation completes before the first write; recheck the absolute boundary
  // immediately before deletion. rm never follows a symlink leaf.
  for (const path of paths) assertPlainPath(path, true)
  assertPlainPath(target, true)
  rmSync(target, { recursive: true, force: false })
  return { target, removed: true }
}

if (process.argv[1] && equalPath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 2) throw new Error('clean-build accepts no path arguments')
  const result = cleanBuildOutputs()
  console.log(`[maestro-build] ${result.removed ? 'Cleaned' : 'No existing'} ${result.target}`)
}
