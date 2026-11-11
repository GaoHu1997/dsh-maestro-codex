import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { BridgeState, createBridgeHandle, skillCatalogText, skillToolName, toolBridgable, type BridgeRunContext, type ToolsFace } from '../src/bridge.js'
import { handleShimMessage, toolsOfCatalog, type ShimCatalog } from '../src/bridge-shim.js'
import { codexArgs, codexFrameEvents, codexMcpArgs, codexUsageStats, runCodexTask } from '../src/channels/codex.js'
import { claudeToolResultEvents, runClaudeTask } from '../src/channels/claude.js'
import { findRolloutFile, startRolloutUsageTail } from '../src/channels/codex-rollout.js'
import { probeDshEndpoint, classifyProbe } from '../src/preflight.js'
import { runProcess } from '../src/spawn.js'
import { scriptedSpawn } from './fake-child.js'

const dirs: string[] = []
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'maestro-fix-regression-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
// Synthetic seam for unit tests only; never evidence of a live host execution.
const trusted = (): BridgeRunContext => ({ agent: { id: 'synthetic-parent' }, sessionId: 'synthetic-parent', cwd: process.cwd() })
function fixture(tools?: ToolsFace) {
  let enabled = true
  let invocable = true
  const get = vi.fn(async (name: string) => ({ name, description: 'fixture', content: 'full body', invocation: { modelInvocable: invocable } }))
  const bridge = createBridgeHandle({ skills: () => ({ list: async () => [{ name: 'test', description: 'fixture' }], get }), tools: () => tools,
    portOf: () => 8765, readConfig: () => ({ bridgeSkills: enabled, bridgeTools: 'auto', bridgeToolAllowlist: [] }) })
  return { bridge, get, disable: () => { enabled = false }, hide: () => { invocable = false } }
}

describe('production fixes: bridge authorization and resources', () => {
  it('rechecks run skill capability, current settings and model invocation on direct loads', async () => {
    const f = fixture()
    const context = trusted()
    const run = f.bridge.runServerEntry(undefined, context)!
    expect(await f.bridge.loadSkill(run.token, 'test', context.cwd)).toMatchObject({ ok: true })
    f.hide()
    expect(await f.bridge.loadSkill(run.token, 'test', context.cwd)).toMatchObject({ ok: false, status: 404 })
    f.disable()
    expect(await f.bridge.loadSkill(run.token, 'test', context.cwd)).toMatchObject({ ok: false, status: 403 })
    const state = new BridgeState()
    const noSkills = createBridgeHandle({ skills: () => ({ list: async () => [], get: f.get }), tools: () => undefined, portOf: () => 8765,
      readConfig: () => ({ bridgeSkills: true, bridgeTools: 'off', bridgeToolAllowlist: [] }), state })
    expect(await noSkills.loadSkill(state.issue(false), 'test', undefined)).toMatchObject({ ok: false, status: 403 })
    f.bridge.revoke(run.token)
  })

  it('keeps bound cwd immutable and never advertises tools without the trusted agent', async () => {
    const schemas = vi.fn(() => [{ name: 'web_search' }])
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const f = fixture({ schemas, execute })
    const run = f.bridge.runServerEntry()!
    expect(await f.bridge.catalog(run.token, process.cwd())).toMatchObject({ tools: [] })
    expect(await f.bridge.callTool(run.token, 'web_search', {})).toMatchObject({ ok: false, status: 403 })
    expect(execute).not.toHaveBeenCalled()
    const context = trusted()
    const bound = f.bridge.runServerEntry(undefined, context)!
    expect(await f.bridge.catalog(bound.token, temp())).toMatchObject({ status: 403 })
    expect(await f.bridge.loadSkill(bound.token, 'test', temp())).toMatchObject({ ok: false, status: 403 })
    expect(await f.bridge.callTool(bound.token, 'web_search', { cwd: '/attacker', agent: { id: 'attacker' }, parent: 'not-a-symbol' })).toMatchObject({ ok: true })
    expect(schemas).toHaveBeenCalledWith(context.agent)
    const input = execute.mock.calls[0]![0] as unknown as { agent: unknown; calls: Array<Record<string, unknown>> }
    expect(input).toMatchObject({ agent: context.agent })
    // The registry settles batches; a one-element `calls` array is the contract.
    expect(input.calls).toHaveLength(1)
    expect(input.calls[0]!['id']).toEqual(expect.stringContaining('maestro:bridge:'))
    expect(input.calls[0]!['name']).toBe('web_search')
    expect(input).not.toHaveProperty('cwd')
    expect(input).not.toHaveProperty('parent')
    expect(input.calls[0]!['arguments']).toMatchObject({ cwd: '/attacker', agent: { id: 'attacker' }, parent: 'not-a-symbol' })
    f.bridge.revoke(run.token); f.bridge.revoke(bound.token)
  })

  it('revocation aborts an inflight guarded execution and drops late results', async () => {
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    let execSignal: AbortSignal | undefined
    const f = fixture({ schemas: () => [{ name: 'web_search' }], execute: exec => new Promise(resolve => {
      execSignal = exec.signal; entered(); exec.signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'late' }] }), { once: true })
    }) })
    const parentAbort = new AbortController()
    const run = f.bridge.runServerEntry(undefined, { ...trusted(), signal: parentAbort.signal })!
    const pending = f.bridge.callTool(run.token, 'web_search', {})
    await ready; parentAbort.abort()
    expect(execSignal?.aborted).toBe(true)
    expect(await pending).toMatchObject({ ok: false, status: 401 })
    expect(await f.bridge.catalog(run.token, undefined)).toMatchObject({ status: 401 })
  })

  it('blocks current local IO and lifecycle surfaces in auto, without changing custom HTTP policy', () => {
    for (const name of ['ops_bash', 'ops_read_files', 'job_output', 'schedule_create', 'send_message', 'interrupt_agent', 'create_goal', 'ask_user_question', 'mcp__remote__http']) expect(toolBridgable(name, 'auto')).toBe(false)
    expect(toolBridgable('web_search', 'auto')).toBe(true)
    expect(toolBridgable('mcp__remote__http', 'custom')).toBe(true)
  })

  it('makes collision-free tool names and copies resourceBase-only bundles to safe native directories', async () => {
    const resource = temp(); writeFileSync(join(resource, 'reference.txt'), 'native resource')
    const names = ['test', '../../escape:name', '长名字'.repeat(90)]
    const context = trusted()
    const bridge = createBridgeHandle({ skills: () => ({ list: async () => names.map(name => ({ name, description: 'fixture' })), get: async name => ({ name, description: 'fixture', content: 'read reference.txt', resourceBase: { kind: 'directory', path: resource } }) }),
      tools: () => ({ schemas: () => [{ name: 'skill_test' }], execute: async () => ({ content: [{ type: 'text', text: 'host' }] }) }), portOf: () => 8765,
      readConfig: () => ({ bridgeSkills: true, bridgeTools: 'auto', bridgeToolAllowlist: [] }) })
    const run = bridge.runServerEntry(undefined, context)!
    const catalog = await bridge.catalog(run.token, context.cwd)
    if ('error' in catalog) throw new Error(catalog.error)
    const published = [...catalog.skills.map(skill => skill.tool), ...catalog.tools.map(tool => tool.name)]
    expect(new Set(published).size).toBe(published.length)
    expect(catalog.skills[0]?.tool).not.toBe('skill_test')
    for (const name of names) expect(skillToolName(name)).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    const staged = await bridge.stageNativeSkills(context.cwd)
    expect(staged?.count).toBe(names.length)
    try {
      for (const name of names) {
        const dir = join(staged!.dir, '.claude', 'skills', skillToolName(name).slice(6))
        expect(relative(join(staged!.dir, '.claude', 'skills'), dir)).not.toContain('..')
        expect(readFileSync(join(dir, 'reference.txt'), 'utf8')).toBe('native resource')
        expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('name: "')
      }
    } finally { bridge.revoke(run.token); if (staged) await bridge.discardStagedSkills(staged.dir) }
  })

  it('does not mint a token before fallible shim initialization', () => {
    const state = new BridgeState(); const issue = vi.spyOn(state, 'issue')
    const bridge = createBridgeHandle({ skills: () => ({ list: async () => [], get: async () => undefined }), tools: () => undefined, portOf: () => 8765,
      readConfig: () => ({ bridgeSkills: true, bridgeTools: 'off', bridgeToolAllowlist: [] }), shimPath: () => { throw new Error('mount failed') }, state })
    expect(() => bridge.runServerEntry()).toThrow('mount failed'); expect(issue).not.toHaveBeenCalled()
  })

  it('caps catalog text even for huge special names and rejects ambiguous shim catalogs', async () => {
    const text = skillCatalogText(Array.from({ length: 1000 }, (_, i) => ({ name: `<special-${i}>`.repeat(100), description: 'x'.repeat(200), whenToUse: undefined, tool: skillToolName(String(i)) })))
    expect(text.length).toBeLessThanOrEqual(6000); expect(text).toContain('已省略')
    const catalog: ShimCatalog = { serverName: 'dsh_bridge', skills: [{ name: 'test', description: 'fixture', whenToUse: undefined, tool: 'skill_test' }], tools: [{ name: 'skill_test', description: 'collision', parameters: {} }] }
    expect(toolsOfCatalog(catalog)).toEqual([])
    expect(await handleShimMessage({ baseUrl: 'http://localhost', token: 't' }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'skill_test' } }, { catalog })).toMatchObject({ result: { isError: true } })
  })
})

describe('production fixes: CLI protocol and stream integrity', () => {
  it('uses config-supported sandbox on exec resume, never danger bypass for workspace-write', () => {
    const args = codexArgs('', 'workspace-write', [], undefined, undefined, undefined, 'synthetic-ref')
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'synthetic-ref'])
    expect(args).not.toContain('--sandbox'); expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(args).toContain('sandbox_mode="workspace-write"'); expect(args).toContain('approval_policy="never"')
  })

  it('keeps pinned provider/model after all malicious configOverrides and excludes HTTP from stdio argv', () => {
    const args = codexArgs('cli', 'workspace-write', ['model="evil"', 'model_provider=evil', 'model_providers.maestro_dsh.base_url="https://evil"', 'model_providers.maestro_dsh.wire_api="chat"'], { model: 'pinned', baseUrl: 'https://good/v1' })
    for (const [bad, good] of [['model="evil"', 'model="pinned"'], ['model_provider=evil', 'model_provider=maestro_dsh'], ['model_providers.maestro_dsh.base_url="https://evil"', 'model_providers.maestro_dsh.base_url="https://good/v1"'], ['model_providers.maestro_dsh.wire_api="chat"', 'model_providers.maestro_dsh.wire_api="responses"']]) expect(args.indexOf(good!)).toBeGreaterThan(args.indexOf(bad!))
    expect(codexMcpArgs([{ name: 'http', transport: 'http', command: 'must-not-spawn', args: [], env: {} }])).toEqual([])
  })

  it('projects full user tool_result text and failures by use id and actual name', () => {
    const body = '技能全文'.repeat(2000)
    const events = claudeToolResultEvents({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: body }] }, { type: 'tool_result', tool_use_id: 'u2', content: 'failed image', is_error: true }] } }, new Map([['u1', 'mcp__dsh_bridge__skill_office'], ['u2', 'generate_image']]))
    expect(events[0]?.detail).toBe(body); expect(events[0]?.text).toContain('mcp__dsh_bridge__skill_office')
    expect(events[1]).toMatchObject({ kind: 'error', detail: 'failed image' }); expect(events[1]?.text).toContain('u2')
  })

  it('preserves UTF8 split inside multibyte codepoints and discards every oversized line through newline', async () => {
    const bytes = Buffer.from('中文🙂\n'); const lines: string[] = []
    const { spawnFn } = scriptedSpawn(child => { queueMicrotask(() => {
      for (const byte of bytes) child.stdout.emit('data', Buffer.from([byte]))
      child.stdout.emit('data', Buffer.from('x'.repeat(4_000_001)))
      child.stdout.emit('data', Buffer.from('suffix\nok\n' + 'x'.repeat(4_000_001) + '\nnext\n'))
      child.stdout.emit('end'); child.exitCode = 0; child.emit('close', 0, null)
    }) })
    const { outcome } = runProcess({ spawnFn, file: 'fake', args: [], timeoutMs: 5000, signal: new AbortController().signal, onStdoutLine: line => { lines.push(line) } })
    await outcome; expect(lines).toEqual(['中文🙂', 'ok', 'next'])
  })

  it('ignores null/array/malformed nested Claude and Codex frames while retaining later valid results', async () => {
    const frames = ['null', '[]', '1', '{"type":"assistant","message":{"content":[null,{"type":"text","text":7}],"usage":null}}']
    const { spawnFn } = scriptedSpawn(child => { child.finish([...frames, JSON.stringify({ type: 'result', result: 'answer', subtype: 'success' })].join('\n')) })
    const result = await runClaudeTask({ spawnFn, claudePath: 'fake', task: 'task', cwd: undefined, model: '', permissionMode: 'inherit', baseUrl: '', authToken: '', timeoutMs: 5000, signal: new AbortController().signal, onUsage: () => {}, onEvent: () => {} })
    expect(result.ok).toBe(true)
    expect(() => codexFrameEvents({ type: 'item.completed', item: { type: 'reasoning', summary: [null, { text: 7 }] } } as unknown as Parameters<typeof codexFrameEvents>[0])).not.toThrow()
    expect(codexUsageStats({ usage: null } as unknown as Parameters<typeof codexUsageStats>[0])).toEqual({})
    const codex = scriptedSpawn(child => { child.finish(['null', '{"type":"item.completed","item":{"type":"agent_message","text":3}}', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer' } }), '{"type":"turn.completed","usage":null}'].join('\n')) })
    expect((await runCodexTask({ spawnFn: codex.spawnFn, codexPath: 'fake', task: 'task', cwd: undefined, model: '', sandbox: 'read-only', configOverrides: [], baseUrl: '', apiKey: '', timeoutMs: 5000, signal: new AbortController().signal, onEvent: () => {} })).ok).toBe(true)
  })

  it('cleans the one-run Claude settings file when spawn throws synchronously', async () => {
    let settings = ''
    const spawnFn: NonNullable<Parameters<typeof runClaudeTask>[0]['spawnFn']> = (_file, args) => { settings = args[args.indexOf('--settings') + 1]!; expect(existsSync(settings)).toBe(true); throw new Error('synthetic spawn failure') }
    await expect(runClaudeTask({ spawnFn, claudePath: 'fake', task: 'task', cwd: undefined, model: '', permissionMode: 'inherit', baseUrl: 'https://synthetic.invalid', authToken: 'synthetic-token', timeoutMs: 5000, signal: new AbortController().signal, onEvent: () => {} })).rejects.toThrow('synthetic spawn failure')
    expect(existsSync(settings)).toBe(false)
  })

  it('preflights the actual Codex Responses protocol and never approves 200 HTML', async () => {
    const endpoint = { provider: 'synthetic', model: 'm', api: 'openai-completions' as const, baseURL: 'https://synthetic.invalid', apiKey: 'synthetic-token' }
    let url = ''
    const fetchImpl: typeof fetch = async input => { url = String(input); return new Response('{"object":"response","output":[]}', { status: 200 }) }
    expect((await probeDshEndpoint(endpoint, { cli: 'codex', fetchImpl })).status).toBe('ok'); expect(url).toContain('/responses')
    expect(classifyProbe(endpoint, 200, '<html>login</html>').status).toBe('unknown')
  })
})

describe('production fixes: rollout final drain and old thread lookup', () => {
  it('settles final rollout totals and emits the same last live snapshot after the child closes', async () => {
    const home = temp(); const thread = '01a19019-1ece-7851-8c9f-7fe357ac0567'
    const dir = join(home, 'sessions', '2025', '03', '02'); mkdirSync(dir, { recursive: true })
    const file = join(dir, `rollout-2025-03-02T00-00-00-${thread}.jsonl`); writeFileSync(file, '')
    const previousHome = process.env['CODEX_HOME']; process.env['CODEX_HOME'] = home
    const seen: Record<string, string | number | boolean>[] = []
    const { spawnFn } = scriptedSpawn(child => { queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: thread }) + '\n'))
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer' } }) + '\n'))
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 2 } }) + '\n'))
      appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7, cache_write_input_tokens: 3 } } } }))
      child.stdout.emit('end'); child.exitCode = 0; child.emit('close', 0, null)
    }) })
    try {
      const result = await runCodexTask({ spawnFn, codexPath: 'fake', task: 'task', cwd: undefined, model: '', sandbox: 'read-only', timeoutMs: 5000, signal: new AbortController().signal, baseUrl: '', apiKey: '', onEvent: () => {}, onUsage: stats => { seen.push(stats) } })
      expect(result.ok).toBe(true)
      const totals = { inputTokens: 57, cachedInputTokens: 40, outputTokens: 7, cacheWriteTokens: 3, usageInputSemantics: 'uncached' }
      expect(result.stats).toMatchObject(totals); expect(seen.at(-1)).toMatchObject(totals)
    } finally { if (previousHome === undefined) delete process.env['CODEX_HOME']; else process.env['CODEX_HOME'] = previousHome }
  })

  it('locates exact old-calendar thread and drains final appended partial line on stop', () => {
    const home = temp(); const thread = '01a19019-1ece-7851-8c9f-7fe357ac0567'
    const dir = join(home, 'sessions', '2025', '03', '02'); mkdirSync(dir, { recursive: true })
    const file = join(dir, `rollout-2025-03-02T00-00-00-${thread}.jsonl`); writeFileSync(file, '')
    expect(findRolloutFile(thread, home, new Date(2026, 9, 31).getTime())).toBe(file)
    expect(findRolloutFile('../unsafe', home, Date.now())).toBeUndefined()
    const seen: unknown[] = []
    const tail = startRolloutUsageTail({ threadId: thread, codexHome: home, intervalMs: 60000, onUsage: stats => { seen.push(stats) } })
    appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7, cache_write_input_tokens: 3 } } } }))
    tail.stop(); tail.stop()
    expect(seen).toEqual([{ inputTokens: 57, cachedInputTokens: 40, outputTokens: 7, cacheWriteTokens: 3, usageInputSemantics: 'uncached' }])
  })
})
