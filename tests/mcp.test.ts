import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeMcpAllowedTools, claudeMcpArgs, readMcpServersFromPatch, writeClaudeMcpConfig, unlinkQuiet } from '../src/mcp.js'
import { codexMcpArgs, codexArgs } from '../src/channels/codex.js'
import { claudeArgs, claudeToolResultEvents } from '../src/channels/claude.js'

const PATCH = `
# touch comment
- id: some-plugin
  config:
    enabled: true
# >>> dsh-skill-mcp-panel:mcp:begin
- insert:
    - id: panel-mcp-obsidian_mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: obsidian_mcp
        toolCallTimeoutMs: 60000
        transport: stdio
        command: npx
        args:
          - "-y"
          - "mcp-obsidian"
        env:
          OBSIDIAN_API_KEY: !!js ` + '`process.env.OBSIDIAN_KEY`' + `
    - id: panel-mcp-http
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: http_one
        transport: http
        url: "https://example.com/mcp"
- insert:
    - id: dsh-image-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: dsh-image
        transport: stdio
        command: node.exe
        args: ["image-mcp.mjs"]
        env:
          DSH_HOME: "C:/x"
`

describe('readMcpServersFromPatch', () => {
  it('finds stdio and http mcp-client rows across all inserts, resolving !!js env refs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'maestro-mcp-'))
    const file = join(dir, 'cordis.patch.yml')
    writeFileSync(file, PATCH, 'utf8')
    try {
      process.env['OBSIDIAN_KEY'] = 'ambient-value'
      const servers = readMcpServersFromPatch(file)
      const names = servers.map(server => server.name).sort()
      expect(names).toEqual(['dsh-image', 'http_one', 'obsidian_mcp'])
      const obsidian = servers.find(server => server.name === 'obsidian_mcp')
      expect(obsidian?.transport).toBe('stdio')
      expect(obsidian?.command).toBe('npx')
      expect(obsidian?.args[0]).toBe('-y')
      // The !!js env ref resolved from the ambient environment.
      expect(Object.values(obsidian?.env ?? {})).toContain('ambient-value')
      const httpOne = servers.find(server => server.name === 'http_one')
      expect(httpOne?.transport).toBe('http')
    } finally {
      delete process.env['OBSIDIAN_KEY']
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('degrades to empty on a missing file', () => {
    expect(readMcpServersFromPatch('D:/definitely/not/here/patch.yml')).toEqual([])
  })
})

describe('claude MCP argv', () => {
  it('uses strict-mcp-config and grants the bridged stdio servers', () => {
    const args = claudeArgs('m', 'inherit', 'C:/tmp/mcp.json', ['dsh-image'])
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('C:/tmp/mcp.json')
    expect(args).toContain('--allowedTools')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__dsh-image')
    expect(claudeMcpAllowedTools([{ name: 's', transport: 'stdio', command: 'c', args: [], env: {}, source: 'x' }])).toEqual(['mcp__s'])
    // http servers are not bridgeable to claude's stdio config.
    expect(claudeMcpAllowedTools([{ name: 'h', transport: 'http', command: '', args: [], env: {}, source: 'x' }])).toEqual([])
  })
})

describe('codex MCP argv', () => {
  it('synthesizes one inline-table -c override per server', () => {
    const args = codexMcpArgs([{ name: 'dsh-image', transport: 'stdio', command: 'node.exe', args: ['a.mjs'], env: { K: 'v' } }])
    expect(args).toEqual(['-c', 'mcp_servers.dsh-image={ command = "node.exe", args = ["a.mjs"], env = { K = "v" } }'])
    // The override splits on the first `=`: the key must be bare (no trailing
    // space) or the whole server would be dropped by codex's -c parser.
    expect(args[1]?.slice(0, args[1].indexOf('='))).toBe('mcp_servers.dsh-image')
    expect(codexArgs('', 'workspace-write', [], undefined, [{ name: 's', transport: 'stdio', command: 'c', args: [], env: {} }]).join(' ')).toContain('mcp_servers.s')
  })
})

describe('claude subagent events', () => {
  it('maps Task tool_use ids to completion notes', () => {
    const events = claudeToolResultEvents({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }, new Map([['t1', 'Task']]))
    expect(events[0]?.text).toContain('子代理完成')
  })
})

describe('mcp config file', () => {
  it('writes and removes the temp config (stdio only)', async () => {
    const { readFile } = await import('node:fs/promises')
    const path = await writeClaudeMcpConfig([
      { name: 's1', transport: 'stdio', command: 'c', args: ['a'], env: { E: '1' }, source: 'x' },
      { name: 'http', transport: 'http', command: '', args: [], env: {}, source: 'x' },
    ])
    const json = JSON.parse(await readFile(path, 'utf8'))
    expect(json.mcpServers.s1.command).toBe('c')
    expect(json.mcpServers.http).toBeUndefined()
    await unlinkQuiet(path)
  })
})
