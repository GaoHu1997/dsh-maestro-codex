import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { grokHomeConfig, grokMcpEnv, runGrokTask } from '../src/channels/grok.js'
import { mcpChildEnv } from '../src/mcp-env-shim.js'
import type { SpawnFn } from '../src/spawn.js'
import { FakeChild, scriptedSpawn } from './fake-child.js'

type RunOptions = Parameters<typeof runGrokTask>[0]
const roots: string[] = []
const children: FakeChild[] = []
const controllers: AbortController[] = []
const pending: Promise<unknown>[] = []
// The assertion deadline remains Vitest's 5s. Held fake children need a separate
// finite idle budget so real filesystem scheduling cannot resolve them early.
const SYNTHETIC_IDLE_TIMEOUT_MS = 30_000
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-grok-isolation-'))
  roots.push(dir)
  return dir
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
function server(name: string) {
  return { name, command: process.execPath, args: ['-e', ''], env: { TOKEN: `secret-${name}` } }
}
function frames(id: string, text = id): string {
  return `${JSON.stringify({ type: 'result', session_id: id, result: text, is_error: false })}\n`
}
function spawn(script: (child: FakeChild) => void) {
  return scriptedSpawn(child => { children.push(child); script(child) })
}
function run(home: string, spawnFn: SpawnFn, patch: Partial<RunOptions> = {}) {
  const controller = new AbortController()
  controllers.push(controller)
  const signal = patch.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, patch.signal])
  const promise = runGrokTask({
    grokPath: 'grok', task: 'test', cwd: process.cwd(), model: 'grok-test',
    permissionMode: 'default', baseUrl: 'https://provider.invalid/v1', apiKey: 'synthetic-provider-key',
    grokHome: home, timeoutMs: SYNTHETIC_IDLE_TIMEOUT_MS,
    onEvent: () => {}, ...patch, signal, spawnFn,
  })
  pending.push(promise)
  // Register a rejection handler immediately; some cases intentionally fail before spawn.
  void promise.catch(() => {})
  return promise
}
afterEach(async () => {
  vi.useRealTimers()
  // Abort every owned run first, including waiters that have no child yet. This
  // also prevents a queued child appearing after the killed-children snapshot.
  for (const controller of controllers.splice(0)) controller.abort(new Error('Synthetic test cleanup'))
  for (const child of children.splice(0)) child.kill()
  await Promise.allSettled(pending.splice(0))
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Grok MCP environment isolation', () => {
  let shimDir: string
  let shimPath: string
  const credentialNames = [
    'XAI_API_KEY', 'GROK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY',
    'AZURE_OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'MAESTRO_DSH_PROVIDER_KEY', 'MAESTRO_BRIDGE_TOKEN',
    'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'GROK_XAI_API_BASE_URL', 'AZURE_OPENAI_ENDPOINT',
  ]
  beforeAll(() => {
    shimDir = mkdtempSync(join(tmpdir(), 'maestro-grok-shim-'))
    writeFileSync(join(shimDir, 'package.json'), JSON.stringify({ type: 'module' }))
    for (const name of ['spawn', 'mcp-env-shim']) {
      const source = readFileSync(fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url)), 'utf8')
      writeFileSync(join(shimDir, `${name}.js`), ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ES2022 },
      }).outputText)
    }
    shimPath = join(shimDir, 'mcp-env-shim.js')
  })
  afterAll(() => { rmSync(shimDir, { recursive: true, force: true }) })

  it.each([false, true])('a real shim child receives only its declared credentials (declared=%s)', declared => {
    const declaredEnv: Record<string, string> = declared ? { OWN_TOKEN: 'server-token', XAI_API_KEY: 'explicit-server-key' } : {}
    const probeNames = [...credentialNames, 'OWN_TOKEN', 'KEEP']
    const program = `const names=${JSON.stringify(probeNames)}; process.stdout.write(JSON.stringify({values:Object.fromEntries(names.map(n=>[n,process.env[n]??null])),aliases:Object.keys(process.env).filter(n=>/^MAESTRO_MCP_SECRET_/i.test(n))}))`
    const servers = [{ name: 'probe', command: process.execPath, args: ['-e', program], env: declaredEnv }]
    const body = grokHomeConfig(servers, shimPath)
    const lines = body.split('\n')
    const command = JSON.parse(lines.find(line => line.startsWith('command = '))!.slice('command = '.length)) as string
    const args = JSON.parse(lines.find(line => line.startsWith('args = '))!.slice('args = '.length)) as string[]
    expect(command).toBe(process.execPath)
    expect(args[0]).toBe(shimPath)
    expect(body).not.toContain('server-token')
    expect(body).not.toContain('explicit-server-key')
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'], ELECTRON_RUN_AS_NODE: '1',
      KEEP: 'safe', MAESTRO_MCP_SECRET_9_0: 'other-server-token',
      ...Object.fromEntries(credentialNames.map(name => [name, 'ambient-provider-secret'])),
      ...grokMcpEnv(servers),
    }
    const output = JSON.parse(execFileSync(command, args, { env, encoding: 'utf8', timeout: 15000 })) as {
      values: Record<string, string | null>; aliases: string[]
    }
    expect(output.aliases).toEqual([])
    for (const name of credentialNames) {
      expect(output.values[name], name).toBe(declared && name === 'XAI_API_KEY' ? 'explicit-server-key' : null)
    }
    expect(output.values['OWN_TOKEN']).toBe(declared ? 'server-token' : null)
    expect(output.values['KEEP']).toBe('safe')
  }, 20000)

  it('removes case variants while explicitly declared provider names are restored', () => {
    const env = mcpChildEnv({ keys: ['XAI_API_KEY'], aliases: ['MAESTRO_MCP_SECRET_0_0'] }, {
      xAi_ApI_KeY: 'ambient', MaEsTrO_McP_sEcReT_9_0: 'other',
      MAESTRO_MCP_SECRET_0_0: 'own', KEEP: 'safe',
    })
    expect(env).toEqual({ KEEP: 'safe', XAI_API_KEY: 'own' })
  })

  it('does not inject aliases for skipped HTTP or empty-command servers', () => {
    expect(grokMcpEnv([
      { command: '', transport: 'http', env: { TOKEN: 'http-secret' } },
      { command: ' ', env: { TOKEN: 'empty-secret' } },
      server('stdio'),
    ])).toEqual({ MAESTRO_MCP_SECRET_2_0: 'secret-stdio' })
  })
})

describe('Grok shared-home isolation', () => {
  it('keeps the synthetic watchdog independent of queue synchronization and filesystem scheduling', async () => {
    // Advance a controlled clock, not wall time: a held fixture must not silently
    // finish while the test is still arranging its queued run.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const home = fixture()
      const started = deferred<FakeChild>()
      const first = run(home, spawn(child => { started.resolve(child) }).spawnFn)
      const child = await started.promise
      const kill = vi.spyOn(child, 'kill')
      await vi.advanceTimersByTimeAsync(1001)
      expect(kill).not.toHaveBeenCalled()
      const waiting = deferred<void>()
      const nextSpawn = spawn(next => { next.finish(frames('clock-next')) })
      const next = run(home, nextSpawn.spawnFn, {
        onEvent: (_kind, text) => { if (text.includes('等待上一轮')) waiting.resolve() },
      })
      await waiting.promise
      expect(nextSpawn.launches).toHaveLength(0)
      child.finish(frames('clock-first'))
      expect((await first).ok).toBe(true)
      expect((await next).sessionId).toBe('clock-next')
    } finally { vi.useRealTimers() }
  })

  it('keeps the first configuration until close, even after its result frame, then starts the next run', async () => {
    const home = fixture()
    const started = deferred<FakeChild>()
    const waiting = deferred<void>()
    const firstSpawn = spawn(child => { started.resolve(child) })
    const first = run(home, firstSpawn.spawnFn, { mcpServers: [server('first')] })
    const child = await started.promise
    child.stdout.emit('data', Buffer.from(frames('session-first')))
    const firstConfig = readFileSync(join(home, 'config.toml'), 'utf8')
    let secondConfig = ''
    const secondSpawn = spawn(child => {
      secondConfig = readFileSync(join(home, 'config.toml'), 'utf8')
      child.finish(frames('session-second'))
    })
    const second = run(home, secondSpawn.spawnFn, {
      mcpServers: [], onEvent: (_kind, text) => { if (text.includes('等待上一轮')) waiting.resolve() },
    })
    await waiting.promise
    expect(secondSpawn.launches).toHaveLength(0)
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(firstConfig)
    expect(existsSync(join(home, '.maestro-run.lock'))).toBe(true)
    child.finish('')
    const [a, b] = await Promise.all([first, second])
    expect(a.sessionId).toBe('session-first')
    expect(a.finalText).toBe('session-first')
    expect(b.sessionId).toBe('session-second')
    expect(a.ok && b.ok).toBe(true)
    expect(secondConfig).not.toContain('[mcp_servers.')
    expect(secondSpawn.launches).toHaveLength(1)
    expect(existsSync(join(home, '.maestro-run.lock'))).toBe(false)
  })

  it('serializes realpath aliases of the same home rather than failing a second local run', async () => {
    const home = fixture()
    const alias = join(fixture(), 'alias')
    symlinkSync(home, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const started = deferred<FakeChild>()
    const waiting = deferred<void>()
    const first = run(home, spawn(child => { started.resolve(child) }).spawnFn)
    const child = await started.promise
    const secondSpawn = spawn(child => { child.finish(frames('alias-session')) })
    const second = run(alias, secondSpawn.spawnFn, {
      onEvent: (_kind, text) => { if (text.includes('等待上一轮')) waiting.resolve() },
    })
    await waiting.promise
    expect(secondSpawn.launches).toHaveLength(0)
    child.finish(frames('first-session'))
    expect((await first).ok).toBe(true)
    expect((await second).sessionId).toBe('alias-session')
  })

  it('pins a relative home to the canonical directory for a real child with a different cwd', async () => {
    // Keep this fixture on the workspace volume: Windows path.relative across drives is absolute.
    const root = mkdtempSync(join(process.cwd(), 'maestro-grok-relative-'))
    roots.push(root)
    const home = join(root, 'home')
    const taskCwd = join(root, 'different-cwd')
    mkdirSync(home); mkdirSync(taskCwd)
    const relativeHome = relative(process.cwd(), home)
    expect(isAbsolute(relativeHome)).toBe(false)
    const program = `const fs=require('node:fs'),path=require('node:path');process.stdin.resume();process.stdin.on('end',()=>{const home=process.env.GROK_HOME;const config=fs.readFileSync(path.join(home,'config.toml'),'utf8');const result=JSON.stringify({home,cwd:process.cwd(),hasOwnConfig:config.includes('[mcp_servers.relative]')});process.stdout.write(JSON.stringify({type:'result',session_id:'relative-session',result,is_error:false})+String.fromCharCode(10))})`
    const spawnFn: SpawnFn = (_file, _args, options) => nodeSpawn(process.execPath, ['-e', program], options)
    const result = await run(relativeHome, spawnFn, { cwd: taskCwd, timeoutMs: 15000, mcpServers: [server('relative')] })
    expect(result.ok).toBe(true)
    expect(result.sessionId).toBe('relative-session')
    expect(JSON.parse(result.finalText)).toEqual({
      home: realpathSync(home), cwd: realpathSync(taskCwd), hasOwnConfig: true,
    })
    expect(existsSync(join(home, '.maestro-run.lock'))).toBe(false)
  }, 20000)

  it('does not follow a queued alias redirected away from the acquired canonical home', async () => {
    const home = fixture()
    const redirectedHome = fixture()
    const alias = join(fixture(), 'alias')
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(home, alias, linkType)
    writeFileSync(join(redirectedHome, 'config.toml'), 'untouched redirected configuration')
    const started = deferred<FakeChild>()
    const waiting = deferred<void>()
    const first = run(home, spawn(child => { started.resolve(child) }).spawnFn)
    const child = await started.promise
    const secondSpawn = spawn(child => { child.finish(frames('pinned-alias-session')) })
    const second = run(alias, secondSpawn.spawnFn, {
      mcpServers: [server('pinned')],
      onEvent: (_kind, text) => { if (text.includes('等待上一轮')) waiting.resolve() },
    })
    await waiting.promise
    if (process.platform === 'win32') rmdirSync(alias)
    else unlinkSync(alias)
    symlinkSync(redirectedHome, alias, linkType)
    expect(realpathSync(alias)).toBe(realpathSync(redirectedHome))
    child.finish(frames('first'))
    expect((await first).ok).toBe(true)
    expect((await second).sessionId).toBe('pinned-alias-session')
    expect(secondSpawn.launches[0]!.env()?.['GROK_HOME']).toBe(realpathSync(home))
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain('[mcp_servers.pinned]')
    expect(readFileSync(join(redirectedHome, 'config.toml'), 'utf8')).toBe('untouched redirected configuration')
    expect(existsSync(join(home, '.maestro-run.lock'))).toBe(false)
  })

  it('allows different homes to run concurrently', async () => {
    const homeA = fixture()
    const homeB = fixture()
    const startedA = deferred<FakeChild>()
    const startedB = deferred<FakeChild>()
    const first = run(homeA, spawn(child => { startedA.resolve(child) }).spawnFn, { mcpServers: [server('A')] })
    const second = run(homeB, spawn(child => { startedB.resolve(child) }).spawnFn, { mcpServers: [server('B')] })
    const [a, b] = await Promise.all([startedA.promise, startedB.promise])
    expect(readFileSync(join(homeA, 'config.toml'), 'utf8')).toContain('[mcp_servers.A]')
    expect(readFileSync(join(homeB, 'config.toml'), 'utf8')).toContain('[mcp_servers.B]')
    a.finish(frames('A')); b.finish(frames('B'))
    expect((await Promise.all([first, second])).every(result => result.ok)).toBe(true)
  })

  it('cancels a queued run without writing its config or preventing the next waiter', async () => {
    const home = fixture()
    const started = deferred<FakeChild>()
    const waiting = deferred<void>()
    const first = run(home, spawn(child => { started.resolve(child) }).spawnFn, { mcpServers: [server('first')] })
    const child = await started.promise
    const original = readFileSync(join(home, 'config.toml'), 'utf8')
    const controller = new AbortController()
    const cancelledSpawn = spawn(child => { child.finish(frames('must-not-start')) })
    const cancelled = run(home, cancelledSpawn.spawnFn, {
      signal: controller.signal, mcpServers: [server('cancelled')],
      onEvent: (_kind, text) => { if (text.includes('等待上一轮')) waiting.resolve() },
    })
    await waiting.promise
    const reason = new Error('cancel queued fixture')
    controller.abort(reason)
    await expect(cancelled).rejects.toBe(reason)
    expect(cancelledSpawn.launches).toHaveLength(0)
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(original)
    const third = run(home, spawn(child => { child.finish(frames('third')) }).spawnFn)
    child.finish(frames('first'))
    expect((await first).ok).toBe(true)
    expect((await third).sessionId).toBe('third')
    expect(existsSync(join(home, '.maestro-run.lock'))).toBe(false)
  })

  it('does not create a home for an already-aborted request', async () => {
    const home = join(fixture(), 'not-created')
    const controller = new AbortController()
    const reason = new Error('already cancelled')
    controller.abort(reason)
    const script = spawn(child => { child.finish(frames('never')) })
    await expect(run(home, script.spawnFn, { signal: controller.signal })).rejects.toBe(reason)
    expect(script.launches).toHaveLength(0)
    expect(existsSync(home)).toBe(false)
  })

  it('rejects a competing host lease without rewriting config or deleting an unknown lease', async () => {
    const home = fixture()
    const lock = join(home, '.maestro-run.lock')
    const payload = JSON.stringify({ pid: 123, token: 'another-host-fixture' })
    writeFileSync(lock, payload)
    writeFileSync(join(home, 'config.toml'), 'previous configuration')
    const script = spawn(child => { child.finish(frames('never')) })
    await expect(run(home, script.spawnFn)).rejects.toThrow('已有运行租约')
    expect(script.launches).toHaveLength(0)
    expect(readFileSync(lock, 'utf8')).toBe(payload)
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('previous configuration')
    unlinkSync(lock)
    expect((await run(home, spawn(child => { child.finish(frames('after-unlock')) }).spawnFn)).ok).toBe(true)
  })

  it('releases the lease after a synchronous launch failure and preserves resume arguments', async () => {
    const home = fixture()
    const error = new Error('fixture launch failed')
    await expect(run(home, () => { throw error })).rejects.toBe(error)
    expect(existsSync(join(home, '.maestro-run.lock'))).toBe(false)
    const resumed = spawn(child => { child.finish(frames('resumed')) })
    const result = await run(home, resumed.spawnFn, { resume: 'existing-session' })
    expect(result.sessionId).toBe('resumed')
    const args = resumed.launches[0]!.spawnArgs
    expect(args.slice(args.indexOf('-r'), args.indexOf('-r') + 2)).toEqual(['-r', 'existing-session'])
  })

  it('releases the lease after configuration preparation fails, without launching', async () => {
    const home = fixture()
    mkdirSync(join(home, 'config.toml'))
    const script = spawn(child => { child.finish(frames('never')) })
    await expect(run(home, script.spawnFn)).rejects.toThrow()
    expect(script.launches).toHaveLength(0)
    expect(existsSync(join(home, '.maestro-run.lock'))).toBe(false)
  })

  it('releases the lease after idle timeout', async () => {
    const home = fixture()
    const result = await run(home, spawn(() => {}).spawnFn, { timeoutMs: 30 })
    expect(result.ok).toBe(false)
    expect(result.stats.timedOut).toBe(true)
    expect(existsSync(join(home, '.maestro-run.lock'))).toBe(false)
    expect((await run(home, spawn(child => { child.finish(frames('after-timeout')) }).spawnFn)).ok).toBe(true)
  })

  it('keeps a replaced lease intact and does not erase an otherwise completed result', async () => {
    const home = fixture()
    const started = deferred<FakeChild>()
    const notes: string[] = []
    const task = run(home, spawn(child => { started.resolve(child) }).spawnFn, {
      onEvent: (_kind, text) => { notes.push(text) },
    })
    const child = await started.promise
    writeFileSync(join(home, '.maestro-run.lock'), 'unknown replacement')
    child.finish(frames('completed'))
    expect((await task).sessionId).toBe('completed')
    expect(readFileSync(join(home, '.maestro-run.lock'), 'utf8')).toBe('unknown replacement')
    expect(notes.some(note => note.includes('租约未能清理'))).toBe(true)
  })
})
