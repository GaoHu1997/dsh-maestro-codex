import { describe, expect, it } from 'vitest'
import { effectiveOf, type EffectiveConfig } from '../src/config.js'
import { CliPathCache, parseDispatchParams, runDispatch } from '../src/dispatch.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { scriptedSpawn } from './fake-child.js'

function fixture(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  const base = effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath })
  return { ...base, ...overrides }
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

function makeDeps(config: EffectiveConfig, spawnFn: ReturnType<typeof scriptedSpawn>['spawnFn']) {
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
    },
    registry,
    controllers,
  }
}

describe('parseDispatchParams', () => {
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
    const value = await runDispatch(deps, { cli: 'claude', task: '做个分析' }, new AbortController().signal)
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
    const value = await runDispatch(deps, { cli: 'auto', task: '写一个批量处理脚本' }, new AbortController().signal)
    expect(value.cli).toBe('codex')
    expect(value.finalText).toBe('codex 完成')
    expect(registry.list()[0]?.phase).toBe('done')
  })

  it('throws a friendly error when the CLI is not installed', async () => {
    const cli = fakeCliSpawn(true)
    const config = fixture()
    config.claude.cliPath = 'D:/no/such/claude.exe'
    const { deps } = makeDeps(config, cli.spawnFn)
    await expect(runDispatch(deps, { cli: 'claude', task: 'x' }, new AbortController().signal))
      .rejects.toThrow(/未安装或不可用/)
  })

  it('refuses to run when the plugin is disabled', async () => {
    const cli = fakeCliSpawn(true)
    const { deps } = makeDeps(fixture({ enabled: false }), cli.spawnFn)
    await expect(runDispatch(deps, { cli: 'claude', task: 'x' }, new AbortController().signal))
      .rejects.toThrow(/已停用/)
  })

  it('marks a failed run and throws with the CLI error', async () => {
    const cli = fakeCliSpawn(false)
    const { deps, registry } = makeDeps(fixture(), cli.spawnFn)
    await expect(runDispatch(deps, { cli: 'claude', task: 'x' }, new AbortController().signal))
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
    const runPromise = runDispatch(deps, { cli: 'claude', task: '长任务' }, outer.signal)
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
