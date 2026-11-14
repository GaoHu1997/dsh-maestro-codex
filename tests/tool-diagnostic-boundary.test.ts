import { beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { effectiveOf } from '../src/config.js'
import { CliPathCache, type DispatchValue } from '../src/dispatch.js'
import { cliFailureDiagnostic } from '../src/public-diagnostics.js'
import { modelDispatchValue, registerDispatchTool, renderSummary, type ToolExec } from '../src/tool.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { clearCliUsageMirrors, cliUsageProjectionDefinition } from '../src/usage.js'
import { scriptedSpawn } from './fake-child.js'
import { resolveTestDshModel, withTestDshRoutes } from './dsh-route-fixture.js'

const secret = 'SYNTHETIC_PRIVATE_DIAGNOSTIC_TOKEN'
const failed: DispatchValue = {
  ok: false, taskId: 'task-owned', phase: 'failed', cli: 'codex', model: 'synthetic-model',
  cwd: process.cwd(), durationMs: 500, exitCode: 1, sessionRef: 'thread-owned',
  error: `ECONNRESET Bearer ${secret} at https://user:${secret}@provider.invalid/?key=${secret}`,
  finalText: `partial product error ${secret}`, notes: [`raw stderr ${secret}`],
}

beforeEach(() => { clearCliUsageMirrors() })

describe('model-only failure projection', () => {
  it('keeps recovery identity but excludes raw error, partial failure text and notes from the schema value', () => {
    const safe = modelDispatchValue(failed)
    expect(JSON.stringify(safe)).not.toContain(secret)
    expect(safe).toMatchObject({ ok: false, phase: 'failed', taskId: failed.taskId, sessionRef: failed.sessionRef, exitCode: 1, finalText: '' })
    expect(safe.error).toContain('category=transport')
    expect(failed.finalText).toContain(secret)
    expect(failed.notes[0]).toContain(secret)
  })

  it('does not mutate or abbreviate a successful answer and its canonical notes', () => {
    const success = { ...failed, ok: true, phase: 'done' as const }
    expect(modelDispatchValue(success)).toBe(success)
  })

  it('also protects renderSummary when its caller has a raw canonical failed value', () => {
    const rendered = renderSummary(failed)
    expect(rendered).not.toContain(secret)
    expect(rendered).toContain('category=transport')
    expect(rendered).toContain('taskId=task-owned')
    expect(rendered).toContain('resume="thread-owned"')
    expect(rendered).toContain('任务详情')
  })

  it.each([
    ['cancelled', 'raw unknown', 'cancelled'], ['timeout', 'raw unknown', 'timeout'],
    ['interrupted', 'raw unknown', 'interrupted'], ['failed', '401 invalid api key', 'authentication'],
    ['failed', '429 rate limit', 'rate-limit'], ['failed', 'permission denied', 'access-policy'],
    ['failed', 'CLI 未返回最终答复', 'invalid-result'], ['failed', secret, 'process'],
  ])('publishes fixed facts for phase=%s and %s', (phase, error, category) => {
    const diagnostic = cliFailureDiagnostic({ phase, error: `${error} ${secret}`, exitCode: 1 })
    expect(diagnostic).toContain(`category=${category}`)
    expect(diagnostic).not.toContain(secret)
    expect(Buffer.byteLength(diagnostic, 'utf8')).toBeLessThan(4096)
  })

  it('never echoes an unknown phase or non-finite exit code', () => {
    const diagnostic = cliFailureDiagnostic({ phase: secret, error: secret, exitCode: NaN })
    expect(diagnostic).not.toContain(secret)
    expect(diagnostic).not.toContain('NaN')
  })
})

describe('registered tool result boundary', () => {
  it('preserves authorized task diagnostics and usage while returning only safe failure to the parent model', async () => {
    const config = withTestDshRoutes(effectiveOf({ codexCliPath: process.execPath }))
    const registry = new TaskRegistry()
    const child = scriptedSpawn(process => {
      if (process.spawnArgs.includes('--version')) process.finish('codex 0.153.4')
      else process.finish([
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-owned' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `partial ${secret}` } }),
        JSON.stringify({ type: 'turn.failed', error: { message: `ECONNRESET ${secret}` }, usage: { input_tokens: 11, output_tokens: 5 } }),
      ].join('\n'), 1, `stderr Bearer ${secret}`)
    })
    let tool: { execute(raw: unknown, exec: ToolExec): Promise<DispatchValue> } | undefined
    const ctx = { tools: { register(definition: unknown) { tool = definition as typeof tool; return () => {} } } } as unknown as Context
    registerDispatchTool(ctx, {
      readConfig: () => config, registry, controllers: new Map(), limiter: new Limiter(() => 1),
      spawnFn: child.spawnFn, pathCache: new CliPathCache(() => config, child.spawnFn), resolveDshModel: resolveTestDshModel,
    })
    const parent = { id: 'synthetic-owner', session: { append() {} } }
    const safe = await tool!.execute({ task: '执行并核验', cli: 'codex', task_difficulty: 'medium', difficulty_reason: '多步实现和回归检查' },
      { signal: new AbortController().signal, agent: parent })
    expect(JSON.stringify(safe)).not.toContain(secret)
    expect(safe).toMatchObject({ ok: false, phase: 'failed', sessionRef: 'thread-owned' })
    const task = registry.get(safe.taskId)!
    expect(task.finalText).toContain(secret)
    expect(task.error).toContain(secret)
    expect(task.stats).toMatchObject({ reportedInputTokens: 11, outputTokens: 5, sessionRef: 'thread-owned' })
    const usage = cliUsageProjectionDefinition()
    expect(usage.wire.view(usage.init({ id: parent.id }, 0)).recent).toHaveLength(1)
  })
})
