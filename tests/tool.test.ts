/**
 * Contract tests for `dispatch_cli_task`. The tool only exists if
 * `tools.register` accepts it, and that acceptance depends on the output
 * schema staying inside the host's *enforced* JSON Schema subset. A past
 * release wrote per-property `required: true`; `tools.register` threw, the
 * tool never registered, and the system prompt kept advertising it. These
 * tests pin both the schema shape and the registration behaviour.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { CONFIG_DEFAULTS, TASK_DIFFICULTIES, effectiveOf } from '../src/config.js'
import type { DispatchValue } from '../src/dispatch.js'
import { scriptedSpawn } from './fake-child.js'
import { CliPathCache } from '../src/dispatch.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import {
  FALLBACK_TOOL_NAME,
  TOOL_NAME,
  TOOL_OUTPUT_SCHEMA,
  TOOL_PARAMETER_SCHEMA,
  ownerSessionOf,
  parseToolArgs,
  primaryRouteOf,
  registerDispatchTool,
  renderSummary,
  usageSessionOf,
  type MaestroToolDeps,
  type ToolExec,
} from '../src/tool.js'
import { CLI_USAGE_EVENT } from '../src/usage.js'

/**
 * A strict stand-in for dsh-tools' `assertSupportedJsonSchema`: `required` is a
 * string array on object nodes only, every child is checked, unknown keywords
 * are refused. Mirrors the real validator closely enough to fail the legacy
 * shape with the same message.
 */
const SUPPORTED_KEYWORDS = new Set([
  'type', 'properties', 'required', 'items', 'additionalProperties', 'description',
  'enum', 'const', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern',
  'minItems', 'maxItems', 'default', 'title', 'format', 'oneOf', 'anyOf', 'allOf',
])

export function assertSupportedJsonSchema(schema: unknown, at = 'schema'): void {
  if (typeof schema !== 'object' || schema === null) throw new Error(`${at}: schema must be an object`)
  const node = schema as Record<string, unknown>
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(key)) throw new Error(`${at}.${key} is not supported`)
  }
  const type = node['type']
  if ('required' in node) {
    if (type !== 'object') throw new Error(`${at}.required is not supported on type "${String(type)}"`)
    const required = node['required']
    if (!Array.isArray(required) || required.some(entry => typeof entry !== 'string')) {
      throw new Error(`${at}.required must be an array of strings`)
    }
  }
  if (type === 'object') {
    const properties = node['properties']
    if (typeof properties !== 'object' || properties === null) throw new Error(`${at}: object type requires properties`)
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      assertSupportedJsonSchema(child, `${at}.properties.${name}`)
    }
  }
  if (type === 'array') {
    if (node['items'] === undefined) throw new Error(`${at}: array type requires items`)
    assertSupportedJsonSchema(node['items'], `${at}.items`)
  }
}

function deps(overrides: Partial<MaestroToolDeps> = {}): MaestroToolDeps {
  const readConfig = () => effectiveOf({})
  return {
    readConfig,
    registry: new TaskRegistry(),
    limiter: new Limiter(() => 2),
    controllers: new Map(),
    pathCache: new CliPathCache(readConfig),
    ...overrides,
  }
}

function fakeCtx(register: (definition: unknown) => unknown): Context {
  return { tools: { register } } as unknown as Context
}

interface RegisteredTool {
  description: string
  execute(rawArgs: unknown, exec: ToolExec): Promise<DispatchValue>
}

function registeredTool(toolDeps: MaestroToolDeps): RegisteredTool {
  const definitions: RegisteredTool[] = []
  registerDispatchTool(fakeCtx(definition => {
    definitions.push(definition as RegisteredTool)
    return () => {}
  }), toolDeps)
  const definition = definitions[0]
  if (definition === undefined) throw new Error('tool was not registered')
  return definition
}

describe('tool schemas', () => {
  it('the output schema passes the host-subset validator', () => {
    expect(() => assertSupportedJsonSchema(TOOL_OUTPUT_SCHEMA, 'schema')).not.toThrow()
  })

  it('the parameter schema is a model-facing object schema', () => {
    expect(TOOL_PARAMETER_SCHEMA.type).toBe('object')
    expect(TOOL_PARAMETER_SCHEMA.required).toEqual(['task', 'task_difficulty', 'difficulty_reason'])
    expect(TOOL_PARAMETER_SCHEMA.properties.task_difficulty.enum).toEqual(TASK_DIFFICULTIES)
    expect(TOOL_PARAMETER_SCHEMA.properties.difficulty_reason.type).toBe('string')
    expect(() => assertSupportedJsonSchema(TOOL_PARAMETER_SCHEMA, 'schema')).not.toThrow()
  })

  it('rejects the legacy per-property `required: true` form', () => {
    const legacy = { type: 'object', properties: { ok: { type: 'boolean', required: true } } }
    expect(() => assertSupportedJsonSchema(legacy, 'schema'))
      .toThrow('schema.properties.ok.required is not supported on type "boolean"')
  })

  it('rejects a property-map-shaped parameter definition', () => {
    const legacy = { task: { type: 'string', required: true, description: 'x' } }
    // A DSL property map has no root `type: 'object'`, so it is not a schema at all.
    expect(() => assertSupportedJsonSchema(legacy, 'schema')).toThrow(/schema\.task/)
  })
})

describe('registerDispatchTool', () => {
  it('registers under the canonical name with a validating schema', () => {
    const definitions: Array<{ name: string; parameters: unknown; output: { schema: unknown } }> = []
    const ctx = fakeCtx((definition) => {
      definitions.push(definition as (typeof definitions)[number])
      return () => {}
    })
    const registered = registerDispatchTool(ctx, deps())
    expect(registered.name).toBe(TOOL_NAME)
    expect(definitions).toHaveLength(1)
    const definition = definitions[0]
    expect(definition?.name).toBe('dispatch_cli_task')
    expect(() => assertSupportedJsonSchema(definition?.output.schema, 'schema')).not.toThrow()
    expect(() => assertSupportedJsonSchema(definition?.parameters, 'parameters')).not.toThrow()
  })

  it('falls back to the alternate name when the canonical one is taken', () => {
    let calls = 0
    const ctx = fakeCtx(() => {
      calls += 1
      if (calls === 1) throw new Error(`tool "${TOOL_NAME}" is already registered`)
      return () => {}
    })
    const warnings: string[] = []
    const registered = registerDispatchTool(ctx, deps({ logger: { warn: (message) => warnings.push(message) } }))
    expect(registered.name).toBe(FALLBACK_TOOL_NAME)
    expect(warnings.join(' ')).toContain(FALLBACK_TOOL_NAME)
  })

  it('does not swallow a schema rejection as a name collision', () => {
    const ctx = fakeCtx(() => {
      throw new Error('unsupported JSON schema: schema.properties.ok.required is not supported on type "boolean"')
    })
    expect(() => registerDispatchTool(ctx, deps())).toThrow(/unsupported JSON schema/)
  })

  it('disposes the registration it owns', () => {
    let disposed = 0
    const ctx = fakeCtx(() => () => { disposed += 1 })
    const registered = registerDispatchTool(ctx, deps())
    registered.dispose()
    expect(disposed).toBe(1)
  })
})

describe('registered tool difficulty gate', () => {
  it('describes semantic assessment rather than encouraging keyword-triggered quick fixes', () => {
    const description = registeredTool(deps()).description
    expect(description).toContain('实际选定 CLI 独立最低难度')
    expect(description).toContain('先评估真实难度')
    expect(description).toContain('再检查该 CLI')
    expect(description).toContain('禁止改选门槛更低')
    expect(TOOL_PARAMETER_SCHEMA.properties.cli.description).toContain('实际选定 CLI 的独立最低难度')
    expect(TOOL_PARAMETER_SCHEMA.properties.cli.description).not.toContain('达到配置门槛后选择 CLI')
    expect(description).toContain('task_difficulty')
    expect(description).toContain('difficulty_reason')
    expect(description).toContain('小范围编辑 low')
    expect(description).toContain('用户点名均不能绕过')
    expect(description).not.toContain('快速修复给 codex')
  })

  it.each(['auto', 'claude', 'codex'])('blocks low %s before detection or records', async cli => {
    const child = scriptedSpawn(process => process.finish('不应该执行'))
    const toolDeps = deps({ spawnFn: child.spawnFn })
    const path = vi.spyOn(toolDeps.pathCache, 'pathOf')
    const tool = registeredTool(toolDeps)
    await expect(tool.execute({ task: '简单编辑', cli, task_difficulty: 'low', difficulty_reason: '仅修改一个说明' }, { signal: new AbortController().signal }))
      .rejects.toThrow(/低于最低难度/)
    expect(path).not.toHaveBeenCalled()
    expect(child.launches).toEqual([])
    expect(toolDeps.registry.list()).toEqual([])
    expect(toolDeps.controllers.size).toBe(0)
  })

  it('does not invent a high assessment for legacy calls with high keywords', async () => {
    const toolDeps = deps()
    const path = vi.spyOn(toolDeps.pathCache, 'pathOf')
    await expect(registeredTool(toolDeps).execute({ task: '系统级重构项目测试', cli: 'codex' }, { signal: new AbortController().signal }))
      .rejects.toThrow(/未提供难度评估.*保守按低/)
    expect(path).not.toHaveBeenCalled()
    expect(toolDeps.registry.list()).toEqual([])
  })

  it('rejects a high rank without rationale before running', async () => {
    const toolDeps = deps()
    const path = vi.spyOn(toolDeps.pathCache, 'pathOf')
    await expect(registeredTool(toolDeps).execute({ task: 'x', cli: 'claude', task_difficulty: 'high' }, { signal: new AbortController().signal }))
      .rejects.toThrow(/difficulty_reason/)
    expect(path).not.toHaveBeenCalled()
    expect(toolDeps.registry.list()).toEqual([])
  })

  it('allows equality and reads independent live volatile config after tool registration', async () => {
    let claude = 'medium'
    let codex = 'high'
    const live = {
      claudeMinTaskDifficulty: { get: () => claude }, codexMinTaskDifficulty: { get: () => codex },
      claudeCliPath: process.execPath, codexCliPath: process.execPath,
    } as unknown as Parameters<typeof effectiveOf>[0]
    const readConfig = () => effectiveOf(live)
    const child = scriptedSpawn(process => {
      if (process.spawnArgs[0] === '--version') process.finish('cli version 9.9.9')
      else if (process.spawnArgs[0] === 'exec') process.finish([
        JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex 完成' } }),
        JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 7 } }),
      ].join('\n'))
      else process.finish(JSON.stringify({ type: 'result', subtype: 'success', result: '完成', is_error: false, num_turns: 1 }))
    })
    const toolDeps = deps({ readConfig, spawnFn: child.spawnFn, pathCache: new CliPathCache(readConfig, child.spawnFn) })
    const tool = registeredTool(toolDeps)
    const args = { task: '多步任务', cli: 'claude', task_difficulty: 'medium', difficulty_reason: '需要实现、测试与回归验证' }
    expect((await tool.execute(args, { signal: new AbortController().signal })).ok).toBe(true)
    let launches = child.launches.length
    await expect(tool.execute({ ...args, cli: 'codex' }, { signal: new AbortController().signal })).rejects.toThrow(/最低难度 高.*codex/)
    expect(child.launches).toHaveLength(launches)
    claude = 'high'
    codex = 'medium'
    expect((await tool.execute({ ...args, cli: 'codex' }, { signal: new AbortController().signal })).cli).toBe('codex')
    launches = child.launches.length
    await expect(tool.execute(args, { signal: new AbortController().signal })).rejects.toThrow(/最低难度 高.*claude/)
    expect(child.launches).toHaveLength(launches)
    expect(toolDeps.registry.list()).toHaveLength(2)
  })

  it.each([
    { requested: 'auto', task: '重构', disabled: undefined },
    { requested: 'auto', task: '无关键词', disabled: undefined },
    { requested: 'claude', task: '项目测试', disabled: undefined },
    { requested: 'codex', task: '项目测试', disabled: 'codex' },
  ] as const)('never reroutes rejected $requested with disabled=$disabled to a lower-threshold CLI', async scenario => {
    const config = effectiveOf({ claudeMinTaskDifficulty: 'extreme', codexMinTaskDifficulty: 'low' })
    if (scenario.disabled !== undefined) config[scenario.disabled].enabled = false
    const child = scriptedSpawn(process => process.finish('不应启动'))
    const toolDeps = deps({ readConfig: () => config, spawnFn: child.spawnFn })
    const path = vi.spyOn(toolDeps.pathCache, 'pathOf')
    const acquire = vi.spyOn(toolDeps.limiter, 'acquire')
    const create = vi.spyOn(toolDeps.registry, 'create')
    await expect(registeredTool(toolDeps).execute(
      { task: scenario.task, cli: scenario.requested, task_difficulty: 'high', difficulty_reason: '跨模块协作但未达到系统级迁移难度' },
      { signal: new AbortController().signal },
    )).rejects.toThrow(/最低难度 极高（extreme）（实际 CLI：claude）/)
    expect(path).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(child.launches).toEqual([])
    expect(toolDeps.controllers.size).toBe(0)
  })
})

describe('parseToolArgs', () => {
  it.each(TASK_DIFFICULTIES)('maps %s and its trimmed semantic reason to shared dispatch fields', difficulty => {
    expect(parseToolArgs({ task: 'do it', task_difficulty: difficulty, difficulty_reason: '  多步实现并验证  ' }))
      .toEqual({ cli: 'auto', task: 'do it', taskDifficulty: difficulty, difficultyReason: '多步实现并验证' })
  })

  it.each([
    { task_difficulty: 'high' },
    { task_difficulty: 'high', difficulty_reason: ' ' },
    { task_difficulty: 'high', difficulty_reason: 7 },
    { task_difficulty: 'HIGH', difficulty_reason: 'x' },
    { difficulty_reason: 'x' },
  ])('rejects an invalid declared assessment %j', fields => {
    expect(parseToolArgs({ task: 'x', ...fields })).toEqual(expect.any(String))
  })

  it('accepts a minimal task and defaults the CLI to auto', () => {
    expect(parseToolArgs({ task: 'do it' })).toEqual({ cli: 'auto', task: 'do it' })
  })

  it('rejects an empty task', () => {
    expect(parseToolArgs({ task: '  ' })).toMatch(/"task" 不能为空/)
  })

  it('rejects a relative cwd', () => {
    expect(parseToolArgs({ task: 'x', cwd: 'relative/path' })).toMatch(/cwd/)
  })
})

describe('primaryRouteOf / ownerSessionOf', () => {
  const signal = new AbortController().signal

  it('prefers the routed request header over the configured options', () => {
    expect(primaryRouteOf({
      signal,
      agent: {
        options: { provider: 'p', model: 'm' },
        session: { requestHeader: () => ({ config: { provider: 'routed', model: 'routed-m' } }) },
      },
    })).toEqual({ provider: 'routed', model: 'routed-m' })
  })

  it('falls back to the agent options and tolerates a missing agent', () => {
    expect(primaryRouteOf({ signal, agent: { options: { provider: 'p', model: 'm' } } }))
      .toEqual({ provider: 'p', model: 'm' })
    // headless/SDK：没有 agent 就没有主代理模型，交给配置页。
    expect(primaryRouteOf({ signal })).toBeUndefined()
    // 不完整的路由不构成选择。
    expect(primaryRouteOf({ signal, agent: { options: { provider: 'p' } } })).toBeUndefined()
  })

  it('survives a throwing requestHeader and reads the owner session id', () => {
    expect(primaryRouteOf({
      signal,
      agent: { options: { provider: 'p', model: 'm' }, session: { requestHeader: () => { throw new Error('no header') } } },
    })).toEqual({ provider: 'p', model: 'm' })
    expect(ownerSessionOf({ signal, agent: { id: 'session-1' } })).toBe('session-1')
    expect(ownerSessionOf({ signal })).toBeUndefined()
    expect(ownerSessionOf({ signal, agent: { id: '' } })).toBeUndefined()
  })
})

describe('usage reporting seam', () => {
  const signal = new AbortController().signal

  it('reads the owning session append handle', () => {
    const session = { append: () => undefined }
    expect(usageSessionOf({ signal, agent: { id: 'session-1', session } })).toBeDefined()
    expect(usageSessionOf({ signal, agent: { id: 'session-1' } })).toBeUndefined()
    expect(usageSessionOf({ signal })).toBeUndefined()
  })

  it('reports the settled run through the tool execution', async () => {
    const readConfig = () => effectiveOf({ claudeCliPath: process.execPath })
    const child = scriptedSpawn(process => {
      if (process.spawnArgs[0] === '--version') process.finish('claude version 9.9.9')
      else process.finish(JSON.stringify({ type: 'result', subtype: 'success', result: '完成', is_error: false, num_turns: 1 }))
    })
    const toolDeps = deps({ readConfig, spawnFn: child.spawnFn, pathCache: new CliPathCache(readConfig, child.spawnFn) })
    const appended: Array<{ type: string; data: unknown }> = []
    const session = { append: (type: string, data: unknown) => { appended.push({ type, data }) } }
    const value = await registeredTool(toolDeps).execute(
      { task: '多步任务', cli: 'claude', task_difficulty: 'medium', difficulty_reason: '需要实现、测试与回归验证' },
      { signal: new AbortController().signal, agent: { id: 'session-1', session } },
    )
    expect(value.ok).toBe(true)
    expect(appended).toHaveLength(1)
    expect(appended[0]?.type).toBe(CLI_USAGE_EVENT)
    expect(appended[0]?.data).toMatchObject({ cli: 'claude', phase: 'done', sessionId: 'session-1' })
  })
})

describe('renderSummary', () => {
  it('never renders an empty body', () => {
    const text = renderSummary({
      ok: true, cli: 'codex', model: '', cwd: 'C:\\x', durationMs: 1_500,
      exitCode: 0, sessionRef: '', finalText: '', notes: [],
    })
    expect(text).toContain('（CLI 未返回文本）')
  })
})
