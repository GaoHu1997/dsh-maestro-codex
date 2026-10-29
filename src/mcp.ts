/**
 * Bridging dsh's MCP servers into the dispatched CLI runs. The authoritative
 * source is the active profile's `cordis.patch.yml`: every MCP server is an
 * insert row of `@deepseek-ai/dsh-mcp-client` (managed `panel-mcp-*` rows from
 * the skill-mcp-panel, plus hand-written rows like `dsh-image-mcp`). The same
 * servers go to codex (`-c mcp_servers.*`) and claude (`--mcp-config`), so a
 * dispatched CLI sees the tools dsh itself has — no second configuration.
 *
 * The active profile is the one that has this plugin installed (its
 * node_modules contains `dsh-maestro-codex`); `DSH_PROFILE` wins when set.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { parseDocument } from 'yaml'

/** One dsh MCP server as the CLI bridge needs it. */
export interface DshMcpServer {
  /** The server name the CLI addresses tools by (`mcp__<name>` for claude). */
  readonly name: string
  /** `stdio` servers spawn a child; `http` servers are skipped by the bridge. */
  readonly transport: 'stdio' | 'http'
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /** Where the row was found (diagnostics). */
  readonly source: string
}

const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client'

/** The patch file of the profile this plugin is installed into (cached). */
let patchPathCache: string | undefined

export function activeProfilePatchPath(dshHome: string | undefined = process.env['DSH_HOME'], home: string = homedir()): string {
  if (patchPathCache !== undefined) return patchPathCache
  const profilesRoot = join(dshHome !== undefined && dshHome.trim() !== '' ? dshHome : join(home, '.dsh'), 'profiles')
  const fromEnv = process.env['DSH_PROFILE']
  const candidates = fromEnv !== undefined && fromEnv.trim() !== ''
    ? [fromEnv.trim()]
    : existsSync(profilesRoot)
      ? readdirSync(profilesRoot)
      : []
  for (const profile of candidates) {
    if (existsSync(join(profilesRoot, profile, 'node_modules', 'dsh-maestro-codex'))) {
      patchPathCache = join(profilesRoot, profile, 'cordis.patch.yml')
      return patchPathCache
    }
  }
  patchPathCache = join(profilesRoot, 'desktop', 'cordis.patch.yml')
  return patchPathCache
}

/** Reset the cached patch path (tests). */
export function resetPatchPathCache(): void {
  patchPathCache = undefined
}

/** Resolve the common `${process.env.NAME}` spellings of `!!js` env values. */
function resolveJsEnvValue(value: unknown): string {
  if (typeof value === 'string') {
    // A parse-error path can leave the expression as a plain/backticked string.
    const name = /`?process\.env\.([A-Za-z_][A-Za-z0-9_]*)`?/.exec(value)?.[1]
    if (name !== undefined) return process.env[name] ?? ''
    return value
  }
  if (typeof value === 'object' && value !== null) {
    const expression = (value as Record<string, unknown>)['__jsExpr']
    if (typeof expression !== 'string') return ''
    const name = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/.exec(expression)?.[1]
    if (name !== undefined) return process.env[name] ?? ''
    return ''
  }
  return ''
}

/** Parse the patch file and pull out every MCP client row (stdio + http). */
export function readMcpServersFromPatch(path: string): DshMcpServer[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  // `!!js` expressions are dsh's composition escape hatch; for read-only
  // discovery they neutralize into markers and env refs resolve above. Parse
  // errors on unrelated rows must not kill the whole discovery — take whatever
  // yaml could build.
  const doc = parseDocument(raw, {
    logLevel: 'silent',
    customTags: [{
      tag: 'js',
      resolve: (value: string) => ({ __jsExpr: String(value ?? '') }),
    }],
  })
  const root = doc.toJS()
  if (!Array.isArray(root)) return []
  const servers: DshMcpServer[] = []
  const visit = (rows: unknown[]): void => {
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue
      const record = row as Record<string, unknown>
      if (record['name'] !== MCP_PLUGIN_NAME) continue
      const config = record['config']
      if (typeof config !== 'object' || config === null) continue
      const cfg = config as Record<string, unknown>
      const name = typeof cfg['serverName'] === 'string' ? cfg['serverName'].trim() : ''
      if (name === '') continue
      const transport = cfg['transport'] === 'http' ? 'http' as const : 'stdio' as const
      const command = typeof cfg['command'] === 'string' ? cfg['command'] : ''
      const rawArgs = cfg['args']
      const args = Array.isArray(rawArgs) ? rawArgs.map(arg => resolveJsEnvValue(arg)).filter(arg => arg !== '') : []
      const rawEnv = cfg['env']
      const env: Record<string, string> = {}
      if (typeof rawEnv === 'object' && rawEnv !== null) {
        for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
          const resolved = resolveJsEnvValue(value)
          if (resolved !== '') env[key] = resolved
        }
      }
      servers.push({
        name,
        transport,
        command,
        args,
        env,
        source: typeof record['id'] === 'string' ? record['id'] : 'patch',
      })
    }
  }
  // Top-level rows are entries; `insert:` rows carry entry lists.
  for (const item of root) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (Array.isArray(record['insert'])) visit(record['insert'])
    else visit([item])
  }
  return servers
}

function readFileSync2(path: string): string {
  return readFileSync(path, 'utf8')
}

/** Discover the dsh MCP servers of the active profile. */
export function discoverMcpServers(): DshMcpServer[] {
  return readMcpServersFromPatch(activeProfilePatchPath())
}

/**
 * Write the temporary `--mcp-config` file for claude (the strict-mcp-config
 * form: ONLY these servers, nothing from claude's own global config).
 * @returns the file path; the caller unlinks it when the run settles.
 */
export async function writeClaudeMcpConfig(servers: readonly DshMcpServer[]): Promise<string> {
  const mcpServers: Record<string, unknown> = {}
  for (const server of servers) {
    if (server.transport !== 'stdio') continue
    mcpServers[server.name] = {
      command: server.command,
      ...(server.args.length > 0 ? { args: [...server.args] } : {}),
      ...(Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
    }
  }
  const file = join(tmpdir(), `dsh-maestro-mcp-${randomUUID().slice(0, 8)}.json`)
  await writeFile(file, JSON.stringify({ mcpServers }, null, 2), 'utf8')
  return file
}

export async function unlinkQuiet(file: string): Promise<void> {
  try {
    await unlink(file)
  } catch { /* best effort */ }
}

/** claude `--allowedTools` entries granting the bridged servers' tools. */
export function claudeMcpAllowedTools(servers: readonly DshMcpServer[]): string[] {
  // Server-level grants: every tool of `mcp__<name>` is admitted for the run.
  return servers.filter(server => server.transport === 'stdio').map(server => `mcp__${server.name}`)
}
