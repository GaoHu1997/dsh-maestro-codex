import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeState, createBridgeHandle, type ToolsFace } from '../src/bridge.js'
import { prepareScopedToolArguments, SCOPED_FS_TOOLS } from '../src/bridge-scoped.js'
import { effectiveOf, type BridgeToolsMode } from '../src/config.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, realpath: vi.fn(actual.realpath) }
})
const nativeFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

describe('Native scoped path adapters and token authority', () => {
  let root: string
  let cwd: string
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'maestro-adapters-'))
    cwd = join(root, 'child')
    await fs.mkdir(cwd)
    await fs.writeFile(join(cwd, 'inside.txt'), 'inside')
  })
  afterEach(async () => {
    vi.mocked(fs.realpath).mockReset().mockImplementation(nativeFs.realpath)
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  function fixture(initial: BridgeToolsMode = 'scoped', allowlist = [...SCOPED_FS_TOOLS]) {
    let mode = initial
    let onSchemas: (() => void) | undefined
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const face: ToolsFace = { schemas: () => { onSchemas?.(); return [...SCOPED_FS_TOOLS, 'web_search'].map(name => ({ name })) }, execute }
    const bridge = createBridgeHandle({
      state: new BridgeState(), skills: () => undefined, tools: () => face, portOf: () => 8765,
      readConfig: () => effectiveOf({ bridgeSkills: false, bridgeTools: mode, bridgeToolAllowlist: allowlist }),
    })
    const run = bridge.runServerEntry(undefined, { cwd, agent: { id: 'host' } })
    if (!run) throw new Error('missing bridge')
    return { bridge, token: run.token, execute, allowlist,
      mode: (next: BridgeToolsMode) => { mode = next }, onSchemas: (fn: () => void) => { onSchemas = fn } }
  }

  it.each(['ops_inspect_local_file', 'ops_stat', 'ops_diff', 'ops_edit_file', 'ops_write_file', 'ops_remove'])(
    '%s binds path and preserves content/revision/edit payloads', async name => {
      const args = { path: 'inside.txt', expectedRevision: 'a'.repeat(64), content: '../literal.txt', edits: [{ oldText: '../old', newText: '../new' }] }
      const result = await prepareScopedToolArguments(name, args, cwd)
      expect(result).toEqual({ ok: true, arguments: { ...args, path: join(cwd, 'inside.txt') } })
      expect(args.path).toBe('inside.txt')
    })

  it.each(['ops_glob', 'ops_grep', 'ops_replace'])('%s binds omitted search root, not patterns', async name => {
    const args = { pattern: '../literal', replacement: '../text', glob: ['**/*.txt'], dryRun: true }
    expect(await prepareScopedToolArguments(name, args, cwd)).toEqual({ ok: true, arguments: { ...args, path: cwd } })
    expect(args).not.toHaveProperty('path')
  })

  it.each(['ops_copy', 'ops_move'])('%s binds both path/to and checks both boundaries', async name => {
    const args = { path: 'inside.txt', to: 'new.txt', expectedRevision: 'a'.repeat(64) }
    expect(await prepareScopedToolArguments(name, args, cwd)).toEqual({ ok: true, arguments: { ...args, path: join(cwd, 'inside.txt'), to: join(cwd, 'new.txt') } })
    expect(await prepareScopedToolArguments(name, { ...args, path: '../outside' }, cwd)).toMatchObject({ ok: false, status: 403 })
    expect(await prepareScopedToolArguments(name, { ...args, to: '../outside' }, cwd)).toMatchObject({ ok: false, status: 403 })
  })

  it('binds every files[].path without mutating ranges', async () => {
    const args = { files: [{ path: 'inside.txt', offset: 2, limit: 3 }, { path: 'new.txt' }] }
    expect(await prepareScopedToolArguments('ops_read_files', args, cwd)).toEqual({ ok: true, arguments: { files: [
      { path: join(cwd, 'inside.txt'), offset: 2, limit: 3 }, { path: join(cwd, 'new.txt') },
    ] } })
    expect(args.files[0]?.path).toBe('inside.txt')
    expect(await prepareScopedToolArguments('ops_read_files', { files: [{ path: 'inside.txt' }, { path: '../outside' }] }, cwd)).toMatchObject({ ok: false, status: 403 })
  })

  it.each([undefined, null, '', ' ', 42, String.fromCharCode(0) + 'bad'])('rejects malformed required path: %s', async path => {
    const f = fixture()
    expect(await f.bridge.callTool(f.token, 'ops_write_file', { path, content: 'x', expectedRevision: 'absent' })).toMatchObject({ ok: false, status: 400 })
    expect(f.execute).not.toHaveBeenCalled()
  })

  it.each([{}, { files: [] }, { files: [null] }, { files: [{ path: 4 }] }, { files: [{ file_path: 'inside.txt' }] }])('rejects malformed file ranges: %j', async args => {
    expect(await prepareScopedToolArguments('ops_read_files', args, cwd)).toMatchObject({ ok: false, status: 400 })
  })

  it('fails closed for missing/non-directory/relative cwd and sibling-prefix escapes', async () => {
    for (const badCwd of [undefined, '', 'relative', join(root, 'absent'), join(cwd, 'inside.txt')]) {
      expect(await prepareScopedToolArguments('ops_stat', { path: 'x' }, badCwd)).toMatchObject({ ok: false, status: 403 })
    }
    expect(await prepareScopedToolArguments('ops_stat', { path: `${cwd}-other/file` }, cwd)).toMatchObject({ ok: false, status: 403 })
    const filesystemRoot = parse(cwd).root
    expect(await prepareScopedToolArguments('ops_stat', { path: cwd }, filesystemRoot)).toMatchObject({ ok: true })
  })

  it('accepts not-yet-created parent components', async () => {
    expect(await prepareScopedToolArguments('ops_write_file', { path: 'new/nested/file' }, cwd)).toEqual({ ok: true, arguments: { path: join(cwd, 'new/nested/file') } })
  })

  it('rejects a symlink escape including not-yet-created leaves', async () => {
    await fs.symlink(root, join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await prepareScopedToolArguments('ops_write_file', { path: 'escape/new/file' }, cwd)).toMatchObject({ ok: false, status: 403 })
  })

  it('preserves an in-root link path for the Native no-follow guard', async () => {
    const real = join(cwd, 'real')
    await fs.mkdir(real)
    await fs.symlink(real, join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await prepareScopedToolArguments('ops_stat', { path: 'link/new' }, cwd)).toEqual({ ok: true, arguments: { path: join(cwd, 'link/new') } })
  })

  it('rejects dangling links rather than treating them as absent create targets', async () => {
    await fs.symlink(join(cwd, 'missing'), join(cwd, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await prepareScopedToolArguments('ops_write_file', { path: 'dangling/file' }, cwd)).toMatchObject({ ok: false, status: 403 })
  })

  it('does not fall back to lexical containment on realpath EACCES', async () => {
    const original = nativeFs.realpath
    vi.mocked(fs.realpath).mockImplementation(async path => {
      if (String(path) === join(cwd, 'inside.txt')) throw Object.assign(new Error('private details'), { code: 'EACCES' })
      return await original(path)
    })
    const result = await prepareScopedToolArguments('ops_stat', { path: 'inside.txt' }, cwd)
    expect(result).toMatchObject({ ok: false, status: 403 })
    expect(JSON.stringify(result)).not.toContain('private details')
  })

  it.skipIf(process.platform !== 'win32')('rejects drive-relative paths and accepts absolute mixed case', async () => {
    expect(await prepareScopedToolArguments('ops_stat', { path: `${parse(cwd).root.slice(0, 2)}inside.txt` }, cwd)).toMatchObject({ ok: false, status: 400 })
    expect(await prepareScopedToolArguments('ops_stat', { path: join(cwd, 'inside.txt').toUpperCase() }, cwd)).toMatchObject({ ok: true })
  })

  it('keeps scoped authority even before the first catalog on mode expansion', async () => {
    const f = fixture()
    f.mode('custom')
    expect(await f.bridge.callTool(f.token, 'ops_stat', { path: join(root, 'outside') })).toMatchObject({ ok: false, status: 403 })
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('snapshots the issuance allowlist even if the original array is mutated', async () => {
    const f = fixture('custom', ['ops_read_files'])
    f.allowlist.push('ops_stat')
    const catalog = await f.bridge.catalog(f.token, cwd)
    expect('tools' in catalog ? catalog.tools.map(x => x.name) : []).toEqual(['ops_read_files'])
    expect(await f.bridge.callTool(f.token, 'ops_stat', { path: 'inside.txt' })).toMatchObject({ ok: false, status: 403 })
  })

  it.each(['off', 'auto'] as const)('immediately respects live policy shrinking to %s', async next => {
    const f = fixture()
    f.mode(next)
    expect(await f.bridge.callTool(f.token, 'ops_stat', { path: 'inside.txt' })).toMatchObject({ ok: false, status: 403 })
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('retains a scoped boundary after custom → scoped → custom', async () => {
    const f = fixture('custom')
    f.mode('scoped')
    expect(await f.bridge.callTool(f.token, 'ops_stat', { path: 'inside.txt' })).toMatchObject({ ok: true })
    f.execute.mockClear()
    f.mode('custom')
    expect(await f.bridge.callTool(f.token, 'ops_stat', { path: join(root, 'outside') })).toMatchObject({ ok: false, status: 403 })
    expect(f.execute).not.toHaveBeenCalled()
  })

  it.each(['revoke', 'off', 'allowlist'] as const)('rechecks %s while path binding is awaiting filesystem', async change => {
    const f = fixture()
    let entered!: () => void
    let release!: () => void
    const waiting = new Promise<void>(done => { entered = done })
    const gate = new Promise<void>(done => { release = done })
    const original = nativeFs.realpath
    vi.mocked(fs.realpath).mockImplementation(async path => {
      if (resolve(String(path)) === cwd) { entered(); await gate }
      return await original(path)
    })
    const call = f.bridge.callTool(f.token, 'ops_stat', { path: 'inside.txt' })
    await waiting
    if (change === 'revoke') f.bridge.revoke(f.token)
    else if (change === 'off') f.mode('off')
    else { f.mode('custom'); f.allowlist.splice(0) }
    release()
    expect(await call).toMatchObject({ ok: false, status: change === 'revoke' ? 401 : 403 })
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('keeps a frozen catalog on discovery and exposes newly selected tools only to a new token', async () => {
    let names = ['ops_read_files']
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const face: ToolsFace = { schemas: () => names.map(name => ({ name })), execute }
    const bridge = createBridgeHandle({
      state: new BridgeState(), skills: () => undefined, tools: () => face, portOf: () => 8765,
      readConfig: () => effectiveOf({ bridgeSkills: false, bridgeTools: 'scoped' }),
    })
    const context = { cwd, agent: { id: 'host' } }
    const first = bridge.runServerEntry(undefined, context)!
    const catalog = await bridge.catalog(first.token, cwd)
    expect('tools' in catalog ? catalog.tools.map(x => x.name) : []).toEqual(['ops_read_files'])
    names = [...names, 'ops_edit_file']
    expect(await bridge.callTool(first.token, 'ops_edit_file', { path: 'inside.txt' })).toMatchObject({ ok: false, status: 403 })
    expect(execute).not.toHaveBeenCalled()
    const second = bridge.runServerEntry(undefined, context)!
    const next = await bridge.catalog(second.token, cwd)
    expect('tools' in next ? next.tools.map(x => x.name) : []).toEqual(['ops_edit_file', 'ops_read_files'])
    expect(await bridge.callTool(second.token, 'ops_edit_file', { path: 'inside.txt' })).toMatchObject({ ok: true })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      calls: [expect.objectContaining({ arguments: { path: join(cwd, 'inside.txt') } })],
    }))
  })

  it('accepts a normal zero-prefixed path component', async () => {
    const path = join('src', '0-file.ts')
    expect(await prepareScopedToolArguments('ops_stat', { path }, cwd)).toEqual({ ok: true, arguments: { path: join(cwd, path) } })
  })

  it('does not forward an unbound call when policy tightens during catalog lookup', async () => {
    const f = fixture('custom')
    f.onSchemas(() => f.mode('scoped'))
    expect(await f.bridge.callTool(f.token, 'ops_stat', { path: 'inside.txt' })).toMatchObject({ ok: true })
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({
      calls: [expect.objectContaining({ arguments: { path: join(cwd, 'inside.txt') } })],
    }))
  })
})
