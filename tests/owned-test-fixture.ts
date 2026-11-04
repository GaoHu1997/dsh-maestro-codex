import { execFileSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve } from 'node:path'

export interface OwnedTestFixture {
  path: string
  remove(): void
}

interface Entry {
  path: string
  directory: boolean
  link: boolean
  linkType?: string
}

const samePath = (left: string, right: string) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
  : resolve(left) === resolve(right)

function ancestors(path: string): string[] {
  const paths = [parse(path).root]
  for (const part of relative(paths[0], path).split(/[\\/]/).filter(Boolean)) paths.push(join(paths[paths.length - 1], part))
  return paths
}

function entries(path: string): Entry[] {
  if (process.platform === 'win32') {
    // Node22.19 can classify a junction as a normal directory (readlink also
    // returns EINVAL). Inspect native reparse attributes before enumerating;
    // never descend into ANY reparse point, including unfamiliar tags.
    const command = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = ConvertFrom-Json ([Console]::In.ReadToEnd())
foreach ($ancestor in $request.ancestors) {
  $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $item.PSIsContainer) {
    throw ('Redirected fixture ancestor: ' + $ancestor)
  }
}
$found = [Collections.Generic.List[object]]::new()
$pending = [Collections.Generic.Stack[string]]::new()
$pending.Push($request.path)
while ($pending.Count -gt 0) {
  $directory = $pending.Pop()
  $item = Get-Item -LiteralPath $directory -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $item.PSIsContainer) {
    throw ('Redirected fixture directory: ' + $directory)
  }
  foreach ($child in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
    $reparse = ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    $container = ($child.Attributes -band [IO.FileAttributes]::Directory) -ne 0
    $found.Add(@{ path = $child.FullName; directory = $container; link = $reparse; linkType = [string]$child.LinkType })
    if ($container -and -not $reparse) { $pending.Push($child.FullName) }
  }
}
ConvertTo-Json -InputObject @($found.ToArray()) -Compress
`
    const output = execFileSync(join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        input: JSON.stringify({ path, ancestors: ancestors(path) }), encoding: 'utf8', windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
      })
    return JSON.parse(output) as Entry[]
  }
  const found: Entry[] = []
  const pending = [path]
  while (pending.length) {
    const directory = pending.pop()!
    if (lstatSync(directory).isSymbolicLink() || !samePath(realpathSync.native(directory), directory)) {
      throw new Error(`Redirected fixture directory: ${directory}`)
    }
    for (const name of readdirSync(directory)) {
      const child = join(directory, name)
      const stat = lstatSync(child)
      const entry = { path: child, directory: stat.isDirectory(), link: stat.isSymbolicLink() }
      found.push(entry)
      if (entry.directory && !entry.link) pending.push(child)
    }
  }
  return found
}

/** Creates one exclusive fixture; its closure can remove only that exact inode. */
export function createOwnedTestFixture(parent: string, prefix: string): OwnedTestFixture {
  if (!prefix || prefix === '.' || prefix === '..' || /[\\/:]/.test(prefix)) throw new Error('Invalid fixture prefix')
  parent = resolve(parent)
  if (!samePath(realpathSync.native(parent), parent)) throw new Error(`Redirected fixture parent: ${parent}`)
  const path = mkdtempSync(join(parent, prefix))
  const original = lstatSync(path, { bigint: true })
  let removed = false
  return {
    path,
    remove() {
      if (removed) return
      const rest = relative(parent, path)
      if (isAbsolute(rest) || !rest.startsWith(prefix) || /[\\/]/.test(rest)) throw new Error(`Unsafe fixture cleanup: ${path}`)
      const stat = lstatSync(path, { bigint: true })
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== original.dev || stat.ino !== original.ino
        || !samePath(realpathSync.native(path), path)) throw new Error(`Replaced or redirected fixture cleanup: ${path}`)
      const plan = entries(path)
      // Validate the entire plan before the first deletion. Only a checked link
      // leaf may redirect; every ordinary child must retain its canonical path.
      for (const entry of plan) {
        const child = relative(path, entry.path)
        if (!child || isAbsolute(child) || child === '..' || child.startsWith('../') || child.startsWith('..\\')) {
          throw new Error(`Outside fixture entry: ${entry.path}`)
        }
        const current = lstatSync(entry.path)
        const canonical = realpathSync.native(entry.path)
        if (entry.link) {
          if (process.platform === 'win32' && !['Junction', 'SymbolicLink'].includes(entry.linkType ?? '')) {
            throw new Error(`Unknown reparse fixture entry: ${entry.path}`)
          }
          if (!current.isSymbolicLink() && samePath(canonical, entry.path)) throw new Error(`Unverified fixture link: ${entry.path}`)
        } else if (current.isSymbolicLink() || (!current.isFile() && !current.isDirectory()) || !samePath(canonical, entry.path)) {
          throw new Error(`Redirected or special fixture entry: ${entry.path}`)
        }
      }
      // Detach all links before touching ordinary files, including their target
      // if it belongs to this fixture. Neither operation recursively follows.
      for (const entry of plan.filter(entry => entry.link)) {
        if (process.platform === 'win32' && entry.directory && !lstatSync(entry.path).isSymbolicLink()) rmdirSync(entry.path)
        else unlinkSync(entry.path)
      }
      for (const entry of plan.filter(entry => !entry.link).reverse()) {
        if (entry.directory) rmdirSync(entry.path)
        else unlinkSync(entry.path)
      }
      rmdirSync(path)
      removed = true
    },
  }
}
