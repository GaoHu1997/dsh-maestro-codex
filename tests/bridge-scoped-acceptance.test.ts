/** Acceptance probes: exercise forwarded arguments with a host cwd unlike the CLI cwd. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeState, createBridgeHandle, type ToolsFace } from '../src/bridge.js'
import { effectiveOf } from '../src/config.js'

const schemas = [
  { name: 'ops_read_files', parameters: { type: 'object', properties: { files: { type: 'array' } } } },
  { name: 'ops_glob', parameters: { type: 'object', properties: { path: { type: 'string' }, pattern: { type: 'array' } } } },
  { name: 'ops_copy', parameters: { type: 'object', properties: { path: { type: 'string' }, to: { type: 'string' }, expectedRevision: { type: 'string' } } } },
]

describe('scoped bridge independent acceptance', () => {
  let root: string
  let taskCwd: string
  let hostCwd: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'maestro-acceptance-'))
    taskCwd = join(root, 'task')
    hostCwd = join(root, 'host')
    await Promise.all([mkdir(taskCwd), mkdir(hostCwd)])
    await Promise.all([
      writeFile(join(taskCwd, 'shared.txt'), 'CHILD'),
      writeFile(join(hostCwd, 'shared.txt'), 'PARENT'),
      writeFile(join(taskCwd, 'child-only.txt'), 'child'),
      writeFile(join(hostCwd, 'parent-only.txt'), 'parent'),
      writeFile(join(taskCwd, 'copy-source.txt'), 'SOURCE'),
      writeFile(join(hostCwd, 'copy-source.txt'), 'SOURCE'),
    ])
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  function fixture() {
    let mode: 'scoped' | 'custom' = 'scoped'
    // Mirror the published ops contract: relative paths/defaults use the owning host Session cwd.
    const runOne = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      let text = ''
      if (name === 'ops_read_files') {
        const files = args['files'] as { path: string }[]
        text = await readFile(resolve(hostCwd, files[0]!.path), 'utf8')
      } else if (name === 'ops_glob') {
        text = JSON.stringify(await readdir(resolve(hostCwd, (args['path'] as string | undefined) ?? '.')))
      } else if (name === 'ops_copy') {
        const source = resolve(hostCwd, args['path'] as string)
        const revision = createHash('sha256').update(await readFile(source)).digest('hex')
        if (revision !== args['expectedRevision']) return { content: [{ type: 'text', text: 'revision mismatch' }], isError: true }
        await copyFile(source, resolve(hostCwd, args['to'] as string), constants.COPYFILE_EXCL)
        text = 'copied'
      }
      return { content: [{ type: 'text', text }], isError: false }
    }
    const execute = vi.fn(async (batch: Parameters<ToolsFace['execute']>[0]) => ({
      results: await Promise.all(batch.calls.map(async call => ({ callId: call.id, result: await runOne(call.name, call.arguments) }))),
    }))
    const bridge = createBridgeHandle({
      state: new BridgeState(), portOf: () => 8765, skills: () => undefined,
      tools: () => ({ schemas: () => schemas, execute }),
      readConfig: () => effectiveOf({ bridgeSkills: false, bridgeTools: mode, bridgeToolAllowlist: ['ops_read_files'] }),
    })
    const run = bridge.runServerEntry(undefined, {
      cwd: taskCwd, agent: { id: 'acceptance-parent', session: { header: { cwd: hostCwd } } },
    })
    if (run === undefined) throw new Error('bridge did not mount')
    return { bridge, token: run.token, execute, widen: () => { mode = 'custom' } }
  }

  it('reads the child file, not the same relative name in the host session', async () => {
    const { bridge, token } = fixture()
    const result = await bridge.callTool(token, 'ops_read_files', { files: [{ path: 'shared.txt' }] })
    expect(result).toMatchObject({ ok: true, text: 'CHILD' })
  })

  it('binds an omitted search root to the task directory', async () => {
    const { bridge, token } = fixture()
    const result = await bridge.callTool(token, 'ops_glob', { pattern: ['*.txt'] })
    expect(result).toMatchObject({ ok: true })
    expect('text' in result ? result.text : '').toContain('child-only.txt')
    expect('text' in result ? result.text : '').not.toContain('parent-only.txt')
  })

  it('copies with the published path/to arguments inside the child, not the host', async () => {
    const { bridge, token } = fixture()
    const revision = createHash('sha256').update('SOURCE').digest('hex')
    const result = await bridge.callTool(token, 'ops_copy', { path: 'copy-source.txt', to: 'copy.txt', expectedRevision: revision })
    expect(result).toMatchObject({ ok: true })
    const childCopy = await readFile(join(taskCwd, 'copy.txt'), 'utf8').catch(() => 'MISSING')
    const hostCopy = await readFile(join(hostCwd, 'copy.txt'), 'utf8').catch(() => 'MISSING')
    expect({ childCopy, hostCopy }).toEqual({ childCopy: 'SOURCE', hostCopy: 'MISSING' })
  })

  it('does not widen a scoped token when the global mode changes to custom', async () => {
    const { bridge, token, execute, widen } = fixture()
    await bridge.catalog(token, taskCwd)
    widen()
    const result = await bridge.callTool(token, 'ops_read_files', { files: [{ path: join(hostCwd, 'shared.txt') }] })
    expect(result).toMatchObject({ ok: false, status: 403 })
    expect(execute).not.toHaveBeenCalled()
  })

  it('accepts an absolute path in the task directory (control)', async () => {
    const { bridge, token } = fixture()
    const result = await bridge.callTool(token, 'ops_read_files', { files: [{ path: join(taskCwd, 'shared.txt') }] })
    expect(result).toMatchObject({ ok: true, text: 'CHILD' })
  })

  it('rejects an explicit absolute path outside the task (control)', async () => {
    const { bridge, token, execute } = fixture()
    const result = await bridge.callTool(token, 'ops_read_files', { files: [{ path: join(hostCwd, 'shared.txt') }] })
    expect(result).toMatchObject({ ok: false, status: 403 })
    expect(execute).not.toHaveBeenCalled()
  })
})
