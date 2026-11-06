/** Correct-behavior regressions for QA06-09; historical defect fixtures stay unchanged. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveOf } from '../src/config.js'
import { CliPathCache, DispatchError, runDispatch, type DispatchDeps, type DispatchParams, type DispatchValue } from '../src/dispatch.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { registerDispatchTool, renderSummary, TOOL_OUTPUT_SCHEMA, type ToolExec } from '../src/tool.js'
import { BridgeState, createBridgeHandle, skillCatalogText, type BridgeHandle, type BridgeCatalog } from '../src/bridge.js'
import { handleShimMessage } from '../src/bridge-shim.js'
import { probeDshEndpoint } from '../src/preflight.js'
import { runProcess } from '../src/spawn.js'
import * as mcp from '../src/mcp.js'
import * as gitContext from '../src/git-context.js'
import { scriptedSpawn } from './fake-child.js'
import { resolveTestDshModel, withTestDshRoutes } from './dsh-route-fixture.js'

const safety = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('node:child_process', () => {
  const reject = (name: string) => (..._args: unknown[]) => {
    safety.calls.push(name)
    throw new Error(`Forbidden real process in QA06-09 test: ${name}`)
  }
  return { spawn: reject('spawn'), execFile: reject('execFile'), exec: reject('exec'), spawnSync: reject('spawnSync'), execSync: reject('execSync'), execFileSync: reject('execFileSync') }
})

const dirs: string[] = []
beforeEach(() => {
  safety.calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Real network is forbidden in QA06-09 tests') }))
})
afterEach(async () => {
  expect(safety.calls).toEqual([])
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const assessment = { taskDifficulty: 'medium', difficultyReason: 'Independent multi-step controlled regression with verification' } as const
const rawAssessment = { task_difficulty: 'medium', difficulty_reason: assessment.difficultyReason }
type Ending = 'done' | 'failed' | 'timeout' | 'cancelled'
function fixture(cli: 'codex' | 'claude' = 'codex', ending: Ending = 'done', withRef = true) {
  const config = withTestDshRoutes(effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath, injectGitContext: false, failureRetries: 0 }))
  config.timeoutMinutes = 0.001
  const controller = new AbortController()
  const state = { ending, withRef }
  const spawn = scriptedSpawn(child => {
    expect(child.pid).toBeUndefined()
    child.onStdin = () => {
      const frames: unknown[] = []
      if (state.withRef) frames.push(cli === 'codex' ? { type: 'thread.started', thread_id: 'qa-recovery' } : { type: 'system', subtype: 'init', session_id: 'qa-recovery' })
      if (cli === 'codex') {
        frames.push({ type: 'item.completed', item: { type: 'agent_message', text: 'partial or final answer' } })
        frames.push(state.ending === 'done' ? { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } } : { type: 'turn.failed', error: { message: 'controlled CLI failure' }, usage: { input_tokens: 10, output_tokens: 2 } })
      } else frames.push({ type: 'result', subtype: state.ending === 'done' ? 'success' : 'error', result: 'partial or final answer', is_error: state.ending !== 'done', usage: { input_tokens: 10, output_tokens: 2 } })
      const stdout = frames.map(frame => JSON.stringify(frame)).join('\n') + '\n'
      if (state.ending === 'done' || state.ending === 'failed') child.finish(stdout, state.ending === 'done' ? 0 : 1)
      else queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(stdout))
        if (state.ending === 'cancelled') controller.abort(new Error('controlled cancellation'))
      })
    }
  })
  const registry = new TaskRegistry()
  const pathCache = new CliPathCache(() => config, spawn.spawnFn)
  vi.spyOn(pathCache, 'pathOf').mockResolvedValue(process.execPath)
  const deps: DispatchDeps = {
    readConfig: () => config, registry, pathCache, spawnFn: spawn.spawnFn,
    controllers: new Map(), limiter: new Limiter(() => 1),
    resolveDshModel: vi.fn(resolveTestDshModel),
    preflightDshModel: vi.fn(async () => ({ status: 'ok', detail: 'controlled preflight' })),
  }
  const params: DispatchParams = { ...assessment, cli, task: 'Run the isolated multi-step regression.', sessionId: 'owner-A', cwd: process.cwd() }
  const definitions: Array<{ execute(raw: unknown, exec: ToolExec): Promise<DispatchValue> }> = []
  registerDispatchTool({ tools: { register(definition: unknown) { definitions.push(definition as typeof definitions[number]); return () => {} } } } as unknown as Context, deps)
  const execute = (raw: Record<string, unknown> = {}, owner = 'owner-A') => definitions[0]!.execute(
    { ...rawAssessment, cli, task: params.task, cwd: process.cwd(), ...raw },
    { signal: controller.signal, agent: { id: owner } },
  )
  return { config, deps, registry, controller, spawn, params, state, execute }
}

function bridgeFixture(names = ['alpha'], toolNames = ['skill_alpha', 'not_allowlisted']) {
  const config = effectiveOf({ bridgeSkills: true, bridgeTools: 'custom', bridgeToolAllowlist: ['skill_alpha'] })
  const skills = names.map(name => ({ name, description: `${name} skill` }))
  const tools = toolNames.map(name => ({ name, description: `${name} host tool`, parameters: { type: 'object', properties: {} } }))
  const list = vi.fn(async () => skills)
  const get = vi.fn(async (name: string) => ({ name, description: 'controlled skill', content: 'SKILL_BODY_MARKER' }))
  const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'HOST_TOOL_MARKER' }] }))
  const state = new BridgeState()
  const bridge = createBridgeHandle({
    readConfig: () => config, skills: () => ({ list, get }), tools: () => ({ schemas: () => tools, execute }),
    state, portOf: () => 1, shimPath: () => fileURLToPath(new URL('../src/bridge-shim.ts', import.meta.url)),
  })
  return { bridge, state, config, skills, tools, list, get, execute }
}
function mint(bridge: BridgeHandle) {
  const parent = Symbol('host-minted-parent')
  const agent = { id: 'owner-A' }
  const run = bridge.runServerEntry(undefined, { agent, parent, sessionId: agent.id, cwd: process.cwd() })
  if (run === undefined) throw new Error('Expected a controlled bridge token')
  return { ...run, agent, parent }
}
async function catalogOf(bridge: BridgeHandle, token: string): Promise<BridgeCatalog> {
  const catalog = await bridge.catalog(token, process.cwd())
  if ('error' in catalog) throw new Error(catalog.error)
  return catalog
}

// This is the ordinary tool return contract, not a board-only registry assertion.
describe('QA06 structured execution outcome and recovery', () => {
  for (const cli of ['claude', 'codex'] as const) {
    for (const ending of ['done', 'failed', 'timeout', 'cancelled'] as const) {
      it.each([true, false])(`${cli} ${ending} returns truthful metadata with ref=%s`, async withRef => {
        const f = fixture(cli, ending, withRef)
        f.config.failureRetries = ending === 'timeout' || ending === 'cancelled' ? 2 : 0
        const value = await f.execute()
        expect(value).toMatchObject({ ok: ending === 'done', taskId: f.registry.list()[0]!.id, phase: ending, cli, sessionRef: withRef ? 'qa-recovery' : '' })
        expect(value.exitCode === null || Number.isInteger(value.exitCode)).toBe(true)
        expect(f.spawn.launches).toHaveLength(1)
        expect(f.deps.controllers.size).toBe(0)
        const text = renderSummary(value)
        expect(text).toContain(value.taskId)
        expect(text).toContain(ending)
        if (ending !== 'done') { expect(value.error).toEqual(expect.any(String)); expect(text).toContain(value.error!); expect(text).not.toContain('任务完成') }
        expect(text.includes('resume="qa-recovery"')).toBe(withRef)
      })
    }
  }
  it('keeps runner rejection semantics while its error carries the valid recovery anchor', async () => {
    const f = fixture('codex', 'failed')
    const error = await runDispatch(f.deps, f.params, f.controller.signal).catch(error => error as unknown)
    expect(error).toBeInstanceOf(DispatchError)
    expect((error as DispatchError).value).toMatchObject({ ok: false, phase: 'failed', taskId: f.registry.list()[0]!.id, sessionRef: 'qa-recovery', error: expect.stringContaining('controlled CLI failure') })
  })
  it('lets only the same owner resume a failed tool outcome without weakening scope guards', async () => {
    const f = fixture('codex', 'failed')
    const failed = await f.execute()
    f.state.ending = 'done'
    await expect(f.execute({ resume: failed.sessionRef }, 'owner-B')).rejects.toThrow()
    expect(f.spawn.launches).toHaveLength(1)
    const resumed = await f.execute({ resume: failed.sessionRef })
    expect(resumed.ok).toBe(true)
    expect(resumed.taskId).not.toBe(failed.taskId)
    expect(f.spawn.launches[1]!.spawnArgs.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(f.spawn.launches[1]!.spawnArgs).toContain(failed.sessionRef)
    expect(f.registry.list().find(task => task.id === resumed.taskId)?.replyTo).toBe(failed.taskId)
  })
  it('declares the new metadata and nullable exit status in the strict output schema', () => {
    expect(TOOL_OUTPUT_SCHEMA.required).toEqual(expect.arrayContaining(['ok', 'taskId', 'phase']))
    // Integer and null are disjoint: the strict host schema intentionally uses oneOf.
    expect(TOOL_OUTPUT_SCHEMA.properties.exitCode).toEqual({ oneOf: [{ type: 'integer' }, { type: 'null' }] })
  })
})

describe('QA07 all explicit model forms use trusted DSH routing', () => {
  it.each(['claude', 'codex'] as const)('resolves and preflights a bare model for %s before launch', async cli => {
    const f = fixture(cli)
    const result = await f.execute({ model: 'group/requested-model' })
    expect(result.model).toBe('group/requested-model')
    expect(f.deps.resolveDshModel).toHaveBeenCalledExactlyOnceWith(`test-${cli}::group/requested-model`)
    expect(f.deps.preflightDshModel).toHaveBeenCalledWith(expect.objectContaining({ provider: `test-${cli}`, model: result.model }), cli, expect.any(AbortSignal))
    expect(f.spawn.launches[0]!.spawnArgs).toContain(cli === 'codex' ? `model=${JSON.stringify(result.model)}` : result.model)
    if (cli === 'codex') {
      expect(f.spawn.launches[0]!.spawnArgs).toContain('--ignore-user-config')
      expect(f.spawn.launches[0]!.spawnArgs).toContain('model_provider=maestro_dsh')
      expect(f.spawn.launches[0]!.spawnArgs).toContain('model_providers.maestro_dsh.base_url="https://test-codex.invalid/v1"')
    }
  })
  it('pins a qualified provider/model without treating it as a bare CLI model', async () => {
    const f = fixture()
    const result = await f.execute({ model: 'test-codex::requested' })
    expect(result).toMatchObject({ ok: true, model: 'requested' })
    expect(f.deps.resolveDshModel).toHaveBeenCalledExactlyOnceWith('test-codex::requested')
  })
  it('falls back only the automatic provider while preserving the requested bare model', async () => {
    const f = fixture()
    const result = await runDispatch(f.deps, { ...f.params, model: 'requested', primaryModel: { provider: 'test-claude', model: 'main' } }, f.controller.signal)
    expect(result.model).toBe('requested')
    expect(vi.mocked(f.deps.resolveDshModel!).mock.calls.map(args => args[0])).toEqual(['test-claude::requested', 'test-codex::requested'])
    expect(f.deps.preflightDshModel).toHaveBeenCalledTimes(1)
  })
  it('uses the compatible primary provider, not the configured provider, for a bare name', async () => {
    const f = fixture()
    await runDispatch(f.deps, { ...f.params, model: 'requested', primaryModel: { provider: 'test-codex', model: 'main' } }, f.controller.signal)
    expect(f.deps.resolveDshModel).toHaveBeenCalledExactlyOnceWith('test-codex::requested')
  })
  it('does not fall back from an explicitly pinned incompatible provider', async () => {
    const f = fixture()
    const result = await f.execute({ model: 'test-claude::requested' })
    expect(result).toMatchObject({ ok: false, phase: 'failed', sessionRef: '' })
    expect(f.deps.resolveDshModel).toHaveBeenCalledExactlyOnceWith('test-claude::requested')
    expect(f.deps.preflightDshModel).not.toHaveBeenCalled()
    expect(f.spawn.launches).toHaveLength(0)
  })
  it.each(['resolver', 'endpoint', 'credentials', 'different-model', 'different-provider'] as const)('fails closed for missing or mismatched %s', async problem => {
    const f = fixture()
    let model = 'requested'
    if (problem === 'resolver') f.deps.resolveDshModel = undefined
    if (problem === 'endpoint') f.config.codex.dshModel = ''
    if (problem === 'credentials') f.deps.resolveDshModel = vi.fn(async selection => ({ ...await resolveTestDshModel(selection), apiKey: '' }))
    if (problem === 'different-model') f.deps.resolveDshModel = vi.fn(async selection => ({ ...await resolveTestDshModel(selection), model: 'not-requested' }))
    if (problem === 'different-provider') { model = 'test-codex::requested'; f.deps.resolveDshModel = vi.fn(async selection => ({ ...await resolveTestDshModel(selection), provider: 'other' })) }
    const result = await f.execute({ model })
    expect(result).toMatchObject({ ok: false, phase: 'failed', sessionRef: '' })
    expect(f.deps.preflightDshModel).not.toHaveBeenCalled()
    expect(f.spawn.launches).toHaveLength(0)
  })
  it('does not replace an explicit model rejected by preflight', async () => {
    const f = fixture()
    f.deps.preflightDshModel = vi.fn(async () => ({ status: 'mismatch', detail: 'requested model rejected' }))
    const result = await f.execute({ model: 'test-codex::requested' })
    expect(result).toMatchObject({ ok: false, error: 'requested model rejected' })
    expect(f.deps.resolveDshModel).toHaveBeenCalledTimes(1)
    expect(f.spawn.launches).toHaveLength(0)
  })
  it('rejects disagreeing internal dshModel and tool model overrides', async () => {
    const f = fixture()
    await expect(runDispatch(f.deps, { ...f.params, model: 'other', dshModel: 'test-codex::requested' }, f.controller.signal)).rejects.toThrow('model 与 dshModel')
    expect(f.deps.resolveDshModel).not.toHaveBeenCalled()
    expect(f.spawn.launches).toHaveLength(0)
  })
})

describe('QA08 cancellation wins every asynchronous launch boundary', () => {
  it.each(['begin', 'path', 'resolve', 'preflight', 'git'] as const)('never launches or retries after cancellation during %s', async boundary => {
    const f = fixture()
    f.config.failureRetries = 2
    const entered = deferred<void>(), release = deferred<void>()
    let observed: AbortSignal | undefined
    const wait = async () => { entered.resolve(undefined); await release.promise }
    if (boundary === 'begin') f.deps.beginUsage = async () => { await wait() }
    if (boundary === 'path') vi.mocked(f.deps.pathCache.pathOf).mockImplementation(async () => { await wait(); return process.execPath })
    if (boundary === 'resolve') f.deps.resolveDshModel = vi.fn(async selection => { await wait(); return await resolveTestDshModel(selection) })
    if (boundary === 'preflight') f.deps.preflightDshModel = vi.fn(async (_endpoint, _cli, signal) => { observed = signal; await wait(); return { status: 'ok', detail: 'late preflight' } })
    if (boundary === 'git') { f.config.injectGitContext = true; vi.spyOn(gitContext, 'gitContextFor').mockImplementation(async () => { await wait(); return undefined }) }
    const settled = runDispatch(f.deps, f.params, f.controller.signal).catch(error => error as DispatchError)
    await entered.promise
    f.controller.abort(new Error('cancelled before launch'))
    if (boundary === 'preflight') expect(observed?.aborted).toBe(true)
    release.resolve(undefined)
    expect(await settled).toMatchObject({ value: { ok: false, phase: 'cancelled', sessionRef: '' } })
    expect(f.spawn.launches).toHaveLength(0)
    expect(f.deps.controllers.size).toBe(0)
    const slot = f.deps.limiter.acquire(new AbortController().signal)
    await slot.waited
    slot.release()
  })
  it('rejects an already-cancelled dispatch and raw process without any launch', async () => {
    const f = fixture()
    const reason = new Error('already cancelled')
    f.controller.abort(reason)
    await expect(runDispatch(f.deps, f.params, f.controller.signal)).rejects.toBe(reason)
    expect(() => runProcess({ file: 'never-run', args: [], cwd: process.cwd(), signal: f.controller.signal, timeoutMs: 100, spawnFn: f.spawn.spawnFn })).toThrow(reason)
    expect(f.registry.list()).toEqual([])
    expect(f.deps.pathCache.pathOf).not.toHaveBeenCalled()
    expect(f.spawn.launches).toEqual([])
  })
  it('cleans an already-created native skill directory when cancellation wins its awaited return', async () => {
    const f = fixture('claude'), b = bridgeFixture()
    f.config.claudeSkillsMode = 'native'
    f.deps.bridge = b.bridge
    const dir = await mkdtemp(join(tmpdir(), 'maestro-qa08-native-'))
    dirs.push(dir)
    const entered = deferred<void>(), release = deferred<void>()
    vi.spyOn(b.bridge, 'stageNativeSkills').mockImplementation(async () => { entered.resolve(undefined); await release.promise; return { dir, count: 1 } })
    const discard = vi.spyOn(b.bridge, 'discardStagedSkills')
    const settled = f.execute()
    await entered.promise
    f.controller.abort(new Error('native staging cancelled'))
    release.resolve(undefined)
    expect(await settled).toMatchObject({ ok: false, phase: 'cancelled' })
    expect(discard).toHaveBeenCalledExactlyOnceWith(dir)
    expect(existsSync(dir)).toBe(false)
    expect(f.spawn.launches).toEqual([])
  })
  it('revokes a bridge token when cancellation arrives while its injection catalog is pending', async () => {
    const f = fixture(), b = bridgeFixture()
    f.deps.bridge = b.bridge
    const entered = deferred<void>(), release = deferred<void>()
    b.list.mockImplementation(async () => { entered.resolve(undefined); await release.promise; return b.skills })
    const issue = vi.spyOn(b.bridge, 'runServerEntry')
    const settled = f.execute()
    await entered.promise
    const token = issue.mock.results[0]!.value!.token
    f.controller.abort(new Error('catalog cancelled'))
    release.resolve(undefined)
    expect(await settled).toMatchObject({ ok: false, phase: 'cancelled' })
    expect(b.state.resolve(token)).toBeUndefined()
    expect(f.spawn.launches).toEqual([])
    expect(f.deps.controllers.size).toBe(0)
  })
  it('unlinks the one-shot MCP file and revokes the token after an awaited write is cancelled', async () => {
    const f = fixture('claude'), b = bridgeFixture()
    f.config.claudeSkillsMode = 'bridge'
    f.deps.bridge = b.bridge
    const written = deferred<string>(), release = deferred<void>()
    const realWrite = mcp.writeClaudeMcpConfig
    vi.spyOn(mcp, 'writeClaudeMcpConfig').mockImplementation(async servers => {
      const path = await realWrite(servers)
      written.resolve(path)
      await release.promise
      return path
    })
    const issue = vi.spyOn(b.bridge, 'runServerEntry')
    const settled = f.execute()
    const path = await written.promise
    f.controller.abort(new Error('MCP write cancelled'))
    release.resolve(undefined)
    expect(await settled).toMatchObject({ ok: false, phase: 'cancelled' })
    expect(existsSync(path)).toBe(false)
    expect(b.state.resolve(issue.mock.results[0]!.value!.token)).toBeUndefined()
    expect(f.spawn.launches).toEqual([])
  })
  it.each(['fetch', 'body'] as const)('propagates caller abort instead of an advisory unknown during %s', async boundary => {
    const endpoint = await resolveTestDshModel('test-codex::probe')
    const controller = new AbortController(), entered = deferred<void>(), release = deferred<void>()
    const reason = new Error('caller probe cancellation')
    let internalSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      internalSignal = init?.signal ?? undefined
      if (boundary === 'fetch') { entered.resolve(undefined); await release.promise }
      return { status: 200, text: async () => { if (boundary === 'body') { entered.resolve(undefined); await release.promise }; return '{}' } } as Response
    }) as unknown as typeof fetch
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const outcome = probeDshEndpoint(endpoint, { signal: controller.signal, cli: 'codex', fetchImpl }).catch(error => error as unknown)
    await entered.promise
    controller.abort(reason)
    expect(internalSignal?.aborted).toBe(true)
    release.resolve(undefined)
    expect(await outcome).toBe(reason)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})

describe('QA09 stable shared names without widening host allowlists', () => {
  it('loads the intended skill when its injected name collides with an allowlisted host tool', async () => {
    const b = bridgeFixture(), run = mint(b.bridge)
    try {
      const injected = await b.bridge.skillsFor(process.cwd(), undefined, run.token)
      const catalog = await catalogOf(b.bridge, run.token)
      expect(injected).toEqual(catalog.skills)
      expect(injected[0]!.tool).not.toBe('skill_alpha')
      expect(skillCatalogText(injected)).toContain(`加载工具：${catalog.skills[0]!.tool}`)
      expect(catalog.tools.map(tool => tool.name)).toEqual(['skill_alpha'])
      const fakeFetch = async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { kind: string; name: string; arguments?: Record<string, unknown> }
        const value = body.kind === 'skill' ? await b.bridge.loadSkill(run.token, body.name, process.cwd()) : await b.bridge.callTool(run.token, body.name, body.arguments)
        return new Response(JSON.stringify(value), { status: value.ok ? 200 : value.status })
      }
      const value = await handleShimMessage({ baseUrl: 'http://127.0.0.1:1', token: run.token }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: injected[0]!.tool, arguments: {} } }, { cwd: process.cwd(), catalog, fetchImpl: fakeFetch })
      expect(JSON.stringify(value?.result)).toContain('SKILL_BODY_MARKER')
      expect(b.execute).not.toHaveBeenCalled()
      expect(b.get).toHaveBeenCalledTimes(1)
      expect(await b.bridge.callTool(run.token, 'not_allowlisted', {})).toMatchObject({ ok: false, status: 403 })
      expect(await b.bridge.callTool(run.token, 'skill_alpha', {})).toMatchObject({ ok: true, text: 'HOST_TOOL_MARKER' })
      expect(b.execute).toHaveBeenCalledWith(expect.objectContaining({ agent: run.agent, parent: run.parent }))
    } finally { b.bridge.revoke(run.token) }
  })
  it('injects exactly the token catalog name into the real dispatch task text', async () => {
    const f = fixture(), b = bridgeFixture()
    f.deps.bridge = b.bridge
    const original = b.bridge.skillsFor.bind(b.bridge)
    let injectedName = '', token = ''
    vi.spyOn(b.bridge, 'skillsFor').mockImplementation(async (cwd, signal, runToken) => {
      expect(runToken).toEqual(expect.any(String))
      token = runToken!
      const skills = await original(cwd, signal, runToken)
      injectedName = skills[0]!.tool
      expect((await catalogOf(b.bridge, token)).skills[0]!.tool).toBe(injectedName)
      return skills
    })
    expect((await f.execute()).ok).toBe(true)
    expect(injectedName).not.toBe('skill_alpha')
    expect(f.spawn.launches[0]!.stdinText).toContain(`加载工具：${injectedName}`)
    expect(b.state.resolve(token)).toBeUndefined()
  })
  it('makes the conflict mapping deterministic across list ordering and independent tokens', async () => {
    const b = bridgeFixture(['zeta', 'alpha']), first = mint(b.bridge), second = mint(b.bridge)
    try {
      const one = await b.bridge.skillsFor(process.cwd(), undefined, first.token)
      b.skills.reverse()
      const two = await b.bridge.skillsFor(process.cwd(), undefined, second.token)
      expect(one).toEqual(two)
      expect(one.map(skill => skill.name)).toEqual(['alpha', 'zeta'])
      expect(new Set(one.map(skill => skill.tool)).size).toBe(one.length)
    } finally { b.bridge.revoke(first.token); b.bridge.revoke(second.token) }
  })
  it('never lets a newly added host tool capture an already injected skill name', async () => {
    const b = bridgeFixture(['alpha'], []), run = mint(b.bridge)
    try {
      const injected = await b.bridge.skillsFor(process.cwd(), undefined, run.token)
      expect(injected[0]!.tool).toBe('skill_alpha')
      b.tools.push({ name: 'skill_alpha', description: 'late tool', parameters: { type: 'object', properties: {} } })
      const catalog = await catalogOf(b.bridge, run.token)
      expect(catalog.skills[0]!.tool).toBe('skill_alpha')
      expect(catalog.tools).toEqual([])
      expect(await b.bridge.callTool(run.token, 'skill_alpha', {})).toMatchObject({ ok: false, status: 403 })
      expect(b.execute).not.toHaveBeenCalled()
    } finally { b.bridge.revoke(run.token) }
  })
  it('keeps a frozen skill name when its colliding host tool is revoked', async () => {
    const b = bridgeFixture(), run = mint(b.bridge)
    try {
      const injected = await b.bridge.skillsFor(process.cwd(), undefined, run.token)
      b.config.bridgeToolAllowlist = []
      const catalog = await catalogOf(b.bridge, run.token)
      expect(catalog.skills).toEqual(injected)
      expect(catalog.tools).toEqual([])
      expect(await b.bridge.callTool(run.token, 'skill_alpha', {})).toMatchObject({ ok: false, status: 403 })
    } finally { b.bridge.revoke(run.token) }
  })
  it('does not expose the colliding host tool without the trusted execution agent', async () => {
    const b = bridgeFixture()
    const run = b.bridge.runServerEntry(undefined, { sessionId: 'forged-owner', cwd: process.cwd() })!
    try {
      const catalog = await catalogOf(b.bridge, run.token)
      expect(catalog.tools).toEqual([])
      expect(catalog.skills[0]!.tool).toBe('skill_alpha')
      expect(await b.bridge.callTool(run.token, 'skill_alpha', {})).toMatchObject({ ok: false, status: 403 })
      expect(b.execute).not.toHaveBeenCalled()
    } finally { b.bridge.revoke(run.token) }
  })
})
