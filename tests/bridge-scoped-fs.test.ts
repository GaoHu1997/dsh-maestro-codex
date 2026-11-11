/**
 * `bridgeTools: 'scoped'`: the file-tool allowlist plus the per-call cwd
 * boundary. The catalog decides *which* tools exist; `scopedPathViolation`
 * decides *where* each call may touch, and a violation must never reach the
 * host registry.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectiveOf } from '../src/config.js'
import {
  BridgeState, createBridgeHandle, scopedPathViolation, SCOPED_FS_TOOLS, type ToolsFace,
} from '../src/bridge.js'

const SCHEMAS = [
  { name: 'ops_read_files', description: '读文件', parameters: { type: 'object', properties: {} } },
  { name: 'ops_edit_file', description: '改文件', parameters: { type: 'object', properties: {} } },
  { name: 'ops_write_file', description: '写文件', parameters: { type: 'object', properties: {} } },
  { name: 'ops_copy', description: '复制', parameters: { type: 'object', properties: {} } },
  { name: 'ops_remove', description: '删除', parameters: { type: 'object', properties: {} } },
  { name: 'ops_bash', description: 'shell', parameters: { type: 'object', properties: {} } },
  { name: 'web_search', description: '网络', parameters: { type: 'object', properties: {} } },
  { name: 'run_code', description: 'PTC', parameters: { type: 'object', properties: {} } },
]

function fixture(mode: 'scoped' | 'auto' | 'custom' = 'scoped', allowlist: string[] = []): {
  bridge: ReturnType<typeof createBridgeHandle>
  executeSpy: ReturnType<typeof vi.fn>
} {
  // Registry-shaped: the host settles batches, never a lone call.
  const executeSpy = vi.fn(async (batch: Parameters<ToolsFace['execute']>[0]) => ({
    results: batch.calls.map(call => ({
      callId: call.id,
      result: { content: [{ type: 'text', text: `工具 ${call.name} 的输出` }], isError: false },
    })),
  }))
  const face: ToolsFace = { schemas: () => SCHEMAS, execute: executeSpy }
  const bridge = createBridgeHandle({
    skills: () => undefined,
    tools: () => face,
    portOf: () => 8765,
    readConfig: () => effectiveOf({ bridgeSkills: false, bridgeTools: mode, bridgeToolAllowlist: allowlist }),
    state: new BridgeState(),
  })
  return { bridge, executeSpy }
}

describe('scoped fs bridge', () => {
  let root = ''
  let cwd = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'maestro-scoped-'))
    cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    await writeFile(join(cwd, 'inside.txt'), 'inside', 'utf8')
    await writeFile(join(root, 'outside.txt'), 'outside', 'utf8')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function run(context: Record<string, unknown> = { cwd, agent: { id: 'fixture-session' } }): { token: string; bridge: ReturnType<typeof createBridgeHandle>; executeSpy: ReturnType<typeof vi.fn> } {
    const { bridge, executeSpy } = fixture()
    const minted = bridge.runServerEntry(undefined, context as never)
    if (minted === undefined) throw new Error('scoped bridge should be active')
    return { token: minted.token, bridge, executeSpy }
  }

  it('catalogs only the fs allowlist, never shell or web tools', async () => {
    const { token, bridge } = run()
    const catalog = await bridge.catalog(token, cwd)
    if ('error' in catalog) throw new Error(catalog.error)
    expect(catalog.tools.map(tool => tool.name)).toEqual(['ops_copy', 'ops_edit_file', 'ops_read_files', 'ops_remove', 'ops_write_file'])
    expect(SCOPED_FS_TOOLS).toHaveLength(12)
  })

  it('auto mode still withholds ops_* file tools (scoped is opt-in)', async () => {
    const { bridge } = fixture('auto')
    const minted = bridge.runServerEntry(undefined, { cwd, agent: { id: 'fixture-session' } })
    if (minted === undefined) throw new Error('auto bridge should still mount for web tools')
    const catalog = await bridge.catalog(minted.token, cwd)
    if ('error' in catalog) throw new Error(catalog.error)
    expect(catalog.tools.map(tool => tool.name)).toEqual(['web_search'])
  })

  it('executes a call whose paths stay inside the task cwd', async () => {
    const { token, bridge, executeSpy } = run()
    const outcome = await bridge.callTool(token, 'ops_read_files', { files: [{ path: 'inside.txt' }] })
    expect(outcome).toMatchObject({ ok: true })
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  it('allows a create target that does not exist yet', async () => {
    const { token, bridge, executeSpy } = run()
    const outcome = await bridge.callTool(token, 'ops_write_file', { path: 'fresh.txt', content: 'x', expectedRevision: 'absent' })
    expect(outcome).toMatchObject({ ok: true })
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  it('refuses a ../ escape before the host registry sees it', async () => {
    const { token, bridge, executeSpy } = run()
    const outcome = await bridge.callTool(token, 'ops_read_files', { files: [{ path: '../outside.txt' }] })
    expect(outcome).toMatchObject({ ok: false, status: 403 })
    expect(JSON.stringify(outcome)).toContain('不在本次任务目录')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('refuses an absolute path outside the task cwd', async () => {
    const { token, bridge, executeSpy } = run()
    const outcome = await bridge.callTool(token, 'ops_remove', { path: join(root, 'outside.txt') })
    expect(outcome).toMatchObject({ ok: false, status: 403 })
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('checks every path in a multi-path call, not just the first', async () => {
    const { token, bridge, executeSpy } = run()
    const outcome = await bridge.callTool(token, 'ops_copy', { path: 'inside.txt', to: '../outside.txt', expectedRevision: 'a'.repeat(64) })
    expect(outcome).toMatchObject({ ok: false, status: 403 })
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('refuses a symlink that points out of the cwd', async () => {
    await symlink(root, join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const { token, bridge, executeSpy } = run()
    const outcome = await bridge.callTool(token, 'ops_read_files', { files: [{ path: 'escape/outside.txt' }] })
    expect(outcome).toMatchObject({ ok: false, status: 403 })
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('refuses scoped calls when the run has no cwd binding', async () => {
    const { token, bridge, executeSpy } = run({ agent: { id: 'fixture-session' } })
    const outcome = await bridge.callTool(token, 'ops_read_files', { files: [{ path: 'inside.txt' }] })
    expect(outcome).toMatchObject({ ok: false, status: 403 })
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('never bridges a tool outside the scoped allowlist even when registered', async () => {
    const { token, bridge, executeSpy } = run()
    const outcome = await bridge.callTool(token, 'ops_bash', { command: 'rm -rf /' })
    expect(outcome).toMatchObject({ ok: false, status: 403 })
    expect(JSON.stringify(outcome)).toContain('不在本次桥接名单中')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('custom mode keeps its allowlist semantics (no cwd confinement)', async () => {
    const { bridge } = fixture('custom', ['web_search'])
    const minted = bridge.runServerEntry(undefined, { cwd, agent: { id: 'fixture-session' } })
    if (minted === undefined) throw new Error('custom bridge should be active')
    const outcome = await bridge.callTool(minted.token, 'web_search', { query: 'x' })
    expect(outcome).toMatchObject({ ok: true })
  })

  it('rejects guessed path aliases instead of forwarding an unbound Native call', async () => {
    const { token, bridge, executeSpy } = run()
    expect(await bridge.callTool(token, 'ops_copy', { sourcePath: 'inside.txt', destinationPath: 'copy.txt' })).toMatchObject({ ok: false, status: 400 })
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('rejects non-fs tool names in the violation check itself', async () => {
    await expect(scopedPathViolation('ops_bash', { command: 'x' }, cwd)).resolves.toContain('不在 scoped 文件工具名单中')
    await expect(scopedPathViolation('ops_read_files', { files: [{ path: 'inside.txt' }] }, cwd)).resolves.toBeUndefined()
  })
})
