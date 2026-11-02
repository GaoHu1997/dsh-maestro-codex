/**
 * Simulation tests: the full dispatch ↔ shim ↔ routes ↔ bridge loop without
 * dsh or a model. A fake claude child acts as a REAL MCP client — it parses the
 * actual `--mcp-config` temp file, spawns the actual shim process (compiled on
 * the fly by esbuild), performs the stdio handshake, calls skill and host tools
 * over real HTTP into the real route handlers, and reports what it saw back
 * through a claude result frame. Retry token rotation and the claude native
 * staging path are simulated end to end as well.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import esbuild from 'esbuild'
import { effectiveOf, type EffectiveConfig } from '../src/config.js'
import { createBridgeHandle, type BridgeHandle } from '../src/bridge.js'
import { runDispatch } from '../src/dispatch.js'
import { CliPathCache } from '../src/dispatch.js'
import { bridgeCallRequestBody, bridgeCatalogRequestQuery, handleBridgeCall, handleBridgeCatalog } from '../src/routes.js'
import { BRIDGE_ACCESS_HEADER, ROUTE_BRIDGE_CATALOG } from '../src/wire.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { scriptedSpawn, type ScriptedSpawn } from './fake-child.js'
import { resolveTestDshModel, withTestDshRoutes } from './dsh-route-fixture.js'

const SKILLS = [
  { name: 'release-notes', description: '撰写发布说明', whenToUse: '需要写 release notes 时', tool: 'skill_release-notes' },
  { name: 'pdf-export', description: '导出 PDF', whenToUse: undefined, tool: 'skill_pdf-export' },
]
const SKILL_BODIES: Record<string, string> = {
  'release-notes': '# 发布说明流程\n1. 收集变更\n2. 分拣类型',
  'pdf-export': '# 导出步骤',
}
const TOOLS = [{ name: 'web_search', description: '搜索网络', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }]

function skillsFace() {
  return {
    list: async () => SKILLS.map(skill => ({ ...skill, invocation: { modelInvocable: true, userInvocable: true }, source: 'filesystem', provider: 'filesystem', rank: 100 })),
    get: async (name: string) => SKILL_BODIES[name] === undefined ? undefined : {
      name,
      description: SKILLS.find(skill => skill.name === name)?.description ?? '',
      content: SKILL_BODIES[name],
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'filesystem',
      provider: 'filesystem',
    },
  }
}

function toolsFace() {
  return {
    schemas: () => TOOLS,
    execute: async (exec: { name: string; arguments: Record<string, unknown> }) => ({
      content: [{ type: 'text', text: `搜索结果：${String(exec.arguments['query'])}` }],
      isError: false,
    }),
  }
}

/** Compile the shim TS to a real JS entry once for the whole suite. */
let shimPath = ''
let stagingRoot = ''

beforeAll(async () => {
  stagingRoot = await mkdtemp(join(tmpdir(), 'dsh-maestro-sim-'))
  const outfile = join(stagingRoot, 'bridge-shim.js')
  await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/bridge-shim.ts', import.meta.url))],
    outfile,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    bundle: true,
    sourcemap: false,
    logLevel: 'silent',
  })
  shimPath = outfile
})

afterAll(async () => {
  await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
})

/** A real HTTP surface delegating to the real route handlers and one bridge handle. */
async function startSurface(bridge: BridgeHandle): Promise<number> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const send = (outcome: { status: number; body: unknown }): void => {
      res.writeHead(outcome.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(outcome.body))
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const body: unknown = raw === '' ? {} : JSON.parse(raw)
        if (url.pathname === ROUTE_BRIDGE_CATALOG) {
          send(await handleBridgeCatalog({ bridge } as never, bridgeCatalogRequestQuery(url.searchParams, req.headers[BRIDGE_ACCESS_HEADER])))
          return
        }
        send(await handleBridgeCall({ bridge } as never, bridgeCallRequestBody(body, req.headers[BRIDGE_ACCESS_HEADER])))
      })().catch(error => send({ status: 500, body: { error: error instanceof Error ? error.message : String(error) } }))
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => resolve()) })
  return (server.address() as AddressInfo).port
}

function fixtureConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  // injectGitContext off: gitContextFor shares the fake spawnFn and would otherwise
  // collide with the scripted CLI child (a git probe is not a claude run).
  return { ...withTestDshRoutes(effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath, injectGitContext: false })), ...overrides }
}

function makeDeps(config: EffectiveConfig, spawnFn: ReturnType<ScriptedSpawn>['spawnFn'], bridge: BridgeHandle) {
  const registry = new TaskRegistry()
  return {
    deps: {
      readConfig: () => config,
      registry,
      limiter: new Limiter(() => config.maxConcurrentTasks),
      controllers: new Map<string, AbortController>(),
      pathCache: new CliPathCache(() => config, spawnFn),
      resolveDshModel: resolveTestDshModel,
      spawnFn,
      bridge,
    },
    registry,
  }
}

const assessment = { taskDifficulty: 'medium', difficultyReason: '仿真：多步任务，需要技能与工具协作' } as const

/**
 * The fake claude child's MCP-client routine: read the mcp-config temp file,
 * spawn the shim exactly as claude would (command/args/env from the file),
 * handshake, list tools, call the skill tool and the host tool, and fold every
 * observed fact into the result frame text.
 */
async function mcpClientChild(child: {
  spawnArgs: readonly string[]
  finish: (stdout: string, code?: number, stderr?: string) => void
}): Promise<void> {
  try {
    const configIndex = child.spawnArgs.indexOf('--mcp-config')
    const configPath = configIndex === -1 ? undefined : child.spawnArgs[configIndex + 1]
    if (configPath === undefined) {
      child.finish(JSON.stringify({ type: 'result', subtype: 'success', result: 'NO-MCP-CONFIG', is_error: false }), 0)
      return
    }
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> }
    const entry = config.mcpServers['dsh_bridge']
    if (entry === undefined) {
      child.finish(JSON.stringify({ type: 'result', subtype: 'success', result: 'NO-BRIDGE-ENTRY', is_error: false }), 0)
      return
    }
    const { spawn } = await import('node:child_process')
    const shim = spawn(entry.command, entry.args, {
      env: { ...process.env, ...entry.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const seen: { tools?: string[]; skillText?: string; toolText?: string; error?: string } = {}
    const pending = new Map<number, (value: unknown) => void>()
    let buffer = ''
    shim.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let index: number
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line === '') continue
        const reply = JSON.parse(line) as { id: number; result?: unknown; error?: { message?: string } }
        pending.get(reply.id)?.(reply)
        pending.delete(reply.id)
      }
    })
    let stderrTail = ''
    shim.stderr.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-400) })
    const request = (id: number, method: string, params?: Record<string, unknown>): Promise<unknown> => {
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve({ error: { message: `TIMEOUT:${method}:${stderrTail}` } })
        }, 8000)
        pending.set(id, value => { clearTimeout(timer); resolve(value) })
        shim.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`)
      })
    }
    const replyText = (reply: unknown): string => {
      const record = typeof reply === 'object' && reply !== null ? reply as Record<string, unknown> : {}
      if (record['error'] !== undefined) return `ERR:${JSON.stringify(record['error']).slice(0, 200)}`
      return JSON.stringify(record['result'] ?? {}).slice(0, 200)
    }
    const init = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sim-claude', version: '0' } }) as { result?: { serverInfo?: { name?: string } }; error?: { message?: string } }
    shim.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const listed = await request(2, 'tools/list') as { result?: { tools?: Array<{ name: string }> }; error?: { message?: string } }
    seen.tools = listed.result?.tools?.map(tool => tool.name) ?? [`ERR:${listed.error?.message ?? replyText(listed)}`]
    const skillCall = await request(3, 'tools/call', { name: 'skill_release-notes', arguments: {} }) as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } }
    seen.skillText = skillCall.result?.content?.[0]?.text ?? `ERR:${skillCall.error?.message ?? replyText(skillCall)}`
    const toolCall = await request(4, 'tools/call', { name: 'web_search', arguments: { query: 'dsh-bridge' } }) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } }
    seen.toolText = toolCall.result?.content?.[0]?.text ?? `ERR:${toolCall.error?.message ?? replyText(toolCall)}`
    const unknownCall = await request(5, 'tools/call', { name: 'skill_not-there', arguments: {} }) as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } }
    seen.error = unknownCall.result?.isError === true ? unknownCall.result?.content?.[0]?.text : undefined
    const fact = [
      `HANDSHAKE=${init.result?.serverInfo?.name ?? `ERR:${init.error?.message ?? replyText(init)}`}`,
      `TOOLS=${seen.tools?.join(',')}`,
      `SKILL=${seen.skillText?.includes('发布说明流程') === true ? 'ok' : seen.skillText}`,
      `TOOL=${seen.toolText ?? 'none'}`,
      `UNKNOWN=${seen.error?.includes('没有工具') === true ? 'rejected' : seen.error ?? 'allowed'}`,
    ].join(' ')
    shim.stdin.end()
    child.finish([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sim-1' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: fact, is_error: false, num_turns: 1 }),
    ].join('\n'))
  } catch (error) {
    child.finish(JSON.stringify({ type: 'result', subtype: 'success', result: `SIM-ERROR: ${error instanceof Error ? error.message : String(error)}`, is_error: false }), 0)
  }
}

describe('bridge simulation: dispatch → fake claude (MCP client) → real shim → real routes', () => {
  it('runs the full loop and brings the skill body and tool output back', { timeout: 30_000 }, async () => {
    let port = 0
    const bridge = createBridgeHandle({
      skills: skillsFace,
      tools: toolsFace,
      portOf: () => port,
      shimPath: () => shimPath,
      readConfig: () => effectiveOf({ bridgeSkills: true, bridgeTools: 'custom', bridgeToolAllowlist: ['web_search'] }),
    })
    port = await startSurface(bridge)
    const spawn = scriptedSpawn(child => {
      if (child.spawnArgs[0] === '--version') {
        child.finish('claude version 9.9.9 (sim)')
        return
      }
      void mcpClientChild(child)
    })
    const { deps } = makeDeps(fixtureConfig(), spawn.spawnFn, bridge)
    const value = await runDispatch(deps, { ...assessment, cli: 'claude', task: '写发布说明并联网核对' }, new AbortController().signal)
    expect(value.ok).toBe(true)
    expect(value.finalText).toContain('HANDSHAKE=dsh_bridge')
    expect(value.finalText).toContain('TOOLS=skill_pdf-export,skill_release-notes')
    expect(value.finalText).toContain('SKILL=ok')
    expect(value.finalText).toContain('TOOL=Error: 工具 web_search 不存在或目录命名冲突')
    expect(value.finalText).toContain('UNKNOWN=Error: 工具 skill_not-there 不存在或目录命名冲突')
    // The task text carried the catalog envelope.
    const child = spawn.launches.at(-1)
    expect(child?.stdinText).toContain('<available_skills>')
    expect(child?.stdinText).toContain('skill_release-notes')
  })

  it('rotates the bridge token across retries and retires both', { timeout: 30_000 }, async () => {
    let port = 0
    const bridge = createBridgeHandle({
      skills: skillsFace,
      tools: () => ({ schemas: () => [], execute: async () => ({ content: [], isError: false }) }),
      portOf: () => port,
      shimPath: () => shimPath,
      readConfig: () => effectiveOf({ bridgeSkills: true, bridgeTools: 'off' }),
    })
    port = await startSurface(bridge)
    const seenTokens: string[] = []
    let launches = 0
    const spawn = scriptedSpawn(child => {
      if (child.spawnArgs[0] === '--version') {
        child.finish('claude version 9.9.9 (sim)')
        return
      }
      launches += 1
      const current = launches
      void (async () => {
        const configIndex = child.spawnArgs.indexOf('--mcp-config')
        const configPath = child.spawnArgs[configIndex + 1] ?? ''
        const config = JSON.parse(readFileSync(configPath, 'utf8')) as { mcpServers: Record<string, { env: Record<string, string> }> }
        seenTokens.push(config.mcpServers['dsh_bridge']?.env['MAESTRO_BRIDGE_TOKEN'] ?? '')
        if (current === 1) {
          // First attempt fails plainly → the runner retries (failureRetries: 1).
          child.finish([
            JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sim-1' }),
            JSON.stringify({ type: 'result', subtype: 'error', result: '第一次失败', is_error: true }),
          ].join('\n'), 1)
          return
        }
        child.finish([
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sim-1' }),
          JSON.stringify({ type: 'result', subtype: 'success', result: '重试成功', is_error: false }),
        ].join('\n'))
      })().catch(error => { seenTokens.push('ERR:' + (error instanceof Error ? error.message : String(error))); child.finish('', 1, 'sim failure') })
    })
    const { deps } = makeDeps(fixtureConfig({ failureRetries: 1 }), spawn.spawnFn, bridge)
    const value = await runDispatch(deps, { ...assessment, cli: 'claude', task: '重试仿真' }, new AbortController().signal)
    expect(value.ok).toBe(true)
    expect(seenTokens).toHaveLength(2)
    expect(seenTokens[0]).not.toBe(seenTokens[1])
    expect(seenTokens.every(token => /^mb-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token))).toBe(true)
    // Both per-attempt tokens are dead after the run settles.
    for (const token of seenTokens) {
      expect(await bridge.catalog(token, '/cwd')).toMatchObject({ status: 401 })
    }
  })

  it('simulates the claude native path: staged dir is real during the run, gone after', { timeout: 30_000 }, async () => {
    const bridge = createBridgeHandle({
      skills: skillsFace,
      tools: () => ({ schemas: () => [], execute: async () => ({ content: [], isError: false }) }),
      portOf: () => 0, // no HTTP surface: native staging must work without one
      shimPath: () => shimPath,
      readConfig: () => effectiveOf({ bridgeSkills: true, bridgeTools: 'off', claudeSkillsMode: 'native' }),
    })
    let stagedDirSeen: string | undefined
    const spawn = scriptedSpawn(child => {
      if (child.spawnArgs[0] === '--version') {
        child.finish('claude version 9.9.9 (sim)')
        return
      }
      void (async () => {
        const addIndex = child.spawnArgs.indexOf('--add-dir')
        const dir = addIndex === -1 ? '' : child.spawnArgs[addIndex + 1] ?? ''
        stagedDirSeen = dir
        let markdown = ''
        try { markdown = dir === '' ? '' : readFileSync(join(dir, '.claude', 'skills', 'release-notes', 'SKILL.md'), 'utf8') } catch { markdown = 'MISSING' }
        const mcpIndex = child.spawnArgs.indexOf('--mcp-config')
        child.finish([
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sim-1' }),
          JSON.stringify({ type: 'result', subtype: 'success', result: `NATIVE dir=${dir !== ''} skill=${markdown.includes('发布说明流程') ? 'ok' : 'missing'} mcp=${mcpIndex === -1 ? 'none' : 'mounted'}`, is_error: false }),
        ].join('\n'))
      })().catch(() => child.finish('', 1, 'sim failure'))
    })
    const { deps } = makeDeps(fixtureConfig({ claudeSkillsMode: 'native', failureRetries: 0 }), spawn.spawnFn, bridge)
    const value = await runDispatch(deps, { ...assessment, cli: 'claude', task: '原生技能仿真' }, new AbortController().signal)
    expect(value.ok).toBe(true)
    expect(value.finalText).toContain('NATIVE dir=true')
    expect(value.finalText).toContain('skill=ok')
    // With zero bridgable tools and skills off the bridge, no dsh_bridge mounts.
    expect(value.finalText).toContain('mcp=none')
    // The staging tree is real during the run and removed after settle.
    expect(stagedDirSeen).toBeTruthy()
    await expect(readFile(join(stagedDirSeen ?? '', '.claude', 'skills', 'release-notes', 'SKILL.md'))).rejects.toThrow()
  })

  it('keeps the shim protocol honest: compiled entry answers a bare handshake', { timeout: 30_000 }, async () => {
    // Direct node execution of the compiled shim (the exact artifact the CLI
    // children spawn) against a one-message probe.
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [shimPath], { env: { ...process.env, MAESTRO_BRIDGE_URL: 'http://127.0.0.1:1', MAESTRO_BRIDGE_TOKEN: 't' }, stdio: ['pipe', 'pipe', 'pipe'] })
    const reply = await new Promise<string>(resolve => {
      child.stdout.once('data', chunk => resolve(chunk.toString('utf8')))
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`)
    })
    expect(JSON.parse(reply)).toMatchObject({ id: 1, result: { serverInfo: { name: 'dsh_bridge' } } })
    child.kill()
  })
})

