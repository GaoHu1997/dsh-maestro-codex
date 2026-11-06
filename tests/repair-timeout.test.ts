import { describe, expect, it } from 'vitest'
import { Config, effectiveOf, readVolatile, validateConfig } from '../src/config.js'
import { handleHint, type RouteDeps } from '../src/routes.js'
import { summarizeUsage } from '../src/client/usage-panel.js'
import type { CliUsageState } from '../src/usage.js'
import { CliPathCache, runDispatch, type DispatchDeps } from '../src/dispatch.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { scriptedSpawn } from './fake-child.js'
import { resolveTestDshModel, withTestDshRoutes } from './dsh-route-fixture.js'

describe('DSH-NEW-P2-TIMEOUT-001：公共配置schema保留缺失身份', () => {
  it.each([
    [{ claudeTimeoutMinutes: 10, codexTimeoutMinutes: 45 }, 45],
    [{ claudeTimeoutMinutes: 10 }, 10],
    [{ codexTimeoutMinutes: 45 }, 45],
    [{}, 20],
    [{ timeoutMinutes: 20, claudeTimeoutMinutes: 10, codexTimeoutMinutes: 45 }, 20],
    [{ timeoutMinutes: 35, codexTimeoutMinutes: 45 }, 35],
  ] as const)('公共Config→effectiveOf→handleHint：%j 得 %s', (raw, expected) => {
    const parsed = Config(raw) as Config
    expect(() => validateConfig(parsed)).not.toThrow()
    expect(effectiveOf(parsed).timeoutMinutes).toBe(expected)
    const deps = { readConfig: () => effectiveOf(parsed), toolName: () => 'dispatch_cli_task' } as RouteDeps
    const result = handleHint(deps)
    expect(result.status).toBe(200)
    expect((result.body as { redacted: { timeoutMinutes: number } }).redacted.timeoutMinutes).toBe(expected)
    if (!('timeoutMinutes' in raw)) expect(readVolatile(parsed.timeoutMinutes)).toBeUndefined()
  })
  it.each([0, -1, 241, 1.5, NaN, Infinity])('无效统一超时%s明确拒绝，不静默迁移legacy', value => {
    expect(() => { const parsed = Config({ timeoutMinutes: value, codexTimeoutMinutes: 45 }) as Config; validateConfig(parsed) }).toThrow()
  })
  it('公共schema拒绝错误类型，并保留volatile合同', () => {
    expect(() => Config({ timeoutMinutes: '20' })).toThrow()
    expect(Config.dict.timeoutMinutes.meta.volatile).toBe(true)
    let explicit: number | undefined
    let legacy = 45
    const parsed = Config({ codexTimeoutMinutes: 45 }) as Config
    parsed.timeoutMinutes = { get: () => explicit } as unknown as NonNullable<Config['timeoutMinutes']>
    parsed.codexTimeoutMinutes = { get: () => legacy } as unknown as NonNullable<Config['codexTimeoutMinutes']>
    const deps = { readConfig: () => effectiveOf(parsed), toolName: () => 'dispatch_cli_task' } as RouteDeps
    const hint = () => (handleHint(deps).body as { redacted: { timeoutMinutes: number } }).redacted.timeoutMinutes
    expect(hint()).toBe(45)
    explicit = 20; expect(hint()).toBe(20)
    explicit = 35; expect(hint()).toBe(35)
    explicit = undefined; legacy = 10; expect(hint()).toBe(10)
    legacy = 0; expect(() => validateConfig(parsed)).toThrow(/codexTimeoutMinutes/)
  })
})

it('单任务timeoutMinutes覆盖公共迁移值，不回退legacy或默认', async () => {
  const parsed = Config({ claudeTimeoutMinutes: 10, codexTimeoutMinutes: 45, claudeCliPath: process.execPath, codexCliPath: process.execPath, injectGitContext: false, bridgeSkills: false }) as Config
  const config = withTestDshRoutes(effectiveOf(parsed))
  expect(config.timeoutMinutes).toBe(45)
  const spawn = scriptedSpawn(child => {
    if (child.spawnArgs[0] === '--version') child.finish('codex 0.166.0')
    else child.onStdin = () => child.finish(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'synthetic done' } }) + '\n' + JSON.stringify({ type: 'turn.completed' }))
  })
  const registry = new TaskRegistry()
  const deps: DispatchDeps = { readConfig: () => config, registry, pathCache: new CliPathCache(() => config, spawn.spawnFn), spawnFn: spawn.spawnFn, controllers: new Map(), limiter: new Limiter(() => 1), resolveDshModel: resolveTestDshModel, preflightDshModel: async () => ({ status: 'ok', detail: 'synthetic' }) }
  const result = await runDispatch(deps, { cli: 'codex', task: 'controlled timeout override', taskDifficulty: 'medium', difficultyReason: 'Controlled public configuration and per-task override regression', timeoutMinutes: 35, cwd: process.cwd() }, new AbortController().signal)
  expect(result.ok).toBe(true)
  const id = registry.list()[0]!.id
  const page = registry.eventsSince(id, 0)
  expect(page?.events.some(event => event.text.includes('连续无输出超时 35 分钟'))).toBe(true)
  expect(page?.events.some(event => event.text.includes('连续无输出超时 45 分钟'))).toBe(false)
})

it('REVERIFY-FIXTURE-001：missing/malformed CLI继续被排除，不制造unknown记录', () => {
  const now = Date.now()
  const broken = { recent: [{ startedAt: now }, { startedAt: now, cli: 'invalid' }], totals: {} } as unknown as CliUsageState
  const summary = summarizeUsage([broken], now)
  expect(summary.requests).toBe(0)
  expect(summary.inputTokens).toBe(0)
})
