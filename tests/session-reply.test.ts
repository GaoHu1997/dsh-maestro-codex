/**
 * 会话页的回复通道（`POST /task/reply`）与回复链模型：
 *
 * - 回复 = 对已结束 CLI 任务的一次续发：新任务带 `replyTo` 链回原任务，
 *   `resume` 用原任务的 sessionRef（claude `--resume` / codex `exec resume`）；
 * - 回复**不再过难度门槛、不改路由**：CLI 钉死为原任务的 CLI（会话引用只对
 *   那个 CLI 有意义），难度在原任务派发时已经审过；
 * - `model` 是 dsh 目录选择（`provider::model`），服务端解析成端点后驱动子进程；
 * - `buildChain` 把 `replyTo` 链折成轮次序列（会话页按它铺对话流）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectiveOf, type EffectiveConfig } from '../src/config.js'
import { createChildSessionRecorder } from '../src/child-session.js'
import { CliPathCache, runDispatch } from '../src/dispatch.js'
import { handleTaskDetail, handleTaskReply as replyInScope, handleTasks } from '../src/routes.js'
import type { TaskPrincipal } from '../src/routes.js'
const parent: TaskPrincipal = { sessionId: 's1' }
function handleTaskReply(deps: Parameters<typeof replyInScope>[0], body: unknown, principal: TaskPrincipal = parent): ReturnType<typeof replyInScope> {
  return replyInScope(deps, body, principal)
}
import { clearCliUsageMirrors, cliUsageProjectionDefinition } from '../src/usage.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import type { MaestroTaskSummary } from '../src/wire.js'
import { buildChain, replyAnchorOf } from '../src/client/board/Session.js'
import { scriptedSpawn } from './fake-child.js'
import { resolveTestDshModel, withTestDshRoutes } from './dsh-route-fixture.js'

/** A spawn that answers --version, then a claude (or codex) transcript whose
 * session reference is stable per run. */
function transcriptSpawn(kind: 'claude' | 'codex' = 'claude', sessionRef = 's-next'): ReturnType<typeof scriptedSpawn> {
  return scriptedSpawn(child => {
    if (child.spawnArgs[0] === '--version') {
      child.finish(kind === 'claude' ? 'claude version 1.0' : 'codex-cli 0.99')
      return
    }
    if (kind === 'codex') {
      child.finish([
        JSON.stringify({ type: 'thread.started', thread_id: sessionRef }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex 收到' } }),
        JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 5 } }),
      ].join('\n'))
      return
    }
    child.finish([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionRef }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'claude 收到，继续完成', is_error: false, num_turns: 1,
        usage: { input_tokens: 11, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } }),
    ].join('\n'), 0)
  })
}

function makeDeps(config: EffectiveConfig = effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath })) {
  config = withTestDshRoutes(config)
  const registry = new TaskRegistry()
  const controllers = new Map<string, AbortController>()
  const spawn = transcriptSpawn()
  return {
    deps: {
      readConfig: () => config,
      registry,
      limiter: new Limiter(() => config.maxConcurrentTasks),
      controllers,
      pathCache: new CliPathCache(() => config, spawn.spawnFn),
      spawnFn: spawn.spawnFn,
      toolName: () => 'dispatch_cli_task',
      // 会话页选中的 dsh 模型在这里解析（wb::gpt-6.1 → anthropic 兼容端点）。
      resolveDshModel: async (selection: string) => {
        if (selection.startsWith('test-')) return await resolveTestDshModel(selection)
        if (selection !== 'wb::gpt-6.1') throw new Error(`dsh 供应商 "${selection.split('::')[0]}" 不存在（可能已被移除）`)
        return { provider: 'wb', model: 'gpt-6.1', api: 'anthropic-messages' as const, baseURL: 'https://wb.example/v1', apiKey: 'k' }
      },
    },
    registry,
    launches: spawn.launches,
  }
}

/** A settled, continuable task as the session page would find it. */
function seedContinuable(registry: TaskRegistry, id = 'task-1', cli: 'claude' | 'codex' = 'claude', sessionId: string = 's1'): void {
  const task = registry.create({ id, cli, title: '首轮任务', cwd: '/work/repo', model: 'm1', ...(sessionId === undefined ? {} : { sessionId }) })
  registry.setPhase(task, 'running', '开始执行')
  // The runner records the CLI session reference inside the extensible stats
  // contract; the reply route and the summary both read it from there.
  task.stats = { sessionRef: cli === 'claude' ? 's-first' : 't-first' }
  registry.setPhase(task, 'done', '执行完成')
}

/** 同上，但带着上一轮解析出的会话模型（dispatch 会把 dsh 选择记进 stats）。 */
function seedWithConversationModel(registry: TaskRegistry, selection = 'wb::gpt-6.1', id = 'task-1'): void {
  seedContinuable(registry, id)
  const task = registry.get(id)
  if (task !== undefined) task.stats = { ...task.stats, dshModel: selection }
}

async function untilSettled(registry: TaskRegistry, id: string): Promise<ReturnType<TaskRegistry['get']>> {
  await vi.waitFor(() => {
    const task = registry.get(id)
    expect(task?.phase).toBeDefined()
    expect(['done', 'failed', 'cancelled', 'timeout']).toContain(task?.phase)
  }, { timeout: 4_000, interval: 25 })
  return registry.get(id)
}

beforeEach(() => { clearCliUsageMirrors() })

describe('handleTaskReply validation', () => {
  it('requires id and text, 404s unknown or out-of-scope tasks', () => {
    const { deps, registry } = makeDeps()
    expect(handleTaskReply(deps, {}).status).toBe(400)
    expect(handleTaskReply(deps, { id: 'task-1' }).status).toBe(400)
    expect(handleTaskReply(deps, { id: 'task-1', text: '  ' }).status).toBe(400)
    expect(handleTaskReply(deps, { id: 'missing', text: 'hi' }).status).toBe(404)
    seedContinuable(registry, 'task-2', 'claude', 's2')
    expect(handleTaskReply(deps, { id: 'task-2', text: 'hi', sessions: ['s1'] }).status).toBe(404)
    expect(handleTaskReply(deps, { id: 'task-2', text: 'hi', sessions: ['s1', 's2'] }).status).toBe(404)
    expect(handleTaskReply(deps, { id: 'task-2', text: 'hi', sessions: ['s2'] }, { sessionId: 's2' }).status).toBe(200)
  })

  it('refuses a running task and a task without a session reference', () => {
    const { deps, registry } = makeDeps()
    const running = registry.create({ id: 'task-r', cli: 'claude', title: '进行中', model: '', sessionId: 's1' })
    registry.setPhase(running, 'running', '开始执行')
    expect(handleTaskReply(deps, { id: 'task-r', text: 'hi' }).status).toBe(409)
    const done = registry.create({ id: 'task-d', cli: 'claude', title: '无引用', model: '', sessionId: 's1' })
    registry.setPhase(done, 'failed', 'CLI 未返回会话')
    expect(handleTaskReply(deps, { id: 'task-d', text: 'hi' }).status).toBe(409)
  })

  it('refuses a second reply while the first one is still in flight', async () => {
    // 会话页发送后到任务列表轮到新回复之间输入框是锁着的；这里是双开窗口
    // （或绕过前端直接打路由）的兜底：同一任务同时只能有一条回复在跑。
    const { deps, registry } = makeDeps()
    seedContinuable(registry)
    expect(handleTaskReply(deps, { id: 'task-1', text: '第一条' }).status).toBe(200)
    expect(handleTaskReply(deps, { id: 'task-1', text: '第二条' }).status).toBe(409)
    // 第一条结算后可以继续续发。
    await vi.waitFor(() => {
      expect(handleTaskReply(deps, { id: 'task-1', text: '第三条' }).status).toBe(200)
    }, { timeout: 4_000, interval: 50 })
  })

  it('validates the dsh model selection and the thinking token', () => {
    const { deps, registry } = makeDeps()
    seedContinuable(registry)
    expect(handleTaskReply(deps, { id: 'task-1', text: 'hi', model: 'bogus' }).status).toBe(400)
    expect(handleTaskReply(deps, { id: 'task-1', text: 'hi', model: 'wb::gpt' }).status).toBe(200)
    expect(handleTaskReply(deps, { id: 'task-1', text: 'hi', thinking: 'bad token!' }).status).toBe(400)
  })

  it('refuses while the plugin is disabled', () => {
    const { deps, registry } = makeDeps(effectiveOf({ enabled: false, claudeCliPath: process.execPath, codexCliPath: process.execPath }))
    seedContinuable(registry)
    expect(handleTaskReply(deps, { id: 'task-1', text: 'hi' }).status).toBe(409)
  })

  it('feeds the reply into the same usage channels without private session appends', async () => {
    // 回复与工具派发共用父会话 sidecar 投影和原生记录会话；私有标记只能
    // 经 create 的 seed 保存显式 ignorable，不能依赖会丢弃它的 append。
    type CapturedEvent = { type: string; data?: unknown; ignorable?: boolean }
    const appended: CapturedEvent[] = []
    const owner = { id: 's-owner', append: (type: string, data: unknown) => { appended.push({ type, data }) } }
    const definition = cliUsageProjectionDefinition()
    const state = definition.init({ id: owner.id }, 0)
    const created: Array<{
      id: string; meta: unknown; inheritedEventCount: number | undefined;
      seed: readonly CapturedEvent[]; events: CapturedEvent[]; appended: CapturedEvent[];
    }> = []
    const { deps, registry } = makeDeps()
    const recordingDeps = {
      ...deps,
      parentSessionOf: (sessionId: string) => sessionId === owner.id ? owner : undefined,
      childSessions: createChildSessionRecorder({
        store: () => ({
          create: (id, options) => {
            const seed = [...(options?.seed ?? [])]
            const record = {
              id, meta: options?.meta, inheritedEventCount: options?.inheritedEventCount,
              seed, events: [...seed] as CapturedEvent[], appended: [] as CapturedEvent[],
            }
            created.push(record)
            return { append: (type: string, data: unknown) => {
              const event = { type, data }
              record.events.push(event)
              record.appended.push(event)
            } }
          },
        }),
        readConfig: () => ({ recordChildSessions: true }),
      }),
    }
    // 首轮：归属 s-owner 会话，带上一轮解析出的 dsh 模型（回复据此继承）。
    const seeded = registry.create({ id: 'task-1', cli: 'claude', title: '首轮任务', cwd: '/work/repo', model: 'm1', sessionId: owner.id })
    registry.setPhase(seeded, 'running', '开始执行')
    seeded.stats = { sessionRef: 's-first', dshModel: 'wb::gpt-6.1' }
    registry.setPhase(seeded, 'done', '执行完成')
    const outcome = handleTaskReply(recordingDeps, { id: 'task-1', text: '继续刚才的任务' }, { sessionId: owner.id })
    expect(outcome.status).toBe(200)
    const { id } = outcome.body as { id: string }
    await untilSettled(registry, id)
    // 父会话只写原生目录事件，记账通过可信作用域的 wire view 可见。
    expect(appended.map(event => event.type)).toEqual(['subagent/catalog'])
    const projected = definition.wire.view(state)
    expect(state.totals.requests).toBe(0)
    expect(projected.recent).toHaveLength(1)
    expect(projected.recent[0]).toMatchObject({
      taskId: id, sessionId: owner.id, parentSessionId: owner.id, childSessionId: `cli-${id}`,
      cli: 'claude', phase: 'done', model: 'gpt-6.1',
      inputTokens: 11, outputTokens: 5, cachedInputTokens: 7, cacheWriteTokens: 3,
    })
    expect(projected.totals).toMatchObject({ requests: 1, inputTokens: 11, outputTokens: 5, cachedInputTokens: 7, cacheWriteTokens: 3 })
    expect(definition.wire.view(state)).toEqual(projected)
    expect(definition.wire.view(definition.init({ id: 'other-parent' }, 0)).totals.requests).toBe(0)
    // 原生记录会话：seed 挂接归属，final 仍由标准 append 通道结算。
    expect(created).toHaveLength(1)
    expect(created[0]?.id).toBe(`cli-${id}`)
    expect(created[0]?.meta).toMatchObject({ parentSession: owner.id, origin: 'subagent' })
    expect(created[0]?.inheritedEventCount).toBe(0)
    expect(created[0]?.seed).toEqual([
      expect.objectContaining({ type: 'user/message', data: expect.objectContaining({ content: [{ type: 'text', text: '继续刚才的任务' }] }) }),
      expect.objectContaining({ type: 'maestro/cli-child', ignorable: true, data: expect.objectContaining({ taskId: id, parentSessionId: owner.id, childSessionId: `cli-${id}` }) }),
    ])
    expect(created[0]?.events.map(event => event.type)).toEqual(['user/message', 'maestro/cli-child', 'request/context', 'step/start', 'assistant/message'])
    expect(created[0]?.appended.map(event => event.type)).toEqual(['request/context', 'step/start', 'assistant/message'])
    expect(created[0]?.events.find(event => event.type === 'request/context')?.data).toEqual({ provider: 'wb', model: 'gpt-6.1' })
    expect(created[0]?.events.find(event => event.type === 'assistant/message')?.data).toMatchObject({
      message: { source: { kind: 'model', provider: 'wb', model: 'gpt-6.1' }, content: [{ type: 'text', text: 'claude 收到，继续完成' }] },
      usage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 3 },
    })
  })
})

describe('handleTaskReply runs the continuation', () => {
  it('starts a chained claude resume task and answers with its id', async () => {
    const { deps, registry, launches } = makeDeps()
    seedContinuable(registry)
    const outcome = handleTaskReply(deps, { id: 'task-1', text: '把刚才的改动补上测试', sessions: ['s1'], model: 'wb::gpt-6.1', thinking: 'high' })
    expect(outcome.status).toBe(200)
    const { id } = outcome.body as { id: string }
    expect(id).toMatch(/^task-/)
    expect(id).not.toBe('task-1')
    const reply = await untilSettled(registry, id)
    // 链回原任务、继承归属会话与 cwd，难度说明换成续接说明。
    expect(reply?.replyTo).toBe('task-1')
    expect(reply?.sessionId).toBe('s1')
    expect(reply?.prompt).toBe('把刚才的改动补上测试')
    expect(reply?.phase).toBe('done')
    // sessionRef 在 summary 上（stats 契约），任务记录本身不带它。
    expect(registry.list().find(task => task.id === id)?.sessionRef).toBe('s-next')
    expect(reply?.model).toBe('gpt-6.1')
    // resume 标志真的传给了 claude 子进程。
    const resumeLaunch = launches.find(child => child.spawnArgs.includes('--resume'))
    expect(resumeLaunch?.spawnArgs).toContain('s-first')
    // 续接说明写进了事件流，难度门槛没有被重新检查。
    expect(reply?.events.some(event => event.text.includes('会话续接（回复 task-1）'))).toBe(true)
    expect(reply?.events.some(event => event.text.includes('难度评估'))).toBe(false)
    // 任务列表里能看到回复链与会话引用（会话页靠它串链）。
    const list = (handleTasks(deps, undefined, { sessionId: 's1' }).body as { tasks: MaestroTaskSummary[] }).tasks
    const summary = list.find(task => task.id === id)
    expect(summary?.replyTo).toBe('task-1')
    expect(summary?.sessionRef).toBe('s-next')
    // detail 携带 prompt（会话页的用户气泡）；sessionRef 在 summary 上（stats 契约）。
    const detail = handleTaskDetail(deps, new URLSearchParams(`id=${id}&cursor=0`), { sessionId: 's1' })
    expect(detail.status).toBe(200)
    expect(detail.body).toMatchObject({ prompt: '把刚才的改动补上测试' })
    const detailSummary = (detail.body as { summary: MaestroTaskSummary }).summary
    expect(detailSummary.sessionRef).toBe('s-next')
  })

  it('fails loudly when no dsh model route exists and none is picked', async () => {
    const { deps, registry } = makeDeps()
    deps.readConfig().claude.dshModel = ''
    seedContinuable(registry)
    const outcome = handleTaskReply(deps, { id: 'task-1', text: '继续' })
    expect(outcome.status).toBe(200)
    const { id } = outcome.body as { id: string }
    const reply = await untilSettled(registry, id)
    // HTTP 回复没有主代理模型可沿用，配置页模型也没设 → 不静默回退到 CLI 自身
    // 配置，直接失败并指路（与派发的既定模型语义一致）。
    expect(reply?.phase).toBe('failed')
    expect(reply?.error).toContain('配置页未设置')
  })

  it('refuses a disabled original CLI without falling back to another executor', () => {
    const config = effectiveOf({ claudeMinTaskDifficulty: 'extreme', claudeEnabled: false, claudeCliPath: process.execPath, codexCliPath: process.execPath })
    const { deps, registry, launches } = makeDeps(config)
    seedContinuable(registry)
    const outcome = handleTaskReply(deps, { id: 'task-1', text: '继续', model: 'wb::gpt-6.1' })
    expect(outcome.status).toBe(409)
    expect(launches).toHaveLength(0)
    expect(registry.list()).toHaveLength(1)
  })

  it('resolves an explicit dsh model selection into the child endpoint', async () => {
    const { deps, registry } = makeDeps()
    const resolveDshModel = vi.fn(async (selection: string) => {
      expect(selection).toBe('wb::gpt-6.1')
      return { provider: 'wb', model: 'gpt-6.1', api: 'anthropic-messages' as const, baseURL: 'https://wb.example/v1', apiKey: 'k' }
    })
    const depsWithResolver = { ...deps, resolveDshModel }
    seedContinuable(registry)
    const outcome = handleTaskReply(depsWithResolver, { id: 'task-1', text: '继续', model: 'wb::gpt-6.1' })
    expect(outcome.status).toBe(200)
    const { id } = outcome.body as { id: string }
    const reply = await untilSettled(registry, id)
    expect(resolveDshModel).toHaveBeenCalledWith('wb::gpt-6.1')
    expect(reply?.model).toBe('gpt-6.1')
    expect(reply?.phase).toBe('done')
  })

  it('fails loudly when the picked dsh model cannot resolve', async () => {
    const { deps, registry } = makeDeps()
    const depsWithResolver = {
      ...deps,
      resolveDshModel: async () => { throw new Error('dsh 供应商 "wb" 不存在（可能已被移除）') },
    }
    seedContinuable(registry)
    const outcome = handleTaskReply(depsWithResolver, { id: 'task-1', text: '继续', model: 'wb::gone' })
    expect(outcome.status).toBe(200)
    const { id } = outcome.body as { id: string }
    const reply = await untilSettled(registry, id)
    expect(reply?.phase).toBe('failed')
    expect(reply?.error).toContain('wb')
  })

  it('inherits the conversation model when the reply carries no model', async () => {
    const { deps, registry, launches } = makeDeps()
    seedWithConversationModel(registry)
    const outcome = handleTaskReply(deps, { id: 'task-1', text: '继续' })
    expect(outcome.status).toBe(200)
    const { id } = outcome.body as { id: string }
    const reply = await untilSettled(registry, id)
    // 与 dsh 子智能体的子会话同一条语义：续发接着上一轮的模型聊（wb::gpt-6.1
    // → gpt-6.1），事件流说明来源，绝不落到 CLI 自身配置。
    expect(reply?.phase).toBe('done')
    expect(reply?.model).toBe('gpt-6.1')
    expect(reply?.events.some(event => event.text.includes('沿用会话模型：wb::gpt-6.1'))).toBe(true)
    // resume 标志与会话模型都落到了这一轮的记录上：链条可以继续继承。
    expect(launches.some(child => child.spawnArgs.includes('--resume'))).toBe(true)
    expect(registry.get(id)?.stats?.['dshModel']).toBe('wb::gpt-6.1')
  })

  it('an explicit model on the reply still outranks the inherited one', async () => {
    const { deps, registry } = makeDeps()
    const resolveDshModel = vi.fn(async (selection: string) => {
      expect(selection).toBe('wb::gpt-6.1')
      return { provider: 'wb', model: 'gpt-6.1', api: 'anthropic-messages' as const, baseURL: 'https://wb.example/v1', apiKey: 'k' }
    })
    const depsWithResolver = { ...deps, resolveDshModel: resolveDshModel as typeof deps.resolveDshModel }
    seedWithConversationModel(registry, 'wb::gpt-6.1')
    // makeDeps 的解析器只认 wb::gpt-6.1：显式传同一可解析值，验证解析调用
    // 用的是显式选择（而非继承值被优先）。
    const outcome = handleTaskReply(depsWithResolver, { id: 'task-1', text: '继续', model: 'wb::gpt-6.1' })
    expect(outcome.status).toBe(200)
    const { id } = outcome.body as { id: string }
    const reply = await untilSettled(registry, id)
    expect(resolveDshModel).toHaveBeenCalledWith('wb::gpt-6.1')
    // 显式选择不算「沿用」：措辞是会话页选择。
    expect(reply?.events.some(event => event.text.includes('使用会话页选择的 dsh 模型'))).toBe(true)
  })

  it('resumes a codex thread through exec resume', async () => {
    const registry = new TaskRegistry()
    const controllers = new Map<string, AbortController>()
    const spawn = transcriptSpawn('codex')
    const deps = {
      readConfig: () => withTestDshRoutes(effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath })),
      resolveDshModel: resolveTestDshModel,
      registry,
      limiter: new Limiter(() => 2),
      controllers,
      pathCache: new CliPathCache(() => effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath }), spawn.spawnFn),
      spawnFn: spawn.spawnFn,
      toolName: () => 'dispatch_cli_task',
    }
    seedContinuable(registry, 'task-c', 'codex')
    const outcome = handleTaskReply(deps, { id: 'task-c', text: '继续 codex 的一轮' })
    expect(outcome.status).toBe(200)
    const { id } = outcome.body as { id: string }
    const reply = await untilSettled(registry, id)
    expect(reply?.phase).toBe('done')
    expect(registry.list().find(task => task.id === id)?.sessionRef).toBe('s-next')
    const launch = spawn.launches.find(child => child.spawnArgs[0] === 'exec' && child.spawnArgs[1] === 'resume')
    expect(launch?.spawnArgs).toContain('t-first')
  })
})

describe('runDispatch reply semantics', () => {
  it('records replyTo on the task and skips pickCli entirely', async () => {
    const config = effectiveOf({ claudeCliPath: process.execPath, codexCliPath: process.execPath })
    const registry = new TaskRegistry()
    const controllers = new Map<string, AbortController>()
    const spawn = transcriptSpawn()
    seedContinuable(registry)
    const value = await runDispatch({
      readConfig: () => withTestDshRoutes(config),
      resolveDshModel: resolveTestDshModel,
      registry,
      limiter: new Limiter(() => 2),
      controllers,
      pathCache: new CliPathCache(() => config, spawn.spawnFn),
      spawnFn: spawn.spawnFn,
    }, { cli: 'claude', sessionId: 's1', cwd: '/work/repo', task: '续发指令', replyTo: 'task-1', resume: 's-first' }, new AbortController().signal)
    expect(value.ok).toBe(true)
    const reply = registry.list().find(task => task.replyTo === 'task-1')
    expect(reply?.replyTo).toBe('task-1')
    expect(reply?.sessionRef).toBe('s-next')
  })
})

describe('buildChain', () => {
  const summary = (id: string, replyTo: string | undefined, startedAt: number): MaestroTaskSummary => ({
    id, cli: 'claude', title: id, phase: 'done', model: '', startedAt,
    ...(replyTo === undefined ? {} : { replyTo }),
  })
  const summaries: Record<string, MaestroTaskSummary> = {
    root: summary('root', undefined, 1),
    mid: summary('mid', 'root', 2),
    tail: summary('tail', 'mid', 3),
    late: summary('late', 'mid', 4),
    unrelated: summary('unrelated', undefined, 5),
  }

  it('walks up from the opened task and follows replies downward', () => {
    // 会话页的链是线性的：一个任务同一时刻只有一条回复在跑；若数据里真出现
    // 兄弟回复，取最早的一条，链不分叉。
    expect(buildChain('tail', summaries)).toEqual(['root', 'mid', 'tail'])
    expect(buildChain('mid', summaries)).toEqual(['root', 'mid', 'tail'])
    expect(buildChain('root', summaries)).toEqual(['root', 'mid', 'tail'])
    expect(buildChain('unrelated', summaries)).toEqual(['unrelated'])
  })

  it('guards against cycles and missing tasks', () => {
    const cyclic: Record<string, MaestroTaskSummary> = {
      a: summary('a', 'b', 1),
      b: summary('b', 'a', 2),
    }
    expect(buildChain('a', cyclic).sort()).toEqual(['a', 'b'])
    expect(buildChain('missing', summaries)).toEqual(['missing'])
  })
})

describe('replyAnchorOf', () => {
  const turn = (id: string, sessionRef?: string): MaestroTaskSummary => ({
    id, cli: 'claude', title: id, phase: 'done', model: '', startedAt: 1,
    ...(sessionRef === undefined ? {} : { sessionRef }),
  })
  const chain = ['root', 'mid', 'tail']

  it('walks back from the tail to the nearest turn with a session reference', () => {
    // 尾轮失败/超时常常没拿到引用（CLI 没走到结算），会话不该因此卡死：
    // 退回最近一个可续接的轮次，claude/codex 都能从历史轮次接着 resume。
    const summaries: Record<string, MaestroTaskSummary> = { root: turn('root', 's-root'), mid: turn('mid', 's-mid') }
    expect(replyAnchorOf(chain, summaries)).toBe('mid')
    summaries['tail'] = turn('tail', 's-tail')
    expect(replyAnchorOf(chain, summaries)).toBe('tail')
  })

  it('returns undefined when nothing on the chain is continuable', () => {
    expect(replyAnchorOf([], {})).toBeUndefined()
    expect(replyAnchorOf(['a'], { a: turn('a') })).toBeUndefined()
    // 摘要还没轮询到的 id（刚派发）不算可续接，但也不影响更早的轮次。
    expect(replyAnchorOf(['root', 'pending'], { root: turn('root', 's-root') })).toBe('root')
  })
})
