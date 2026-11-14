import { describe, expect, it } from 'vitest'
import { runClaudeTask } from '../src/channels/claude.js'
import { runCodexTask } from '../src/channels/codex.js'
import { scriptedSpawn } from './fake-child.js'
import { cliUsageRecordOf } from '../src/usage.js'

const SESSION = '11111111-2222-4333-8444-555555555555'
const claudeUsage = { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 }
const claudeMeasured = { inputTokens: 11, outputTokens: 7, cachedInputTokens: 5, cacheWriteTokens: 3, usageInputSemantics: 'uncached' }
const codexUsage = { input_tokens: 19, cached_input_tokens: 5, cache_write_input_tokens: 3, output_tokens: 7 }
const codexMeasured = { inputTokens: 11, outputTokens: 7, cachedInputTokens: 5, cacheWriteTokens: 3, usageInputSemantics: 'uncached' }
const line = (frame: Record<string, unknown>) => JSON.stringify(frame) + '\n'
const claudeSuccess = (overrides: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'final answer', session_id: SESSION, usage: claudeUsage, ...overrides })
const codexAnswer = { type: 'item.completed', item: { type: 'agent_message', text: 'partial or final answer' } }

async function claudeRun(frames: Record<string, unknown>[], code = 0, observer = false) {
  const seen: Record<string, string | number | boolean>[] = []
  const fake = scriptedSpawn(child => { child.finish(frames.map(line).join(''), code) })
  const result = await runClaudeTask({ spawnFn: fake.spawnFn, claudePath: '__fake_claude__', task: 'scoped terminal fixture', cwd: undefined, model: '', permissionMode: 'inherit', baseUrl: '', authToken: '', timeoutMs: 5000, signal: new AbortController().signal, onEvent: () => {}, ...(observer ? { onUsage: (value: Record<string, string | number | boolean>) => { seen.push(value) } } : {}) })
  return { result, seen }
}

async function codexRun(frames: Record<string, unknown>[], code = 0) {
  const fake = scriptedSpawn(child => { child.finish(frames.map(line).join(''), code) })
  return runCodexTask({ spawnFn: fake.spawnFn, codexPath: '__fake_codex__', task: 'scoped terminal fixture', cwd: undefined, model: '', sandbox: 'read-only', baseUrl: '', apiKey: '', timeoutMs: 5000, signal: new AbortController().signal, onEvent: () => {} })
}

describe('Claude Code strict terminal result contract', () => {
  it('accepts an explicit valid success, with authoritative totals and identity', async () => {
    const { result } = await claudeRun([claudeSuccess()])
    expect(result).toMatchObject({ ok: true, finalText: 'final answer', sessionId: SESSION, exitCode: 0 })
    expect(result.stats).toMatchObject(claudeMeasured)
    expect(result.error).toBeUndefined()
  })

  it.each([
    ['error subtype with false flag', { subtype: 'error_max_turns' }],
    ['unknown subtype', { subtype: 'future_terminal' }],
    ['missing subtype', { subtype: undefined }],
    ['null subtype', { subtype: null }],
    ['numeric subtype', { subtype: 7 }],
    ['true error flag', { is_error: true }],
    ['missing error flag', { is_error: undefined }],
    ['null error flag', { is_error: null }],
    ['string error flag', { is_error: 'false' }],
    ['numeric error flag', { is_error: 0 }],
    ['empty result', { result: '' }],
    ['whitespace result', { result: ' \t\n' }],
    ['missing result', { result: undefined }],
    ['null result', { result: null }],
    ['numeric result', { result: 42 }],
  ] satisfies Array<[string, Record<string, unknown>]>)('rejects %s without erasing measured usage or the session', async (_name, overrides) => {
    const { result } = await claudeRun([claudeSuccess(overrides)])
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.sessionId).toBe(SESSION)
    expect(result.stats).toMatchObject(claudeMeasured)
    expect(result.exitCode).toBe(0)
  })

  it.each([
    ['declared failure', { subtype: 'error_during_execution', is_error: true, result: 'declared terminal failure' }],
    ['empty failure', { subtype: 'error_max_turns', is_error: true, result: '' }],
    ['invalid false-like flag', { is_error: 'false' }],
    ['empty success', { result: ' ' }],
  ] satisfies Array<[string, Record<string, unknown>]>)('does not let a later valid success overwrite %s', async (_name, failure) => {
    const { result } = await claudeRun([claudeSuccess(failure), claudeSuccess({ result: 'later answer', usage: undefined })])
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.finalText).toBe('later answer')
    expect(result.sessionId).toBe(SESSION)
    expect(result.stats).toMatchObject(claudeMeasured)
  })

  it('rejects a failure after success instead of retaining the earlier success state', async () => {
    const { result } = await claudeRun([claudeSuccess(), claudeSuccess({ subtype: 'error_during_execution', is_error: true, result: 'last terminal failure', usage: { output_tokens: 9 } })])
    expect(result.ok).toBe(false)
    expect(result.error).toContain('last terminal failure')
    expect(result.stats).toMatchObject({ ...claudeMeasured, outputTokens: 9 })
  })

  it('allows repeated valid totals without double counting them', async () => {
    const { result } = await claudeRun([claudeSuccess(), claudeSuccess({ result: 'confirmed answer', usage: { ...claudeUsage, output_tokens: 9 } })])
    expect(result.ok).toBe(true)
    expect(result.finalText).toBe('confirmed answer')
    expect(result.stats).toMatchObject({ ...claudeMeasured, outputTokens: 9 })
  })

  it('keeps tool-level failure recoverable when the overall result succeeds', async () => {
    const { result } = await claudeRun([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id: 't1' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'retryable tool error' }] } },
      claudeSuccess(),
    ])
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it.each([false, true])('retains streamed spend without a result (observer=%s)', async observer => {
    const { result, seen } = await claudeRun([
      { type: 'system', subtype: 'init', session_id: SESSION },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'work in progress' }], usage: claudeUsage } },
    ], 0, observer)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('未返回文本结果')
    expect(result.sessionId).toBe(SESSION)
    expect(result.stats).toMatchObject(claudeMeasured)
    expect(seen).toHaveLength(observer ? 1 : 0)
  })

  it.each(['cancel', 'timeout'] as const)('retains streamed spend and identity on %s before a terminal result', async ending => {
    const controller = new AbortController()
    const fake = scriptedSpawn(child => {
      child.onStdin = () => {
        child.stdout.emit('data', Buffer.from(line({ type: 'system', subtype: 'init', session_id: SESSION }) + line({ type: 'assistant', message: { usage: claudeUsage } })))
        if (ending === 'cancel') controller.abort()
      }
    })
    const result = await runClaudeTask({ spawnFn: fake.spawnFn, claudePath: '__fake_claude__', task: 'cancelled terminal fixture', cwd: undefined, model: '', permissionMode: 'inherit', baseUrl: '', authToken: '', timeoutMs: ending === 'timeout' ? 20 : 5000, signal: controller.signal, onEvent: () => {} })
    expect(result.ok).toBe(false)
    expect(result.sessionId).toBe(SESSION)
    expect(result.stats).toMatchObject(claudeMeasured)
    if (ending === 'timeout') expect(result.stats['timedOut']).toBe(true)
    else expect(result.error).toContain('取消')
  })

  it('retains streamed samples as partial known spend, not a fabricated whole-run total', async () => {
    const { result } = await claudeRun([
      { type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 2 } } },
      { type: 'assistant', message: { usage: { input_tokens: 20, output_tokens: 3 } } },
    ])
    expect(result.stats).toMatchObject({ inputTokens: 20, outputTokens: 5, usagePartial_inputTokens: true, usagePartial_outputTokens: true })
    const record = cliUsageRecordOf({ id: 'partial-test', cli: 'claude', model: 'test', phase: 'failed', startedAt: 1, endedAt: 2, stats: result.stats })
    expect(record).toMatchObject({ inputTokens: null, outputTokens: null, knownTokens: { inputTokens: 20, outputTokens: 5 } })
  })

  it('uses authoritative result buckets while leaving omitted streamed buckets explicitly partial', async () => {
    const { result } = await claudeRun([
      { type: 'assistant', message: { usage: claudeUsage } },
      claudeSuccess({ usage: { output_tokens: 9 } }),
    ])
    expect(result.ok).toBe(true)
    expect(result.stats).toMatchObject({ outputTokens: 9, inputTokens: 11, usagePartial_inputTokens: true, usagePartial_cachedInputTokens: true, usagePartial_cacheWriteTokens: true })
    expect(result.stats['usagePartial_outputTokens']).toBeUndefined()
  })

  it('does not allow an explicit success to win a cancellation race', async () => {
    const controller = new AbortController()
    const fake = scriptedSpawn(child => {
      child.onStdin = () => {
        child.stdout.emit('data', Buffer.from(line(claudeSuccess())))
        controller.abort()
      }
    })
    const result = await runClaudeTask({ spawnFn: fake.spawnFn, claudePath: '__fake_claude__', task: 'cancel race', cwd: undefined, model: '', permissionMode: 'inherit', baseUrl: '', authToken: '', timeoutMs: 5000, signal: controller.signal, onEvent: () => {} })
    expect(result.ok).toBe(false)
    expect(result.sessionId).toBe(SESSION)
    expect(result.stats).toMatchObject(claudeMeasured)
    expect(result.error).toContain('取消')
  })
})

describe('terminal protocol transport integrity', () => {
  it.each(['claude', 'codex'] as const)('rejects %s stdout errors after a valid terminal even with exit 0', async cli => {
    const fake = scriptedSpawn(child => {
      child.onStdin = () => {
        queueMicrotask(() => {
          const frames = cli === 'claude' ? [claudeSuccess()] : [{ type: 'thread.started', thread_id: SESSION }, codexAnswer, { type: 'turn.completed', usage: codexUsage }]
          child.stdout.emit('data', Buffer.from(frames.map(line).join('')))
          child.stdout.emit('error', new Error('synthetic stdout transport failure'))
          child.finish('')
        })
      }
    })
    const common = { spawnFn: fake.spawnFn, task: 'terminal transport fixture', cwd: undefined, model: '', baseUrl: '', timeoutMs: 5000, signal: new AbortController().signal, onEvent: () => {} }
    const result = cli === 'claude'
      ? await runClaudeTask({ ...common, claudePath: '__fake_claude__', permissionMode: 'inherit', authToken: '' })
      : await runCodexTask({ ...common, codexPath: '__fake_codex__', sandbox: 'read-only', apiKey: '' })
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.error).toContain('stdout 协议流失败')
    expect(result.stats).toMatchObject(cli === 'claude' ? claudeMeasured : codexMeasured)
    expect('sessionId' in result ? result.sessionId : result.threadId).toBe(SESSION)
    expect(result.finalText).not.toBe('')
  })
})

describe('Codex exec authoritative completion contract', () => {
  it('requires turn.completed in addition to a nonempty answer and exit 0', async () => {
    const result = await codexRun([codexAnswer, { type: 'turn.completed', usage: codexUsage }])
    expect(result.ok).toBe(true)
    expect(result.stats).toMatchObject(codexMeasured)
  })

  it.each([
    ['answer only', [codexAnswer]],
    ['legacy msg answer only', [{ msg: { type: 'agent_message', message: 'legacy visible answer' } }]],
    ['unverified legacy task_complete', [{ msg: { type: 'agent_message', message: 'legacy visible answer' } }, { msg: { type: 'task_complete' } }]],
    ['unverified app-server turn/completed', [codexAnswer, { method: 'turn/completed', params: { turn: { status: 'completed' } } }]],
    ['interrupted turn', [codexAnswer, { type: 'turn.interrupted' }]],
  ] satisfies Array<[string, Record<string, unknown>[]]>)('rejects %s as completion evidence', async (_name, frames) => {
    const result = await codexRun(frames)
    expect(result.ok).toBe(false)
    expect(result.finalText).not.toBe('')
    expect(result.error).toContain('缺少 turn.completed')
  })

  it('keeps legacy message display compatible when an actual exec completion exists', async () => {
    const result = await codexRun([{ msg: { type: 'agent_message', message: 'legacy visible answer' } }, { type: 'turn.completed' }])
    expect(result.ok).toBe(true)
    expect(result.finalText).toBe('legacy visible answer')
  })

  it('does not let a later completed turn overwrite an already failed terminal', async () => {
    const result = await codexRun([codexAnswer, { type: 'turn.failed', error: { message: 'declared terminal failure' }, usage: codexUsage }, { type: 'turn.completed', usage: { output_tokens: 9 } }])
    expect(result.ok).toBe(false)
    expect(result.error).toContain('declared terminal failure')
    expect(result.stats).toMatchObject({ ...codexMeasured, outputTokens: 9 })
  })

  it('keeps command/item failures recoverable before an actual completed turn', async () => {
    const result = await codexRun([
      { type: 'item.completed', item: { type: 'command_execution', command: 'retryable', exit_code: 1 } },
      { type: 'item.completed', item: { type: 'error', message: 'recoverable item failure' } },
      codexAnswer,
      { type: 'turn.completed', usage: codexUsage },
    ])
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('keeps stream retry recovery but rejects a late unresolved stream error', async () => {
    const recovered = await codexRun([{ type: 'error', message: 'retry diagnostic' }, codexAnswer, { type: 'turn.completed' }])
    expect(recovered.ok).toBe(true)
    const failed = await codexRun([codexAnswer, { type: 'turn.completed' }, { type: 'error', message: 'late stream failure' }])
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('late stream failure')
  })

  it('retains the thread and measured spend when completion is absent', async () => {
    const result = await codexRun([{ type: 'thread.started', thread_id: SESSION }, { ...codexAnswer, usage: codexUsage }])
    expect(result.ok).toBe(false)
    expect(result.threadId).toBe(SESSION)
    expect(result.stats).toMatchObject(codexMeasured)
    expect(result.error).toContain('缺少 turn.completed')
  })

  it.each(['cancel', 'timeout'] as const)('retains the thread and measured spend on %s', async ending => {
    const controller = new AbortController()
    const fake = scriptedSpawn(child => {
      child.onStdin = () => {
        child.stdout.emit('data', Buffer.from(line({ type: 'thread.started', thread_id: SESSION }) + line({ ...codexAnswer, usage: codexUsage })))
        if (ending === 'cancel') controller.abort()
      }
    })
    const result = await runCodexTask({ spawnFn: fake.spawnFn, codexPath: '__fake_codex__', task: 'cancelled terminal fixture', cwd: undefined, model: '', sandbox: 'read-only', baseUrl: '', apiKey: '', timeoutMs: ending === 'timeout' ? 20 : 5000, signal: controller.signal, onEvent: () => {} })
    expect(result.ok).toBe(false)
    expect(result.threadId).toBe(SESSION)
    expect(result.stats).toMatchObject(codexMeasured)
    if (ending === 'timeout') expect(result.stats['timedOut']).toBe(true)
    else expect(result.error).toContain('取消')
  })
})
