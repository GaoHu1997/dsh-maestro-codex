/**
 * 协同功能回归：git 上下文注入（接缝①）、会话续接（resume）、失败重试与超时预警。
 * （A2 的 external 目录行已退役——宿主严格 schema 会在 fold 中拒绝它；子会话
 * 记录的形态回归见 tests/child-session.test.ts。）
 */

import { describe, expect, it, vi } from 'vitest'
import { effectiveOf, validateConfig, type EffectiveConfig } from '../src/config.js'
import { parseDispatchParams, runDispatch, type DispatchParams, type DispatchValue } from '../src/dispatch.js'
import { gitContextBlockOf } from '../src/git-context.js'
import { CliPathCache } from '../src/dispatch.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { scriptedSpawn } from './fake-child.js'
import { resolveTestDshModel, withTestDshRoutes } from './dsh-route-fixture.js'

const assessment = {
  taskDifficulty: 'medium',
  difficultyReason: '范围明确的多步任务，需要实现并验证输出和回归行为',
} satisfies Pick<DispatchParams, 'taskDifficulty' | 'difficultyReason'>

function fixture(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return { ...withTestDshRoutes(effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath })), ...overrides }
}

/** A fake spawn that answers --version, git status, then a claude/codex transcript. */
function collabCliSpawn(options: { codexRuns?: number; failFirstCodex?: boolean } = {}) {
  let codexRuns = 0
  const stdinTexts: string[] = []
  const spawn = scriptedSpawn(child => {
    if (child.spawnArgs[0] === '--version') {
      child.finish('claude version 9.9.9')
      return
    }
    if (child.spawnArgs[0] === '-C') {
      child.finish(['## main...origin/main', ' M src/a.ts', '?? notes.md'].join('\n'))
      return
    }
    if (child.spawnArgs[0] === 'exec' || child.spawnArgs[0] === 'resume') {
      codexRuns += 1
      if (options.failFirstCodex === true && codexRuns === 1) {
        child.finish([JSON.stringify({ type: 'turn.failed', error: { message: '网络抖动' } })].join('\n'), 0)
        return
      }
      child.onStdin = input => { stdinTexts.push(input) }
      child.finish([
        JSON.stringify({ type: 'thread.started', thread_id: 't-resume' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `第 ${String(codexRuns)} 次完成` } }),
        JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 3 } }),
      ].join('\n'))
      return
    }
    child.onStdin = input => { stdinTexts.push(input) }
    child.finish([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-resume' }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'claude 完成', num_turns: 1 }),
    ].join('\n'))
  })
  return { ...spawn, codexRunsOf: () => codexRuns, stdinTexts }
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
      resolveDshModel: resolveTestDshModel,
      spawnFn,
      logger: { warn: vi.fn(), error: vi.fn() },
    },
    registry,
    controllers,
  }
}



describe('git context injection (接缝①)', () => {
  it('folds a porcelain snapshot into a bounded prefix block', () => {
    const block = gitContextBlockOf(['## main...origin/main [ahead 1]', ' M src/a.ts', '?? notes.md'].join('\n'), 'C:\\work')
    expect(block).toContain('[CLI 子代理上下文')
    expect(block).toContain('分支：main...origin/main [ahead 1]')
    expect(block).toContain('M src/a.ts')
    expect(block).toContain('[任务描述如下]')
  })

  it('refuses output without the porcelain branch line and passes a clean tree through', () => {
    expect(gitContextBlockOf('fatal: not a git repository', 'C:\\work')).toBeUndefined()
    expect(gitContextBlockOf('', 'C:\\work')).toBeUndefined()
    const clean = gitContextBlockOf('## main', 'C:\\work')
    expect(clean).toContain('工作区：干净')
  })

  it('runDispatch prepends the snapshot to the child task text only', async () => {
    const cli = collabCliSpawn()
    const config = fixture()
    config.codex.dshModel = 'test-codex::test-codex-model'
    const { deps } = makeDeps(config, cli.spawnFn)
    const value = await runDispatch(deps, { ...assessment, cli: 'codex', task: '数据处理任务正文' }, new AbortController().signal)
    expect(value.ok).toBe(true)
    expect(cli.stdinTexts[0]?.startsWith('[CLI 子代理上下文')).toBe(true)
    expect(cli.stdinTexts[0]).toContain('数据处理任务正文')
    // registry 标题仍用原 task，不带快照前缀。
    expect(deps.registry.list()[0]?.title).not.toContain('CLI 子代理上下文')
  })

  it('skips the injection when disabled', async () => {
    const cli = collabCliSpawn()
    const config = fixture({ injectGitContext: false })
    const { deps } = makeDeps(config, cli.spawnFn)
    await runDispatch(deps, { ...assessment, cli: 'codex', task: '正文' }, new AbortController().signal)
    expect(cli.stdinTexts[0]?.startsWith('[CLI 子代理上下文')).toBe(false)
  })
})

describe('resume (接缝④)', () => {
  it('continues a codex thread with `exec resume <id>` and notes the carry-over limit', async () => {
    const cli = collabCliSpawn()
    const config = fixture({ injectGitContext: false })
    const { deps, registry } = makeDeps(config, cli.spawnFn)
    const anchor = registry.create({ id: 'resume-codex-root', cli: 'codex', title: '初轮', model: '', sessionId: 's-collab' })
    anchor.stats = { sessionRef: 'thread-abc' }
    registry.setPhase(anchor, 'done')
    const value = await runDispatch(deps, { ...assessment, sessionId: 's-collab', cli: 'codex', task: '继续刚才的任务', resume: 'thread-abc' }, new AbortController().signal)
    expect(value.ok).toBe(true)
    const codexLaunch = cli.launches.find(child => child.spawnArgs[0] === 'exec' && child.spawnArgs[1] === 'resume')
    expect(codexLaunch?.spawnArgs).toContain('thread-abc')
    expect(codexLaunch?.spawnArgs).toContain('--json')
  })

  it('continues a claude session with --resume', async () => {
    const cli = collabCliSpawn()
    const config = fixture({ injectGitContext: false })
    const { deps, registry } = makeDeps(config, cli.spawnFn)
    const anchor = registry.create({ id: 'resume-claude-root', cli: 'claude', title: '初轮', model: '', sessionId: 's-collab' })
    anchor.stats = { sessionRef: 'sess-9' }
    registry.setPhase(anchor, 'done')
    const value = await runDispatch(deps, { ...assessment, sessionId: 's-collab', cli: 'claude', task: '继续', resume: 'sess-9' }, new AbortController().signal)
    expect(value.ok).toBe(true)
    const claudeLaunch = cli.launches.find(child => child.spawnArgs.includes('--resume'))
    expect(claudeLaunch?.spawnArgs[claudeLaunch.spawnArgs.indexOf('--resume') + 1]).toBe('sess-9')
  })

  it('rejects a malformed resume reference in the shared parser', () => {
    // 校验发生在共享解析层（工具与手动路由共用），runDispatch 收到的已是解析结果。
    expect(parseDispatchParams({ task: 'x', task_difficulty: 'medium', difficulty_reason: '多步任务', resume: 'bad ref; rm -rf' })).toContain('resume')
    const parsed = parseDispatchParams({ task: 'x', task_difficulty: 'medium', difficulty_reason: '多步任务', resume: 'thread-abc' })
    expect(typeof parsed).toBe('object')
    if (typeof parsed !== 'string') expect(parsed.resume).toBe('thread-abc')
  })
})

describe('failure retry', () => {
  it('retries a plain failure once and records both attempts', async () => {
    const cli = collabCliSpawn({ failFirstCodex: true })
    const config = fixture({ injectGitContext: false, failureRetries: 1 })
    const { deps, registry } = makeDeps(config, cli.spawnFn)
    const value = await runDispatch(deps, { ...assessment, cli: 'codex', task: '重试任务' }, new AbortController().signal)
    expect(value.ok).toBe(true)
    expect(value.finalText).toBe('第 2 次完成')
    expect(cli.codexRunsOf()).toBe(2)
    const events = deps.registry.eventsSince(registry.list()[0]?.id ?? '', 0)?.events ?? []
    expect(events.some(event => event.text.includes('自动重试'))).toBe(true)
    expect(registry.list()[0]?.phase).toBe('done')
  })

  it('never retries a timeout or a cancellation', async () => {
    const cli = collabCliSpawn()
    const config = fixture({ injectGitContext: false, failureRetries: 2 })
    const { deps } = makeDeps(config, cli.spawnFn)
    const controller = new AbortController()
    const run = runDispatch(deps, { ...assessment, cli: 'codex', task: '取消任务' }, controller.signal)
    await vi.waitFor(() => { expect(deps.controllers.size).toBe(1) })
    controller.abort(new Error('用户取消'))
    // abort 原因原样冒出；关键是只跑了一次、没有重试。
    await expect(run).rejects.toThrow(/用户取消/)
    expect(cli.codexRunsOf()).toBeLessThanOrEqual(1)
  })
})

describe('timeout warning', () => {
  it('warns before the deadline and settles as timeout', async () => {
    // 子进程挂起不退出：等待通道的 timeout 杀掉（timeoutMinutes 不经 parse 钳制）。
    const hangSpawn = scriptedSpawn(child => {
      if (child.spawnArgs[0] === '--version') { child.finish('9.9.9'); return }
      if (child.spawnArgs[0] === '-C') { child.finish('## main'); return }
      // 不调用 finish：等 timeoutMs 杀掉
    })
    const config = fixture({ injectGitContext: false })
    const { deps, registry } = makeDeps(config, hangSpawn.spawnFn)
    const run = runDispatch(deps, { ...assessment, cli: 'codex', task: '慢任务', timeoutMinutes: 0.05 }, new AbortController().signal)
    await expect(run).rejects.toThrow(/超时/)
    const task = registry.list()[0]
    expect(task?.phase).toBe('timeout')
    const events = deps.registry.eventsSince(task?.id ?? '', 0)?.events ?? []
    expect(events.some(event => event.kind === 'note' && event.text.includes('若仍无输出'))).toBe(true)
    expect(events.some(event => event.text.includes('无输出保护，不代表任务语义进展'))).toBe(true)
  })
})

describe('collab config fields', () => {
  it('defaults git context on and retries off, and validates the retry range', () => {
    const effective = effectiveOf({})
    expect(effective.injectGitContext).toBe(true)
    expect(effective.failureRetries).toBe(0)
    expect(effectiveOf({ failureRetries: 2 }).failureRetries).toBe(2)
    expect(() => validateConfig({ failureRetries: 3 })).toThrow(/failureRetries/)
    expect(() => validateConfig({ failureRetries: -1 })).toThrow(/failureRetries/)
  })
})
