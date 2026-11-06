import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexMcpArgs, codexMcpEnv, runCodexTask } from '../src/channels/codex.js'
import { mcpChildEnv } from '../src/mcp-env-shim.js'
import { EffectQueue } from '../src/effects.js'
import { FakeChild } from './fake-child.js'
import { readFileSync, existsSync } from 'node:fs'

it('发布文档版本不漂移，README五张截图精确在白名单且可达', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const doc = readFileSync(new URL('../docs/reliability.md', import.meta.url), 'utf8')
  expect(doc).toContain('version=$(node -p')
  expect(doc).toContain('artifact="./dist/$name-$version.tgz"')
  expect(doc).not.toMatch(/artifact=.*0\.1\.8/)
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  for (const image of ['config-cli-management', 'config-sdk-management', 'session-task-list', 'cli-subsession-page', 'task-board-tree']) {
    const path = `docs/images/${image}.png`
    expect(pkg.files).toContain(path)
    expect(existsSync(new URL('../' + path, import.meta.url))).toBe(true)
    expect(readme).toContain(path)
  }
})

describe('修复：实际Codex进程边界', () => {
  const servers = [{ name: 'dsh_bridge', command: 'synthetic-node', args: ['bridge.js'], env: { MAESTRO_BRIDGE_TOKEN: 'synthetic-bridge-secret', SAME: 'synthetic-A' } }, { name: 'other', command: 'synthetic-node', args: [], env: { SAME: 'synthetic-B' } }]
  it('actual runCodexTask的spawn argv没有任何env值，provider仍env-only', async () => {
    let seen = false
    const result = await runCodexTask({ codexPath: 'fake', task: 'prompt', model: '', sandbox: 'read-only', cwd: undefined,
      dshModel: { model: 'm', baseUrl: 'https://synthetic.invalid', apiKey: 'synthetic-provider' }, mcpServers: servers,
      baseUrl: '', apiKey: '', signal: new AbortController().signal, timeoutMs: 1000, onEvent: () => {},
      spawnFn: (file, args, options) => {
        seen = true
        for (const secret of ['synthetic-provider', 'synthetic-bridge-secret', 'synthetic-A', 'synthetic-B']) expect(args.join(' ')).not.toContain(secret)
        expect(options.env?.['MAESTRO_DSH_PROVIDER_KEY']).toBe('synthetic-provider')
        expect(options.env?.['MAESTRO_MCP_SECRET_0_0']).toBe('synthetic-bridge-secret')
        expect(options.env?.['MAESTRO_MCP_SECRET_0_1']).toBe('synthetic-A')
        expect(options.env?.['MAESTRO_MCP_SECRET_1_0']).toBe('synthetic-B')
        const child = new FakeChild(file, args)
        child.onStdin = text => { expect(text).toBe('prompt'); child.finish(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) + '\n' + JSON.stringify({ type: 'turn.completed' })) }
        return child as unknown as ReturnType<NonNullable<Parameters<typeof runCodexTask>[0]['spawnFn']>>
      } })
    expect(seen).toBe(true)
    expect(result.ok).toBe(true)
  })
  it('多server同名env隔离；每个配置只请求本server别名；shim剥除全部别名及provider秘密', () => {
    const args = codexMcpArgs(servers)
    expect(args[1]).toContain('MAESTRO_MCP_SECRET_0_0')
    expect(args[1]).not.toContain('MAESTRO_MCP_SECRET_1_0')
    expect(args[3]).not.toContain('MAESTRO_MCP_SECRET_0_')
    const inherited = { ...codexMcpEnv(servers), MAESTRO_DSH_PROVIDER_KEY: 'provider', OPENAI_API_KEY: 'provider', PATH: 'safe' }
    const a = mcpChildEnv({ keys: ['MAESTRO_BRIDGE_TOKEN', 'SAME'], aliases: ['MAESTRO_MCP_SECRET_0_0', 'MAESTRO_MCP_SECRET_0_1'] }, inherited)
    const b = mcpChildEnv({ keys: ['SAME'], aliases: ['MAESTRO_MCP_SECRET_1_0'] }, inherited)
    expect(a['SAME']).toBe('synthetic-A'); expect(b['SAME']).toBe('synthetic-B')
    expect(a['MAESTRO_BRIDGE_TOKEN']).toBe('synthetic-bridge-secret'); expect(b).not.toHaveProperty('MAESTRO_BRIDGE_TOKEN')
    for (const env of [a, b]) { expect(Object.keys(env).some(k => k.startsWith('MAESTRO_MCP_SECRET_'))).toBe(false); expect(env).not.toHaveProperty('MAESTRO_DSH_PROVIDER_KEY'); expect(env).not.toHaveProperty('OPENAI_API_KEY') }
    expect(() => mcpChildEnv({ keys: ['SAME'], aliases: ['missing'] }, {})).toThrow('alias unavailable')
  })
  it('HTTP server既不生成argv也不生成别名环境', () => {
    const http = [{ name: 'http', transport: 'http' as const, command: '', args: [], env: { KEY: 'secret' } }]
    expect(codexMcpArgs(http)).toEqual([]); expect(codexMcpEnv(http)).toEqual({})
  })
})
describe('修复：关闭副作用队列', () => {
  it('drain后拒绝新键和旧键重入，磁盘不变，关闭前未完成行可恢复', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'repair-effects-'))
    const file = join(fixture, 'effects.json')
    const queue = new EffectQueue({ file })
    const before = await queue.enqueue('launch', 'before', { value: 1 })
    await queue.drain()
    const saved = await readFile(file, 'utf8')
    await expect(queue.enqueue('launch', 'after', {})).rejects.toThrow('已关闭')
    await expect(queue.enqueue('launch', 'before', {})).rejects.toThrow('已关闭')
    expect(queue.entries()).toEqual([before])
    expect(await readFile(file, 'utf8')).toBe(saved)
    const reloaded = new EffectQueue({ file }); await reloaded.load()
    expect(reloaded.entries()).toEqual([before])
    // Deliberately retain this small fixture under the isolated TEMP as evidence.
  })
})
