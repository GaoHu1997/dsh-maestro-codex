import { describe, expect, it, vi } from 'vitest'
import { TASK_DIFFICULTIES, effectiveOf, type EffectiveConfig } from '../src/config.js'
import { CliPathCache, parseDispatchParams, runDispatch, type DispatchParams } from '../src/dispatch.js'
import type { DshModelEndpoint } from '../src/dsh-models.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { CLI_USAGE_EVENT } from '../src/usage.js'
import { scriptedSpawn } from './fake-child.js'

const assessment = {
  taskDifficulty: 'medium',
  difficultyReason: '范围明确的多步任务，需要实现并验证输出和回归行为',
} satisfies Pick<DispatchParams, 'taskDifficulty' | 'difficultyReason'>

function fixture(overrides: Partial<EffectiveConfig> & { minTaskDifficulty?: EffectiveConfig['claude']['minTaskDifficulty'] } = {}): EffectiveConfig {
  const { minTaskDifficulty, ...effectiveOverrides } = overrides
  const base = effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath, ...(minTaskDifficulty === undefined ? {} : { minTaskDifficulty }) })
  return { ...base, ...effectiveOverrides }
}

/** A fake spawn that answers --version and streams a claude/codex transcript. */
function fakeCliSpawn(ok = true): ReturnType<typeof scriptedSpawn> {
  return scriptedSpawn(child => {
    if (child.spawnArgs[0] === '--version') {
      child.finish('claude version 9.9.9 (CCL)')
      return
    }
    if (child.spawnArgs[0] === 'exec') {
      child.finish([
        JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ok ? 'codex 完成' : '' } }),
        JSON.stringify({ type: ok ? 'turn.completed' : 'turn.failed', ...(ok ? { usage: { output_tokens: 7 } } : { error: { message: 'turn 出错' } }) }),
      ].join('\n'))
      return
    }
    child.finish([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: ok ? 'claude 完成' : '', is_error: !ok, num_turns: 1 }),
    ].join('\n'), ok ? 0 : 1)
  })
}

function makeDeps(
  config: EffectiveConfig,
  spawnFn: ReturnType<typeof scriptedSpawn>['spawnFn'],
  resolveDshModel?: (selection: string) => Promise<DshModelEndpoint>,
) {
  const registry = new TaskRegistry()
  const controllers = new Map<string, AbortController>()
  return {
    deps: {
      readConfig: () => config,
      registry,
      limiter: new Limiter(() => config.maxConcurrentTasks),
      controllers,
      pathCache: new CliPathCache(() => config, spawnFn),
      spawnFn,
      ...(resolveDshModel === undefined ? {} : { resolveDshModel }),
    },
    registry,
    controllers,
  }
}

describe('parseDispatchParams', () => {
  it.each(TASK_DIFFICULTIES)('parses the %s assessment and normalizes the reason', difficulty => {
    const parsed = parseDispatchParams({ task: '完整任务', task_difficulty: difficulty, difficulty_reason: '  多步实现并验证依赖风险  ' })
    expect(parsed).toEqual({ cli: 'auto', task: '完整任务', taskDifficulty: difficulty, difficultyReason: '多步实现并验证依赖风险' })
  })

  it.each([
    { task_difficulty: 'high' },
    { task_difficulty: 'high', difficulty_reason: '' },
    { task_difficulty: 'medium', difficulty_reason: '  ' },
    { task_difficulty: 'high', difficulty_reason: false },
    { task_difficulty: 'high', difficulty_reason: null },
    { task_difficulty: 'extreme', difficulty_reason: 'x'.repeat(2_001) },
    { task_difficulty: 'HIGH', difficulty_reason: 'x' },
    { task_difficulty: 'unknown', difficulty_reason: 'x' },
    { task_difficulty: 3, difficulty_reason: 'x' },
    { task_difficulty: null, difficulty_reason: 'x' },
    { difficulty_reason: 'x' },
  ])('rejects invalid assessment fields %j', fields => {
    expect(parseDispatchParams({ task: 'x', ...fields })).toEqual(expect.any(String))
  })

  it('keeps old callers unassessed rather than inferring rank from task keywords', () => {
    expect(parseDispatchParams({ task: '系统级重构项目测试', cli: 'codex' }))
      .toEqual({ cli: 'codex', task: '系统级重构项目测试' })
  })

  it('rejects an empty task', () => {
    expect(parseDispatchParams({})).toContain('不能为空')
  })

  it('rejects a bad cwd', () => {
    expect(parseDispatchParams({ task: 'x', cwd: 'relative/path' })).toContain('绝对路径')
    expect(parseDispatchParams({ task: 'x', cwd: 'D:/definitely/not/a/real/dir-xyz' })).toContain('绝对路径')
  })

  it('accepts a well-formed request', () => {
    const parsed = parseDispatchParams({ task: '写个脚本', cli: 'codex', timeout_minutes: 5 })
    expect(typeof parsed).toBe('object')
    if (typeof parsed !== 'string') {
      expect(parsed.cli).toBe('codex')
      expect(parsed.timeoutMinutes).toBe(5)
    }
  })
})

describe('runDispatch', () => {
  it('runs a claude task end to end and records the trail', async () => {
    const cli = fakeCliSpawn(true)
    const { deps, registry } = makeDeps(fixture(), cli.spawnFn)
    const value = await runDispatch(deps, { ...assessment, cli: 'claude', task: '做个分析' }, new AbortController().signal)
    expect(value.ok).toBe(true)
    expect(value.finalText).toBe('claude 完成')
    expect(value.sessionRef).toBe('s1')
    const record = registry.list()[0]
    expect(record?.phase).toBe('done')
    expect(record?.cli).toBe('claude')
  })

  it('routes codex by keyword with auto', async () => {
    const cli = fakeCliSpawn(true)
    const { deps, registry } = makeDeps(fixture(), cli.spawnFn)
    const value = await runDispatch(deps, { ...assessment, cli: 'auto', task: '生成一个数据处理脚本' }, new AbortController().signal)
    expect(value.cli).toBe('codex')
    expect(value.finalText).toBe('codex 完成')
    expect(registry.list()[0]?.phase).toBe('done')
  })

  it('throws a friendly error when the CLI is not installed', async () => {
    const cli = fakeCliSpawn(true)
    const config = fixture()
    config.claude.cliPath = 'D:/no/such/claude.exe'
    const { deps } = makeDeps(config, cli.spawnFn)
    await expect(runDispatch(deps, { ...assessment, cli: 'claude', task: 'x' }, new AbortController().signal))
      .rejects.toThrow(/未安装或不可用/)
  })

  it('refuses to run when the plugin is disabled', async () => {
    const cli = fakeCliSpawn(true)
    const { deps } = makeDeps(fixture({ enabled: false }), cli.spawnFn)
    await expect(runDispatch(deps, { ...assessment, cli: 'claude', task: 'x' }, new AbortController().signal))
      .rejects.toThrow(/已停用/)
  })

  it('marks a failed run and throws with the CLI error', async () => {
    const cli = fakeCliSpawn(false)
    const { deps, registry } = makeDeps(fixture(), cli.spawnFn)
    await expect(runDispatch(deps, { ...assessment, cli: 'claude', task: 'x' }, new AbortController().signal))
      .rejects.toThrow(/claude 任务失败/)
    expect(registry.list()[0]?.phase).toBe('failed')
  })

  it('cancels through the controllers map: child killed, phase cancelled', async () => {
    // A --version probe answers; the task child itself never finishes.
    const cli = scriptedSpawn(child => {
      if (child.spawnArgs[0] === '--version') child.finish('claude version 1.0')
    })
    const { deps, registry, controllers } = makeDeps(fixture(), cli.spawnFn)
    const outer = new AbortController()
    const runPromise = runDispatch(deps, { ...assessment, cli: 'claude', task: '长任务' }, outer.signal)
    // Wait for the task to be running, then cancel via the registry id map.
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    const record = registry.list()[0]
    expect(record?.phase).toBe('running')
    const taskId = record?.id ?? ''
    controllers.get(taskId)?.abort(new Error('用户取消'))
    await expect(runPromise).rejects.toThrow(/任务已取消/)
    expect(registry.get(taskId)?.phase).toBe('cancelled')
  })
})

describe('runtime difficulty gate', () => {
  for (const minimum of TASK_DIFFICULTIES) {
    for (const difficulty of TASK_DIFFICULTIES) {
      it(`enforces ${difficulty} against ${minimum} before running`, async () => {
        const cli = fakeCliSpawn(true)
        const { deps, registry, controllers } = makeDeps(fixture({ minTaskDifficulty: minimum }), cli.spawnFn)
        const params: DispatchParams = { cli: 'claude', task: '完整的跨组件任务', taskDifficulty: difficulty, difficultyReason: '按真实任务范围、多个步骤及依赖风险完成评估' }
        if (TASK_DIFFICULTIES.indexOf(difficulty) >= TASK_DIFFICULTIES.indexOf(minimum)) {
          const value = await runDispatch(deps, params, new AbortController().signal)
          expect(value.ok).toBe(true)
          expect(value.notes.join(' ')).toContain(`难度评估：${difficulty}；claude 最低难度：${minimum}`)
          expect(registry.list()[0]?.phase).toBe('done')
          expect(cli.launches.length).toBeGreaterThan(0)
        } else {
          await expect(runDispatch(deps, params, new AbortController().signal)).rejects.toThrow(/低于最低难度/)
          expect(registry.list()).toEqual([])
          expect(cli.launches).toEqual([])
        }
        expect(controllers.size).toBe(0)
      })
    }
  }

  it.each(['auto', 'claude', 'codex'])('blocks low %s even with keywords and a forged user-requested flag', async requested => {
    const cli = fakeCliSpawn(true)
    const { deps, registry, controllers } = makeDeps(fixture(), cli.spawnFn, vi.fn())
    const detect = vi.spyOn(deps.pathCache, 'pathOf')
    const acquire = vi.spyOn(deps.limiter, 'acquire')
    const create = vi.spyOn(registry, 'create')
    const setController = vi.spyOn(controllers, 'set')
    const onTaskId = vi.fn()
    const params = {
      cli: requested, task: '用户点名 codex/claude；跨模块重构项目测试系统级任务',
      taskDifficulty: 'low', difficultyReason: '实际仅需修改一处说明', userRequestedCli: true,
    } as DispatchParams
    await expect(runDispatch(deps, params, new AbortController().signal, { onTaskId })).rejects.toThrow(/低于最低难度.*未启动 CLI/)
    expect(detect).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(setController).not.toHaveBeenCalled()
    expect(deps.resolveDshModel).not.toHaveBeenCalled()
    expect(onTaskId).not.toHaveBeenCalled()
    expect(registry.list()).toEqual([])
    expect(controllers.size).toBe(0)
    expect(cli.launches).toEqual([])
  })

  it('rejects old unassessed calls at the default threshold, even for explicit CLI and high keywords', async () => {
    const cli = fakeCliSpawn(true)
    const { deps, registry } = makeDeps(fixture(), cli.spawnFn)
    await expect(runDispatch(deps, { cli: 'codex', task: '跨模块重构系统级项目测试' }, new AbortController().signal))
      .rejects.toThrow(/未提供难度评估，保守按低处理/)
    expect(cli.launches).toEqual([])
    expect(registry.list()).toEqual([])
  })

  it('keeps legacy calls compatible when the operator explicitly selects low', async () => {
    const cli = fakeCliSpawn(true)
    const { deps } = makeDeps(fixture({ minTaskDifficulty: 'low' }), cli.spawnFn)
    const value = await runDispatch(deps, { cli: 'claude', task: '旧调用' }, new AbortController().signal)
    expect(value.ok).toBe(true)
    expect(value.notes.join(' ')).toContain('旧调用未提供评估，保守按 low 处理')
  })

  it.each([
    { taskDifficulty: 'high' },
    { taskDifficulty: 'high', difficultyReason: ' ' },
    { taskDifficulty: 'high', difficultyReason: 7 },
    { taskDifficulty: 'HIGH', difficultyReason: 'x' },
    { taskDifficulty: null, difficultyReason: 'x' },
    { difficultyReason: 'x' },
  ])('revalidates direct runtime assessment fields %j before detection', async fields => {
    const cli = fakeCliSpawn(true)
    const { deps, registry } = makeDeps(fixture({ minTaskDifficulty: 'low' }), cli.spawnFn)
    const params = { cli: 'claude', task: 'x', ...fields } as unknown as DispatchParams
    await expect(runDispatch(deps, params, new AbortController().signal)).rejects.toThrow(/task_difficulty|difficulty_reason/)
    expect(cli.launches).toEqual([])
    expect(registry.list()).toEqual([])
  })

  it('re-reads both live volatile thresholds for each run without rebuilding dependencies', async () => {
    const cli = fakeCliSpawn(true)
    let claude = 'high'
    let codex = 'medium'
    const config = {
      claudeMinTaskDifficulty: { get: () => claude },
      codexMinTaskDifficulty: { get: () => codex },
      claudeCliPath: process.execPath, codexCliPath: process.execPath,
    } as unknown as Parameters<typeof effectiveOf>[0]
    const { deps, registry } = makeDeps(effectiveOf(config), cli.spawnFn)
    deps.readConfig = () => effectiveOf(config)
    const params: DispatchParams = { ...assessment, cli: 'claude', task: '多步任务' }
    await expect(runDispatch(deps, params, new AbortController().signal)).rejects.toThrow(/最低难度 高.*claude/)
    expect(cli.launches).toEqual([])
    expect((await runDispatch(deps, { ...params, cli: 'codex' }, new AbortController().signal)).ok).toBe(true)
    claude = 'medium'
    expect((await runDispatch(deps, params, new AbortController().signal)).ok).toBe(true)
    const launches = cli.launches.length
    codex = 'extreme'
    await expect(runDispatch(deps, { ...params, cli: 'codex' }, new AbortController().signal)).rejects.toThrow(/最低难度 极高.*codex/)
    expect(cli.launches).toHaveLength(launches)
    expect(registry.list()).toHaveLength(2)
  })

  it.each(TASK_DIFFICULTIES)('allows equality at independent %s thresholds for both CLIs', async minimum => {
    for (const selectedCli of ['claude', 'codex'] as const) {
      const cli = fakeCliSpawn(true)
      const config = fixture()
      config[selectedCli].minTaskDifficulty = minimum
      config[selectedCli === 'claude' ? 'codex' : 'claude'].minTaskDifficulty = 'extreme'
      const { deps } = makeDeps(config, cli.spawnFn)
      const value = await runDispatch(deps, { ...assessment, cli: selectedCli, task: '完整任务', taskDifficulty: minimum }, new AbortController().signal)
      expect(value.cli).toBe(selectedCli)
      expect(value.notes[0]).toContain(`${selectedCli} 最低难度：${minimum}`)
    }
  })

  it.each([
    { requested: 'claude', task: '项目测试', defaultCli: 'codex', disabled: undefined, actual: 'claude', allowed: false },
    { requested: 'codex', task: '重构', defaultCli: 'claude', disabled: undefined, actual: 'codex', allowed: true },
    { requested: 'auto', task: '重构', defaultCli: 'codex', disabled: undefined, actual: 'claude', allowed: false },
    { requested: 'auto', task: '项目测试', defaultCli: 'claude', disabled: undefined, actual: 'codex', allowed: true },
    { requested: 'auto', task: '无命中任务', defaultCli: 'claude', disabled: undefined, actual: 'claude', allowed: false },
    { requested: 'auto', task: '无命中任务', defaultCli: 'codex', disabled: undefined, actual: 'codex', allowed: true },
    { requested: 'codex', task: '项目测试', defaultCli: 'codex', disabled: 'codex', actual: 'claude', allowed: false },
    { requested: 'claude', task: '重构', defaultCli: 'claude', disabled: 'claude', actual: 'codex', allowed: true },
    { requested: 'auto', task: '无命中任务', defaultCli: 'codex', disabled: 'codex', actual: 'claude', allowed: false },
    { requested: 'auto', task: '无命中任务', defaultCli: 'claude', disabled: 'claude', actual: 'codex', allowed: true },
  ] as const)('checks only actual CLI for $requested / $task / disabled=$disabled / default=$defaultCli', async scenario => {
    const cli = fakeCliSpawn(true)
    const config = fixture({ defaultCli: scenario.defaultCli })
    config.claude.minTaskDifficulty = 'high'
    config.codex.minTaskDifficulty = 'low'
    if (scenario.disabled !== undefined) config[scenario.disabled].enabled = false
    // The dispatch no longer falls back to the CLI's own model, so the fixture
    // has to name a usable dsh route; the spy still must stay untouched on a
    // gate rejection.
    config.claude.dshModel = 'claude-cfg::m'
    config.codex.dshModel = 'codex-cfg::m'
    const resolveDshModel = vi.fn(async (selection: string) => ({
      provider: selection.slice(0, selection.indexOf('::')),
      model: 'm',
      api: (selection.startsWith('claude') ? 'anthropic-messages' : 'openai-responses') as DshModelEndpoint['api'],
      baseURL: 'https://example.test',
      apiKey: 'k',
    }))
    const { deps, registry, controllers } = makeDeps(config, cli.spawnFn, resolveDshModel)
    const detect = vi.spyOn(deps.pathCache, 'pathOf')
    const acquire = vi.spyOn(deps.limiter, 'acquire')
    const create = vi.spyOn(registry, 'create')
    const setController = vi.spyOn(controllers, 'set')
    const addAbortListener = vi.spyOn(AbortSignal.prototype, 'addEventListener')
    const listMcpServers = vi.fn(() => [])
    const onTaskId = vi.fn()
    const appendUsage = vi.fn()
    const params: DispatchParams = {
      ...assessment, cli: scenario.requested, task: scenario.task,
      usageSession: { append: appendUsage },
    }
    try {
      if (scenario.allowed) {
        const value = await runDispatch({ ...deps, listMcpServers }, params, new AbortController().signal, { onTaskId })
        expect(value.cli).toBe(scenario.actual)
        expect(value.notes[0]).toContain(`${scenario.actual} 最低难度：low`)
        expect(detect).toHaveBeenCalledWith(scenario.actual, expect.any(AbortSignal))
        if (scenario.disabled !== undefined && scenario.requested !== 'auto') expect(value.notes.join(' ')).toContain(`回落到 ${scenario.actual}`)
      } else {
        await expect(runDispatch({ ...deps, listMcpServers }, params, new AbortController().signal, { onTaskId }))
          .rejects.toThrow(/最低难度 高（high）（实际 CLI：claude）/)
        expect(detect).not.toHaveBeenCalled()
        expect(acquire).not.toHaveBeenCalled()
        expect(create).not.toHaveBeenCalled()
        expect(setController).not.toHaveBeenCalled()
        expect(addAbortListener).not.toHaveBeenCalled()
        expect(onTaskId).not.toHaveBeenCalled()
        expect(resolveDshModel).not.toHaveBeenCalled()
        expect(listMcpServers).not.toHaveBeenCalled()
        expect(appendUsage).not.toHaveBeenCalled()
        expect(cli.launches).toEqual([])
        expect(registry.list()).toEqual([])
      }
      expect(controllers.size).toBe(0)
    } finally {
      addAbortListener.mockRestore()
    }
  })
})

describe('model resolution order', () => {
  function endpoint(api: DshModelEndpoint['api'], model: string): DshModelEndpoint {
    return { provider: 'p', model, api, baseURL: 'https://example.test', apiKey: 'k' }
  }

  it('prefers the calling agent model over the configured dsh model', async () => {
    const cli = fakeCliSpawn(true)
    const config = fixture()
    config.claude.dshModel = 'cfg::configured'
    const seen: string[] = []
    const { deps, registry } = makeDeps(config, cli.spawnFn, async (selection) => {
      seen.push(selection)
      return endpoint('anthropic-messages', selection === 'agent::main' ? 'agent-model' : 'configured-model')
    })
    const value = await runDispatch(deps, {
      ...assessment,
      cli: 'claude', task: 'x', primaryModel: { provider: 'agent', model: 'main' },
    }, new AbortController().signal)
    expect(seen).toEqual(['agent::main'])
    expect(value.model).toBe('agent-model')
    expect(registry.list()[0]?.model).toBe('agent-model')
    expect(value.notes.some(note => note.includes('沿用主代理'))).toBe(true)
  })

  it('falls back to the configured model when the agent protocol is unsupported', async () => {
    const cli = fakeCliSpawn(true)
    const config = fixture()
    config.claude.dshModel = 'cfg::configured'
    const { deps } = makeDeps(config, cli.spawnFn, async selection => (selection === 'agent::main'
      ? endpoint('openai-completions', 'agent-model')
      : endpoint('anthropic-messages', 'configured-model')))
    const value = await runDispatch(deps, {
      ...assessment,
      cli: 'claude', task: 'x', primaryModel: { provider: 'agent', model: 'main' },
    }, new AbortController().signal)
    expect(value.model).toBe('configured-model')
    expect(value.notes.some(note => note.includes('直接使用配置页模型'))).toBe(true)
  })

  it('falls back when the agent route cannot be resolved at all', async () => {
    const cli = fakeCliSpawn(true)
    const config = fixture()
    config.claude.dshModel = 'cfg::configured'
    const { deps } = makeDeps(config, cli.spawnFn, async (selection) => {
      if (selection === 'agent::main') throw new Error('供应商不存在：agent')
      return endpoint('anthropic-messages', 'configured-model')
    })
    const value = await runDispatch(deps, {
      ...assessment,
      cli: 'claude', task: 'x', primaryModel: { provider: 'agent', model: 'main' },
    }, new AbortController().signal)
    expect(value.model).toBe('configured-model')
    expect(value.notes.some(note => note.includes('不可用'))).toBe(true)
  })

  it('fails hard when the configured model protocol is unsupported', async () => {
    const cli = fakeCliSpawn(true)
    const config = fixture()
    config.claude.dshModel = 'cfg::configured'
    const { deps, registry } = makeDeps(config, cli.spawnFn, async () => endpoint('openai-completions', 'm'))
    await expect(runDispatch(deps, { ...assessment, cli: 'claude', task: 'x' }, new AbortController().signal))
      .rejects.toThrow(/anthropic-messages/)
    expect(registry.list()[0]?.phase).toBe('failed')
  })

  it('never resolves a model when the tool arg names one', async () => {
    const cli = fakeCliSpawn(true)
    const { deps } = makeDeps(fixture(), cli.spawnFn, async () => { throw new Error('不该被调用') })
    const value = await runDispatch(deps, { ...assessment, cli: 'claude', task: 'x', model: 'explicit' }, new AbortController().signal)
    expect(value.model).toBe('explicit')
  })

  it('codex falls back when the agent route speaks anthropic-messages (codex cannot use it)', async () => {
    const cli = fakeCliSpawn(true)
    const config = fixture()
    config.codex.dshModel = 'cfg::configured'
    const { deps } = makeDeps(config, cli.spawnFn, async selection => (selection === 'agent::main'
      ? endpoint('anthropic-messages', 'agent-model')
      : endpoint('openai-responses', 'configured-model')))
    const value = await runDispatch(deps, {
      ...assessment,
      cli: 'codex', task: 'x', primaryModel: { provider: 'agent', model: 'main' },
    }, new AbortController().signal)
    expect(value.model).toBe('configured-model')
    expect(value.notes.some(note => note.includes('协议不受 codex 支持'))).toBe(true)
    expect(value.notes.some(note => note.includes('openai-responses'))).toBe(true)
  })

  it('codex inherits an openai-completions agent route over the responses dialect', async () => {
    // dsh labels a provider openai-completions when *dsh* talks chat to it, but
    // such an upstream usually serves /responses too (verified against ofox), and
    // codex relays everything over the responses dialect. So a chat-labelled
    // route must still be handed down instead of being rejected outright.
    const cli = fakeCliSpawn(true)
    const config = fixture()
    config.codex.dshModel = 'cfg::configured'
    const { deps } = makeDeps(config, cli.spawnFn, async selection => (selection === 'ofox::gpt-6.1-sol'
      ? { ...endpoint('openai-completions', 'agent-model'), baseURL: 'https://api.ofox.io/v1' }
      : endpoint('openai-responses', 'configured-model')))
    const value = await runDispatch(deps, {
      ...assessment,
      cli: 'codex', task: 'x', primaryModel: { provider: 'ofox', model: 'gpt-6.1-sol' },
    }, new AbortController().signal)
    expect(value.model).toBe('agent-model')
    expect(value.notes.some(note => note.includes('沿用主代理'))).toBe(true)
    const launch = cli.launches.find(child => child.spawnArgs[0] === 'exec')
    expect(launch?.spawnArgs).toContain('model_providers.maestro_dsh.wire_api="responses"')
    expect(launch?.spawnArgs).toContain('model_providers.maestro_dsh.base_url="https://api.ofox.io/v1"')
  })

  it('codex hard-fails a configured dsh model on a non-OpenAI protocol', async () => {
    const cli = fakeCliSpawn(true)
    const config = fixture()
    config.codex.dshModel = 'cfg::configured'
    const { deps, registry } = makeDeps(config, cli.spawnFn, async () => endpoint('anthropic-messages', 'm'))
    await expect(runDispatch(deps, { ...assessment, cli: 'codex', task: 'x' }, new AbortController().signal))
      .rejects.toThrow(/codex 只认 OpenAI 兼容端点/)
    expect(registry.list()[0]?.phase).toBe('failed')
  })

  it('fails loudly instead of running codex on its own model', async () => {
    // Reported failure: the primary route spoke a protocol codex cannot use and
    // the card named no replacement. Falling through to codex's own config.toml
    // ran an unrelated private router and 503'd, so the dispatch has to stop and
    // say which routes it tried rather than spawn the child unequipped.
    const cli = fakeCliSpawn(true)
    const { deps, registry } = makeDeps(fixture(), cli.spawnFn, async () => endpoint('anthropic-messages', 'agent-model'))
    const run = runDispatch(deps, {
      ...assessment,
      cli: 'codex',
      task: 'x',
      primaryModel: { provider: 'ofox', model: 'gpt-6.1-sol' },
    }, new AbortController().signal)
    await expect(run).rejects.toThrow(/配置页未设置 codexDshModel/)
    await expect(run).rejects.toThrow(/ofox::gpt-6\.1-sol/)
    await expect(run).rejects.toThrow(/不会回退到 codex 自身的配置文件/)
    expect(registry.list()[0]?.phase).toBe('failed')
    expect(cli.launches.some(child => child.spawnArgs[0] === 'exec')).toBe(false)
  })

  it('names the CLI default only when the host exposes no model resolver', async () => {
    const cli = fakeCliSpawn(true)
    const { deps } = makeDeps(fixture(), cli.spawnFn)
    const value = await runDispatch(deps, { ...assessment, cli: 'codex', task: 'x' }, new AbortController().signal)
    expect(value.notes.some(note => note.includes('读不到 dsh 模型目录'))).toBe(true)
  })
})

describe('usage reporting', () => {
  it.each([
    ['codex', 'failed'], ['codex', 'timeout'], ['codex', 'cancelled'],
    ['claude', 'failed'], ['claude', 'timeout'], ['claude', 'cancelled'],
  ] as const)('preserves received %s usage and recovery ref after %s', async (channel, ending) => {
    vi.useFakeTimers()
    try {
      const cli = scriptedSpawn(child => {
        child.pid = undefined as unknown as number
        if (child.spawnArgs[0] === '--version') { child.finish('version 1.0'); return }
        child.onStdin = () => {
          const frames = channel === 'codex'
            ? [
                { type: 'thread.started', thread_id: 'recover-1' },
                { type: 'turn.failed', error: { message: 'real failure' }, usage: { input_tokens: 18, cached_input_tokens: 7, output_tokens: 5 } },
              ]
            : [
                { type: 'system', subtype: 'init', session_id: 'recover-1' },
                { type: 'result', is_error: true, result: 'real failure', usage: { input_tokens: 11, cache_read_input_tokens: 7, output_tokens: 5, cache_creation_input_tokens: 3 } },
              ]
          const output = frames.map(frame => JSON.stringify(frame)).join('\n') + '\n'
          if (ending === 'failed') child.finish(output, 1)
          else queueMicrotask(() => child.stdout.emit('data', Buffer.from(output)))
        }
      })
      const { deps, registry } = makeDeps(fixture({ injectGitContext: false }), cli.spawnFn)
      const append = vi.fn()
      const persist = vi.fn()
      deps.persist = persist
      const controller = new AbortController()
      const run = runDispatch(deps, {
        ...assessment, cli: channel, task: 'x', timeoutMinutes: 1, usageSession: { append },
      }, controller.signal)
      // Attach rejection handling before advancing the fake clock.
      const settled = run.then(value => value, error => error)
      await vi.advanceTimersByTimeAsync(0)
      if (ending === 'timeout') await vi.advanceTimersByTimeAsync(60_000)
      if (ending === 'cancelled') { controller.abort(); await vi.advanceTimersByTimeAsync(0) }
      expect(await settled).toBeInstanceOf(Error)
      const phase = ending === 'cancelled' ? 'cancelled' : ending === 'timeout' ? 'timeout' : 'failed'
      const stats = { inputTokens: 11, cachedInputTokens: 7, outputTokens: 5, sessionRef: 'recover-1' }
      expect(registry.get(registry.list()[0]!.id)).toMatchObject({ phase, stats })
      if (ending === 'timeout') expect(registry.get(registry.list()[0]!.id)?.stats?.['timedOut']).toBe(true)
      expect(append).toHaveBeenCalledTimes(1)
      expect(append).toHaveBeenCalledWith(CLI_USAGE_EVENT, expect.objectContaining({ phase, inputTokens: 11, cachedInputTokens: 7, outputTokens: 5 }))
      expect(persist).toHaveBeenCalledTimes(1)
      expect(persist).toHaveBeenCalledWith(expect.objectContaining({ phase, stats: expect.objectContaining(stats) }))
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it.each([true, false])('accumulates failed-attempt costs when the final retry succeeds=%s', async succeeds => {
    let attempt = 0
    const cli = scriptedSpawn(child => {
      if (child.spawnArgs[0] === '--version') { child.finish('version 1.0'); return }
      attempt += 1
      const ok = succeeds && attempt === 2
      child.finish(JSON.stringify({
        type: 'result', is_error: !ok, session_id: `s${attempt}`, num_turns: attempt,
        result: ok ? 'done' : 'failed', duration_ms: attempt * 10, total_cost_usd: attempt / 10,
        usage: { input_tokens: attempt * 11, output_tokens: attempt * 5, cache_read_input_tokens: attempt * 7, cache_creation_input_tokens: attempt * 3 },
      }), ok ? 0 : 1)
    })
    const { deps, registry } = makeDeps(fixture({ failureRetries: 1, injectGitContext: false }), cli.spawnFn)
    const append = vi.fn()
    const run = runDispatch(deps, { ...assessment, cli: 'claude', task: 'x', usageSession: { append } }, new AbortController().signal)
    if (succeeds) expect((await run).ok).toBe(true)
    else await expect(run).rejects.toThrow()
    expect(attempt).toBe(2)
    expect(registry.get(registry.list()[0]!.id)?.stats).toMatchObject({
      inputTokens: 33, outputTokens: 15, cachedInputTokens: 21, cacheWriteTokens: 9,
      sessionId: 's2', sessionRef: 's2', turns: 2, cliDurationMs: 20,
    })
    expect(registry.get(registry.list()[0]!.id)?.stats?.['costUsd']).toBeCloseTo(0.3)
    expect(append).toHaveBeenCalledWith(CLI_USAGE_EVENT, expect.objectContaining({ inputTokens: 33, outputTokens: 15, cachedInputTokens: 21, cacheWriteTokens: 9 }))
  })

  it('appends one usage event with the settled stats', async () => {
    const cli = fakeCliSpawn(true)
    const { deps } = makeDeps(fixture(), cli.spawnFn)
    const appended: Array<{ type: string; data: unknown }> = []
    const value = await runDispatch(deps, {
      ...assessment, cli: 'codex', task: 'x',
      usageSession: { append: (type: string, data: unknown) => { appended.push({ type, data }) } },
    }, new AbortController().signal)
    expect(value.ok).toBe(true)
    expect(appended).toHaveLength(1)
    expect(appended[0]?.type).toBe(CLI_USAGE_EVENT)
    expect(appended[0]?.data).toMatchObject({ cli: 'codex', phase: 'done', exitCode: 0 })
  })

  it('reports failed runs too', async () => {
    const cli = fakeCliSpawn(false)
    const { deps } = makeDeps(fixture(), cli.spawnFn)
    const appended: Array<{ type: string; data: unknown }> = []
    await expect(runDispatch(deps, {
      ...assessment, cli: 'codex', task: 'x',
      usageSession: { append: (type: string, data: unknown) => { appended.push({ type, data }) } },
    }, new AbortController().signal)).rejects.toThrow()
    expect(appended).toHaveLength(1)
    expect(appended[0]?.data).toMatchObject({ cli: 'codex', phase: 'failed' })
  })

  it('runs unchanged without a session', async () => {
    const cli = fakeCliSpawn(true)
    const { deps } = makeDeps(fixture(), cli.spawnFn)
    const value = await runDispatch(deps, { ...assessment, cli: 'claude', task: 'x' }, new AbortController().signal)
    expect(value.ok).toBe(true)
  })
})

describe('persist sink', () => {
  it('hands the settled task to the sink once, on success and on failure', async () => {
    const persisted: Array<{ id: string; phase: string }> = []
    const okDeps = makeDeps(fixture(), fakeCliSpawn(true).spawnFn)
    okDeps.deps.persist = task => { persisted.push({ id: task.id, phase: task.phase }) }
    const value = await runDispatch(okDeps.deps, { ...assessment, cli: 'codex', task: 'x' }, new AbortController().signal)
    expect(value.ok).toBe(true)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({ phase: 'done' })

    const failDeps = makeDeps(fixture(), fakeCliSpawn(false).spawnFn)
    failDeps.deps.persist = task => { persisted.push({ id: task.id, phase: task.phase }) }
    await expect(runDispatch(failDeps.deps, { ...assessment, cli: 'codex', task: 'x' }, new AbortController().signal)).rejects.toThrow()
    expect(persisted).toHaveLength(2)
    expect(persisted[1]).toMatchObject({ phase: 'failed' })
  })

  it('does not fail the dispatch when the sink throws', async () => {
    const { deps } = makeDeps(fixture(), fakeCliSpawn(true).spawnFn)
    deps.persist = () => { throw new Error('sink exploded') }
    const value = await runDispatch(deps, { ...assessment, cli: 'claude', task: 'x' }, new AbortController().signal)
    expect(value.ok).toBe(true)
  })
})
