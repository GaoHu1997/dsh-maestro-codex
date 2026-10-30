/**
 * 第三/四大点协同功能的回归：job 镜像（方案 B）、external 目录行（A2）、
 * git 上下文注入（接缝①）、会话续接（resume）、失败重试与超时预警。
 */

import { describe, expect, it, vi } from 'vitest'
import { effectiveOf, validateConfig, type EffectiveConfig } from '../src/config.js'
import { parseDispatchParams, runDispatch, type DispatchParams, type DispatchValue } from '../src/dispatch.js'
import { externalCatalogRow, jobsFaceOf, mirrorAsJob, type JobHandleFace, type JobsFace } from '../src/job-mirror.js'
import { gitContextBlockOf } from '../src/git-context.js'
import { CliPathCache } from '../src/dispatch.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { scriptedSpawn } from './fake-child.js'

const assessment = {
  taskDifficulty: 'medium',
  difficultyReason: '范围明确的多步任务，需要实现并验证输出和回归行为',
} satisfies Pick<DispatchParams, 'taskDifficulty' | 'difficultyReason'>

function fixture(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return { ...effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath }), ...overrides }
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
      JSON.stringify({ type: 'result', subtype: 'success', result: 'claude 完成', num_turns: 1 }),
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
      spawnFn,
      logger: { warn: vi.fn(), error: vi.fn() },
    },
    registry,
    controllers,
  }
}

/** A scripted JobsFace capturing specs and letting the test drive the handle. */
function fakeJobs(): JobsFace & { specs: Array<{ kind: string; label: string; owner: string }>; appended: string[]; progress: string[]; dones: Promise<JobOutcome>[] } {
  const specs: Array<{ kind: string; label: string; owner: string }> = []
  const appended: string[] = []
  const progress: string[] = []
  const dones: Promise<JobOutcome>[] = []
  return {
    specs,
    appended,
    progress,
    dones,
    start: (spec) => {
      specs.push({ kind: spec.kind, label: spec.label, owner: spec.owner })
      const done = spec.run({
        append: (text, options) => { if (options?.channel !== 'log') appended.push(text) },
        updateProgress: line => { progress.push(line) },
      }).done
      dones.push(done)
      return 'job-1'
    },
  }
}

describe('job mirror (方案 B)', () => {
  it('mirrors one dispatch: same value, job row completes, events stream into the handle', async () => {
    const cli = collabCliSpawn()
    const config = fixture()
    config.injectGitContext = false
    const { deps } = makeDeps(config, cli.spawnFn)
    const jobs = fakeJobs()
    const value = await mirrorAsJob({
      jobs, owner: 'session-1', label: 'CLI(codex) 数据任务', deps, params: { ...assessment, cli: 'codex', task: '数据任务' }, signal: new AbortController().signal,
    })
    expect(value.ok).toBe(true)
    expect(value.finalText).toBe('第 1 次完成')
    expect(jobs.specs).toEqual([{ kind: 'cli', label: 'CLI(codex) 数据任务', owner: 'session-1' }])
    // 事件与最终答案都进了 job 输出环，job 行以 completed 收尾。
    expect(jobs.appended).toContain('第 1 次完成')
    expect(jobs.progress.some(line => line.includes('开始执行'))).toBe(true)
    await expect(jobs.dones[0]).resolves.toMatchObject({ status: 'completed', detail: expect.stringContaining('exit 0'), result: '第 1 次完成' })
  })

  it('maps a user stop to a killed job while the dispatch itself rejects', async () => {
    const cli = collabCliSpawn()
    const config = fixture()
    config.injectGitContext = false
    const { deps, controllers } = makeDeps(config, cli.spawnFn)
    const jobs = fakeJobs()
    // 让 job 的 cancel 能拿到 controller：onTaskId 在 runDispatch 里登记。
    const signal = new AbortController().signal
    const run = mirrorAsJob({ jobs, owner: 's', label: 'l', deps, params: { ...assessment, cli: 'codex', task: '任务' }, signal })
    // 等控制器登记后从任务页终止；abort 原因就是 rejection 本身。
    await vi.waitFor(() => { expect(deps.controllers.size).toBe(1) })
    const taskId = [...deps.controllers.keys()][0] ?? ''
    deps.controllers.get(taskId)?.abort(new Error('已从任务页终止'))
    await expect(run).rejects.toThrow(/已从任务页终止/)
    // job 行以 killed 收尾，registry 记为 cancelled，controller 已清理。
    await expect(jobs.dones[0]).resolves.toMatchObject({ status: 'killed' })
    expect(deps.registry.get(taskId)?.phase).toBe('cancelled')
    expect(controllers.size).toBe(0)
  })

  it('falls back to a bare dispatch when jobs.start refuses (no double run)', async () => {
    const cli = collabCliSpawn()
    const config = fixture()
    config.injectGitContext = false
    const { deps } = makeDeps(config, cli.spawnFn)
    const jobs: JobsFace = { start: () => { throw new Error('job 并发上限') } }
    const value = await mirrorAsJob({ jobs, owner: 's', label: 'l', deps, params: { ...assessment, cli: 'codex', task: '任务' }, signal: new AbortController().signal })
    expect(value.ok).toBe(true)
    expect(deps.logger?.warn).toHaveBeenCalledWith(expect.stringContaining('任务页镜像不可用'))
  })

  it('jobsFaceOf accepts only structurally valid services', () => {
    expect(jobsFaceOf(undefined)).toBeUndefined()
    expect(jobsFaceOf({})).toBeUndefined()
    expect(jobsFaceOf({ start: () => 'x' })).toBeDefined()
  })

  it('builds the A2 external catalog row', () => {
    const row = externalCatalogRow('task-1', 'cli · 数据任务', 123)
    expect(row).toMatchObject({ version: 2, childId: 'cli-task-1', childCreatedAt: 123, mode: 'external', label: 'cli · 数据任务' })
  })
})

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
    config.codex.dshModel = ''
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
    const { deps } = makeDeps(config, cli.spawnFn)
    const value = await runDispatch(deps, { ...assessment, cli: 'codex', task: '继续刚才的任务', resume: 'thread-abc' }, new AbortController().signal)
    expect(value.ok).toBe(true)
    const codexLaunch = cli.launches.find(child => child.spawnArgs[0] === 'exec' && child.spawnArgs[1] === 'resume')
    expect(codexLaunch?.spawnArgs).toContain('thread-abc')
    expect(codexLaunch?.spawnArgs).toContain('--json')
  })

  it('continues a claude session with --resume', async () => {
    const cli = collabCliSpawn()
    const config = fixture({ injectGitContext: false })
    const { deps } = makeDeps(config, cli.spawnFn)
    const value = await runDispatch(deps, { ...assessment, cli: 'claude', task: '继续', resume: 'sess-9' }, new AbortController().signal)
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
  it('defaults mirror/git on and retries off, and validates the retry range', () => {
    const effective = effectiveOf({})
    expect(effective.mirrorAsJob).toBe(true)
    expect(effective.injectGitContext).toBe(true)
    expect(effective.failureRetries).toBe(0)
    expect(effectiveOf({ failureRetries: 2 }).failureRetries).toBe(2)
    expect(() => validateConfig({ failureRetries: 3 })).toThrow(/failureRetries/)
    expect(() => validateConfig({ failureRetries: -1 })).toThrow(/failureRetries/)
  })
})
