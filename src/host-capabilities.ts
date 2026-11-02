/**
 * Host capability + version detection (plugin-only, read-only).
 *
 * The plugin talks to dsh through public services whose *shape* varies between
 * host releases (`sessions`, `sessionQuery`, `sessionPersistence`,
 * `sessionProjections`, `agents`, `tools`, `skills`, ...). Nothing here calls
 * the host, patches a service, or reads private state: every probe is a
 * `typeof` inspection of the face the plugin already resolved, plus a
 * best-effort package version read for diagnostics.
 *
 * The report is deliberately data-only (booleans, member names, versions) so it
 * can be exposed on the cheap overview route and asserted in tests. It carries
 * no paths, tokens, prompts, or session content.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HostCapabilityId, HostCapabilityReport, HostCapabilityResult, PermissionContextReport } from './wire.js'

interface MemberSpec {
  /** Dotted member path on the face (`identity` is checked as a symbol). */
  readonly path: string
  readonly check: (value: unknown) => boolean
  /** The member is required; absent = partial capability. */
  readonly required: boolean
}

const fn = (value: unknown): boolean => typeof value === 'function'
const symbol = (value: unknown): boolean => typeof value === 'symbol'

/** Public host packages whose released shape decides which members exist. */
export const HOST_PACKAGES = [
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/cordis',
] as const

interface CapabilityContract {
  readonly id: HostCapabilityId
  /** What the plugin silently loses when this capability is absent. */
  readonly impact: string
  readonly members: readonly MemberSpec[]
}

const CONTRACTS: readonly CapabilityContract[] = [
  { id: 'settings', impact: 'config card cannot project volatile fields into forms', members: [{ path: 'configure', check: fn, required: true }, { path: 'describe', check: fn, required: false }] },
  { id: 'skills', impact: 'CLI children lose the dsh skill catalog and bodies (bridge skill tools stay off)', members: [{ path: 'list', check: fn, required: false }, { path: 'get', check: fn, required: false }] },
  { id: 'agents', impact: 'no live parent agent: page replies keep the CLI/skill path but host tool bridging fails closed', members: [{ path: 'get', check: fn, required: true }] },
  { id: 'sessions', impact: 'no native child record sessions, no host session-access publication, no parent usage replay', members: [{ path: 'create', check: fn, required: true }, { path: 'get', check: fn, required: false }, { path: 'list', check: fn, required: false }, { path: 'flush', check: fn, required: false }] },
  { id: 'sessionQuery', impact: 'cannot verify a recovered native mirror through the host query service', members: [{ path: 'readSession', check: fn, required: true }] },
  { id: 'sessionPersistence', impact: 'cannot rebuild a missing CLI count-observation mirror through a real host writer', members: [{ path: 'identity', check: symbol, required: true }, { path: 'create', check: fn, required: true }, { path: 'open', check: fn, required: true }] },
  { id: 'sessionProjections', impact: 'the plugin fails closed and exposes no CLI usage/identity projection; only the public accounting service remains', members: [{ path: 'register', check: fn, required: true }, { path: 'stateOf', check: fn, required: true }] },
  { id: 'tools', impact: 'no dispatch tool and no host tool bridge for CLI children', members: [{ path: 'schemas', check: fn, required: true }, { path: 'execute', check: fn, required: true }] },
  { id: 'systemPrompt', impact: 'no routing hint: the model must be told about the dispatch tool some other way', members: [{ path: 'context', check: fn, required: true }] },
  { id: 'webServer', impact: 'no HTTP surface: no task board, no bridge callback, no page replies', members: [{ path: 'port', check: () => true, required: true }] },
]

// A private sentinel keeps unreadable members missing even for permissive checks.
const UNREADABLE_MEMBER = Symbol('unreadable host capability member')

function memberOf(face: unknown, path: string): unknown {
  if (face === null || face === undefined) return undefined
  let current: unknown = face
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    try {
      current = (current as Record<string, unknown>)[key]
    } catch {
      // Cordis may reject access before injection; diagnostics must fail closed.
      return UNREADABLE_MEMBER
    }
  }
  return current
}

/** Probe one face. Unreadable members are missing; unavailable faces are absent. */
export function probeHostCapability(id: HostCapabilityId, face: unknown): HostCapabilityResult {
  const contract = CONTRACTS.find(candidate => candidate.id === id)
  if (contract === undefined) throw new Error(`unknown host capability: ${id}`)
  if (face === null || face === undefined || face === UNREADABLE_MEMBER) {
    return { id, present: false, degraded: 'absent', missing: contract.members.map(member => member.path), impact: contract.impact }
  }
  const missing = contract.members
    .filter(member => {
      const value = memberOf(face, member.path)
      return value === UNREADABLE_MEMBER || !member.check(value)
    })
    .map(member => member.path)
  const blocking = contract.members.filter(member => member.required && missing.includes(member.path))
  return {
    id,
    present: true,
    degraded: blocking.length === 0 ? (missing.length === 0 ? 'none' : 'partial') : 'partial',
    missing,
    impact: contract.impact,
  }
}

/** A face is resolved by the plugin only when it carries the required members,
 * so `present` describes what the plugin can actually use. */
export function probeHostCapabilities(
  faces: Partial<Record<HostCapabilityId, unknown>>,
  options?: { readonly versions?: () => Readonly<Record<string, string | null>>; readonly now?: () => number },
): HostCapabilityReport {
  const capabilities = CONTRACTS.map(contract => probeHostCapability(contract.id, memberOf(faces, contract.id)))
  const versions = (options?.versions ?? readHostPackageVersions)()
  const degraded = capabilities.some(capability => capability.degraded !== 'none')
    || Object.values(versions).some(version => version === null)
  const tools = capabilities.find(capability => capability.id === 'tools')
  const agents = capabilities.find(capability => capability.id === 'agents')
  const permissionContext: PermissionContextReport = {
    source: agents?.degraded === 'none' ? 'public-agent-registry' : 'unavailable',
    parentToken: tools?.degraded === 'none' && membersInclude(tools, 'execute') ? 'real-symbol-parent' : 'absent',
    scopeParameterTrusted: false,
  }
  return {
    schemaVersion: 1,
    probedAt: (options?.now ?? Date.now)(),
    degraded,
    capabilities,
    versions,
    permissionContext,
  }
}

function membersInclude(result: HostCapabilityResult, member: string): boolean {
  return !result.missing.includes(member)
}

const requireFromHere = createRequire(import.meta.url)

/** Nearest `package.json` above a resolved entry point. Read-only, never throws. */
function versionAt(entry: string): string | null {
  let directory = dirname(entry)
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { version?: unknown }).version === 'string') {
        return (parsed as { version: string }).version
      }
    } catch { /* keep walking */ }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

/** Best-effort `version` of one host package; `null` = not resolvable from here. */
export function readPackageVersion(name: string): string | null {
  try {
    return versionAt(requireFromHere.resolve(name))
  } catch {
    try {
      return versionAt(requireFromHere.resolve(`${name}/package.json`))
    } catch { return null }
  }
}

/** Best-effort host package versions. `null` = not resolvable from here. */
export function readHostPackageVersions(): Readonly<Record<string, string | null>> {
  const versions: Record<string, string | null> = {}
  for (const name of HOST_PACKAGES) {
    versions[name] = readPackageVersion(name)
  }
  return versions
}
