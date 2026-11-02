/** Read versions only from the package that owns the resolved CLI entry. */
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { CLI_PACKAGES, type MaestroCliId } from './wire.js'

const LOCAL_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const MAX_METADATA_BYTES = 64 * 1024

function normalized(value: string): string {
  const result = value.replaceAll('\\', '/')
  return process.platform === 'win32' ? result.toLowerCase() : result
}

async function smallText(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_METADATA_BYTES) return undefined
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Only trust a shim that actually refers to this package's declared bin. */
function shimReferences(shim: string, entry: string, relativeEntry: string): boolean {
  const lines = normalized(shim).split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => !/^(?:#|::|@?rem\b)/i.test(line))
  const commands = lines
    .filter(line => !/^@?(?:echo|printf)\b/i.test(line) && /%\*|\$(?:@|\*|\{@\})/.test(line))
    .join('\n')
  // Relative package paths are trustworthy only if their base is this shim.
  const prefixes = ['%~dp0']
  const dp0 = lines.filter(line => /^@?set\s+"?dp0=/i.test(line))
  if (dp0.length > 0 && dp0.every(line => /^@?set\s+"?dp0=%~dp0"?$/i.test(line))) prefixes.push('%dp0%')
  const basedir = lines.filter(line => /^basedir=/.test(line))
  const fromSelf = (line: string): boolean => /^basedir=(?:\$\(|\x60)dirname\b.*(?:\$0|\$\{0\})/.test(line)
  const conversion = (line: string): boolean => /^basedir=(?:\$\(|\x60)cygpath\b.*\$(?:basedir|\{basedir\})/.test(line)
  if (basedir.some(fromSelf) && basedir.every(line => fromSelf(line) || conversion(line))) prefixes.push('\\$basedir', '\\$\\{basedir\\}')
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tail = '(?=["\x27\\s;&|]|$)'
  const absolute = new RegExp(`(?:^|["\x27\\s])${escape(normalized(entry))}${tail}`, 'm')
  const relative = new RegExp(`(?:${prefixes.join('|')})/?${escape(normalized(relativeEntry))}${tail}`)
  return absolute.test(commands) || relative.test(commands)
}

/** npm/pnpm symlinks and npm sh/cmd shims, including Claude's native exe bin. */
export async function readLocalCliVersion(cli: MaestroCliId, resolved: string): Promise<string | undefined> {
  let actual: string
  try { actual = await realpath(resolved) } catch { return undefined }
  const shim = /\.(?:exe|com)$/i.test(actual) ? undefined : await smallText(actual)
  const roots = new Set<string>([path.join(path.dirname(resolved), 'node_modules', CLI_PACKAGES[cli])])
  let directory = path.dirname(actual)
  for (let depth = 0; depth < 8; depth += 1) {
    roots.add(directory)
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  for (const root of roots) {
    const text = await smallText(path.join(root, 'package.json'))
    if (text === undefined) continue
    let pkg: unknown
    try { pkg = JSON.parse(text) } catch { continue }
    if (!record(pkg) || pkg['name'] !== CLI_PACKAGES[cli] || typeof pkg['version'] !== 'string' || !LOCAL_VERSION.test(pkg['version'])) continue
    const bin = typeof pkg['bin'] === 'string' ? pkg['bin'] : record(pkg['bin']) ? pkg['bin'][cli] : undefined
    if (typeof bin !== 'string' || bin === '') continue
    const entry = path.resolve(root, bin)
    const relative = path.relative(root, entry)
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue
    let actualEntry: string
    try {
      actualEntry = await realpath(entry)
      if (!(await stat(actualEntry)).isFile()) continue
    } catch { continue }
    if (normalized(actualEntry) === normalized(actual)) return pkg['version']
    if (shim !== undefined && shimReferences(shim, entry, `node_modules/${CLI_PACKAGES[cli]}/${relative.replaceAll('\\', '/')}`)) return pkg['version']
  }
  return undefined
}
