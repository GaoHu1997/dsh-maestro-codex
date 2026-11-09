import { describe, expect, it } from 'vitest'
import { codexMcpArgs, tomlString } from '../src/channels/codex.js'
import { grokHomeConfig } from '../src/channels/grok.js'

const syntheticSecret = 'SYNTHETIC_MCP_RUNTIME_SECRET'
const server = {
  name: 'dsh_bridge',
  transport: 'stdio' as const,
  command: 'node',
  args: ['D:/fixture/bridge-shim.js'],
  env: { MAESTRO_BRIDGE_TOKEN: syntheticSecret },
}

function withExecPath<T>(execPath: string, action: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'execPath')
  if (original === undefined) throw new Error('process.execPath descriptor unavailable')
  Object.defineProperty(process, 'execPath', { ...original, value: execPath })
  try { return action() } finally { Object.defineProperty(process, 'execPath', original) }
}

const hosts = [
  { label: 'Windows Electron app', execPath: 'D:\\fixture\\DeepSeek Harness.exe', expected: 'node' },
  { label: 'macOS Electron app', execPath: '/Applications/DSH.app/Contents/MacOS/DSH', expected: 'node' },
  { label: 'Linux Electron app', execPath: '/opt/dsh/electron', expected: 'node' },
  { label: 'Windows Node', execPath: 'D:\\fixture\\node.exe', expected: 'D:\\fixture\\node.exe' },
  { label: 'POSIX Node', execPath: '/usr/local/bin/node', expected: '/usr/local/bin/node' },
  { label: 'Windows Node shim', execPath: 'D:\\fixture\\node.cmd', expected: 'D:\\fixture\\node.cmd' },
]

describe('pre-release MCP wrapper runtime selection', () => {
  for (const host of hosts) {
    it(`Codex uses a Node runtime under ${host.label} without placing secrets in argv`, () => {
      const args = withExecPath(host.execPath, () => codexMcpArgs([server]))
      const config = args.join('\n')
      expect(config).toContain(`command = ${tomlString(host.expected)}`)
      expect(config).toContain('mcp-env-shim.js')
      expect(config).toContain('MAESTRO_MCP_SECRET_0_0')
      expect(config).not.toContain(syntheticSecret)
    })

    for (const declared of [true, false]) {
      it(`Grok uses a Node runtime under ${host.label} with declared env=${declared}`, () => {
        const entry = { ...server, env: declared ? server.env : {} }
        const config = withExecPath(host.execPath, () => grokHomeConfig([entry], 'D:/fixture/mcp-env-shim.js'))
        expect(config).toContain(`command = ${tomlString(host.expected)}`)
        expect(config).toContain('mcp-env-shim.js')
        expect(config).not.toContain(syntheticSecret)
      })
    }
  }

  it('does not reinterpret a direct Codex server command with no env wrapper', () => {
    const entry = { ...server, command: 'custom-mcp.exe', env: {} }
    const config = withExecPath(hosts[0]!.execPath, () => codexMcpArgs([entry])).join('\n')
    expect(config).toContain('command = "custom-mcp.exe"')
    expect(config).not.toContain('mcp-env-shim.js')
  })
})
