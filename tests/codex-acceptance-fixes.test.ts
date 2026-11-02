import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexFrameEvents, codexUsageStats, runCodexTask } from '../src/channels/codex.js'
import { mergeCodexUsageStats, sessionDayDir, startRolloutUsageTail, usageFromTotals, type RolloutUsageStats } from '../src/channels/codex-rollout.js'
import { applyCliUsage, cliUsageRecordOf, CLI_USAGE_EVENT, EMPTY_CLI_USAGE } from '../src/usage.js'
import { scriptedSpawn } from './fake-child.js'

const THREAD = 'a1160160-0000-4000-8000-000000000002'
const homes: string[] = []
const previousHome = process.env['CODEX_HOME']
const raw = (input: number, cached: number, write: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write, output_tokens: output })
const line = (usage: object) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage } } }) + '\n'
const sum = (s: RolloutUsageStats) => (s.inputTokens ?? 0) + (s.cachedInputTokens ?? 0) + (s.cacheWriteTokens ?? 0) + (s.outputTokens ?? 0)
function fixture(initial = '') {
  const home = mkdtempSync(join(tmpdir(), 'maestro-codex-acceptance-')); homes.push(home)
  const dir = sessionDayDir(home, new Date(2025, 2, 2)); mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-fixture-${THREAD}.jsonl`); writeFileSync(file, initial)
  return { home, file }
}
afterEach(() => {
  if (previousHome === undefined) delete process.env['CODEX_HOME']; else process.env['CODEX_HOME'] = previousHome
  vi.restoreAllMocks()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

async function runTurn(home: string, file: string, cumulative: object | undefined, turn: object | undefined, resume: boolean, failure = false) {
  process.env['CODEX_HOME'] = home
  const seen: Record<string, string | number | boolean>[] = []
  const notes: string[] = []
  const fake = scriptedSpawn(child => {
    Object.defineProperty(child, 'pid', { value: undefined })
    // The child can append data BEFORE thread.started reaches the host.
    if (cumulative !== undefined) appendFileSync(file, line(cumulative))
    child.finish([
      JSON.stringify({ type: 'thread.started', thread_id: THREAD }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fixture answer' } }),
      JSON.stringify({ type: failure ? 'turn.failed' : 'turn.completed', ...(turn === undefined ? {} : { usage: turn }), ...(failure ? { error: { message: 'synthetic failure' } } : {}) }),
    ].join('\n'), failure ? 1 : 0)
  })
  const result = await runCodexTask({ spawnFn: fake.spawnFn, codexPath: '__synthetic__', task: 'synthetic', cwd: home, model: 'fixture', sandbox: 'read-only', ...(resume ? { resume: THREAD } : {}), timeoutMs: 5000, signal: new AbortController().signal, baseUrl: '', apiKey: '', onEvent: (_kind, text) => notes.push(text), onUsage: value => seen.push(value) })
  expect(fake.launches).toHaveLength(1)
  return { result, seen, notes }
}

describe('Codex acceptance accounting fixes', () => {
  it.each([
    [152974, 126439, 26514, 2266, 21, 155240],
    [127607, 121000, 6595, 1902, 12, 129509],
    [193024, 185356, 7653, 4518, 15, 197542],
    [519152, 456068, 63039, 35827, 45, 554979],
  ])('projects measured cache-write into disjoint buckets (%i inclusive)', (input, cached, write, output, uncached, total) => {
    const usage = raw(input, cached, write, output)
    const frame = codexUsageStats({ usage })
    expect(frame.inputTokens).toBe(uncached)
    expect(sum(frame as RolloutUsageStats)).toBe(total)
    expect(usageFromTotals(usage)).toEqual(frame)
  })

  it('renormalizes when a rollout supplies cache-write omitted by stdout', () => {
    const stdout = usageFromTotals({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 })!
    const rollout = usageFromTotals(raw(100, 40, 3, 10))!
    expect(mergeCodexUsageStats(rollout, stdout)).toMatchObject({ inputTokens: 57, cacheWriteTokens: 3 })
    expect(mergeCodexUsageStats(stdout, rollout)).toMatchObject({ inputTokens: 57, cacheWriteTokens: 3 })
    expect(sum(mergeCodexUsageStats(stdout, rollout))).toBe(110)
  })

  it('keeps newer output when input is unchanged and merges partial cache fields safely', () => {
    const previous = usageFromTotals({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 })!
    const partial = usageFromTotals({ cache_write_input_tokens: 3, output_tokens: 12 })!
    expect(mergeCodexUsageStats(partial, previous)).toMatchObject({ inputTokens: 57, cachedInputTokens: 40, cacheWriteTokens: 3, outputTokens: 12 })
    const final = usageFromTotals(raw(100, 40, 3, 12))!
    expect(sum(mergeCodexUsageStats(previous, final))).toBe(112)
    expect(sum(mergeCodexUsageStats(final, previous))).toBe(112)
  })

  it('rejects pre-cancelled work without starting a CLI process', async () => {
    const { home } = fixture(line(raw(100, 40, 3, 10)))
    process.env['CODEX_HOME'] = home
    const controller = new AbortController(); controller.abort()
    const fake = scriptedSpawn(child => { Object.defineProperty(child, 'pid', { value: undefined }); child.finish() })
    await expect(runCodexTask({ spawnFn: fake.spawnFn, codexPath: '__synthetic__', task: 'synthetic', cwd: home, model: 'fixture', sandbox: 'read-only', resume: THREAD, timeoutMs: 5000, signal: controller.signal, baseUrl: '', apiKey: '', onEvent: () => {} })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fake.launches).toHaveLength(0)
  })

  it('cleans up the pre-launch usage tail when process creation throws', async () => {
    const { home } = fixture(line(raw(100, 40, 3, 10)))
    process.env['CODEX_HOME'] = home
    const cleared = vi.spyOn(globalThis, 'clearInterval')
    const failure = new Error('synthetic spawn failure')
    await expect(runCodexTask({ spawnFn: () => { throw failure }, codexPath: '__synthetic__', task: 'synthetic', cwd: home, model: 'fixture', sandbox: 'read-only', resume: THREAD, timeoutMs: 5000, signal: new AbortController().signal, baseUrl: '', apiKey: '', onEvent: () => {} })).rejects.toBe(failure)
    expect(cleared).toHaveBeenCalledTimes(1)
  })

  it('counts only new consumption across three turns and their canonical records', async () => {
    const { home, file } = fixture()
    const first = await runTurn(home, file, raw(100, 40, 3, 10), raw(100, 40, 3, 10), false)
    const second = await runTurn(home, file, raw(120, 48, 4, 12), raw(20, 8, 1, 2), true)
    const third = await runTurn(home, file, raw(150, 58, 6, 15), raw(30, 10, 2, 3), true)
    expect(first.result.stats).toMatchObject({ inputTokens: 57, cachedInputTokens: 40, cacheWriteTokens: 3, outputTokens: 10 })
    expect(second.result.stats).toMatchObject({ inputTokens: 11, cachedInputTokens: 8, cacheWriteTokens: 1, outputTokens: 2 })
    expect(third.result.stats).toMatchObject({ inputTokens: 18, cachedInputTokens: 10, cacheWriteTokens: 2, outputTokens: 3 })
    expect(second.seen.every(s => Number(s.cachedInputTokens) <= 8)).toBe(true)
    const records = [first, second, third].map(({ result }, index) => cliUsageRecordOf({ id: `acceptance-${index}`, cli: 'codex', model: 'fixture', phase: 'done', sessionId: 'fixture-parent', startedAt: index + 1, endedAt: index + 2, exitCode: 0, error: undefined, stats: result.stats }))
    const ledger = records.reduce((state, record) => applyCliUsage(state, { type: CLI_USAGE_EVENT, data: record }), EMPTY_CLI_USAGE)
    expect(ledger.totals).toMatchObject({ inputTokens: 86, cachedInputTokens: 58, cacheWriteTokens: 6, outputTokens: 15 })
    expect(sum(ledger.totals as RolloutUsageStats)).toBe(165)
  })

  it('preserves only the failed turn consumption when no final usage frame is present', async () => {
    const { home, file } = fixture(line(raw(100, 40, 3, 10)))
    const { result } = await runTurn(home, file, raw(120, 48, 4, 12), undefined, true, true)
    expect(result.ok).toBe(false)
    expect(result.threadId).toBe(THREAD)
    expect(result.stats).toMatchObject({ inputTokens: 11, cachedInputTokens: 8, cacheWriteTokens: 1, outputTokens: 2 })
  })

  it('does not assume a missing pre-launch baseline is zero when an old transcript appears late', async () => {
    const { home, file } = fixture()
    const { result, notes } = await runTurn(home, file, raw(9999, 8000, 100, 1000), raw(20, 8, 1, 2), true)
    expect(result.stats).toMatchObject({ inputTokens: 11, cachedInputTokens: 8, cacheWriteTokens: 1, outputTokens: 2 })
    expect(notes.some(text => text.includes('历史用量基线不可读'))).toBe(true)
  })

  it('keeps unmeasured consumption unknown instead of copying history or fabricating zero', async () => {
    const { home, file } = fixture()
    const { result } = await runTurn(home, file, raw(9999, 8000, 100, 1000), undefined, true, true)
    expect(result.stats).not.toHaveProperty('inputTokens')
    expect(result.stats).not.toHaveProperty('outputTokens')
    expect(result.stats).not.toHaveProperty('cachedInputTokens')
  })

  it('captures a baseline without a final newline and drains the final appended row exactly once', () => {
    const { home, file } = fixture(line(raw(100, 40, 3, 10)).trimEnd())
    const seen: RolloutUsageStats[] = []
    const tail = startRolloutUsageTail({ threadId: THREAD, codexHome: home, resume: true, intervalMs: 60000, onUsage: value => seen.push(value) })
    expect(seen).toEqual([])
    appendFileSync(file, '\n' + line(raw(120, 48, 4, 12)).trimEnd())
    tail.stop(); tail.stop()
    expect(seen).toEqual([{ inputTokens: 11, cachedInputTokens: 8, cacheWriteTokens: 1, outputTokens: 2, usageInputSemantics: 'uncached' }])
  })

  it('does not re-emit historical totals when the new run produces no usage', () => {
    const { home } = fixture(line(raw(100, 40, 3, 10)))
    const seen: RolloutUsageStats[] = []
    const tail = startRolloutUsageTail({ threadId: THREAD, codexHome: home, resume: true, onUsage: value => seen.push(value) })
    tail.stop()
    expect(seen).toEqual([])
  })

  it('rejects a cumulative counter reset instead of silently clamping negative usage', () => {
    const { home, file } = fixture(line(raw(100, 40, 3, 10)))
    const seen: RolloutUsageStats[] = []; const warnings: string[] = []
    const tail = startRolloutUsageTail({ threadId: THREAD, codexHome: home, resume: true, onUsage: value => seen.push(value), onWarning: text => warnings.push(text) })
    appendFileSync(file, line(raw(20, 8, 1, 2)))
    tail.stop()
    expect(seen).toEqual([])
    expect(warnings).toHaveLength(1)
  })
})

describe('Codex MCP event projection', () => {
  const item = { id: 'mcp-1', type: 'mcp_tool_call', server: 'dsh_bridge', tool: 'skill_office', arguments: { name: 'resource-fixture' }, status: 'in_progress' }
  it('retains public tool identity, arguments, result and errors in collapsible event details', () => {
    const start = codexFrameEvents({ type: 'item.started', item })
    expect(start).toMatchObject([{ kind: 'tool', text: 'MCP dsh_bridge/skill_office' }])
    expect(start[0]!.detail).toContain('resource-fixture')
    const end = codexFrameEvents({ type: 'item.completed', item: { ...item, status: 'completed', result: { content: [{ type: 'text', text: 'full skill body' }] } } })
    expect(end).toMatchObject([{ kind: 'result' }]); expect(end[0]!.detail).toContain('full skill body')
    const failed = codexFrameEvents({ type: 'item.completed', item: { ...item, status: 'failed', error: { message: 'MCP fixture failure' } } })
    expect(failed).toMatchObject([{ kind: 'error' }]); expect(failed[0]!.detail).toContain('MCP fixture failure')
    expect(codexFrameEvents({ type: 'item.updated', item })).toEqual([])
  })
  it('recognizes MCP isError even when the transport item completed normally', () => {
    const events = codexFrameEvents({ type: 'item.completed', item: { ...item, status: 'completed', result: { isError: true, content: [{ type: 'text', text: 'permission denied' }] } } })
    expect(events[0]!.kind).toBe('error'); expect(events[0]!.detail).toContain('permission denied')
  })
  it('redacts credentials and inline binary payloads without dropping image paths or text', () => {
    const events = codexFrameEvents({ type: 'item.completed', item: { ...item, arguments: { apiKey: 'fixture-secret-key', nested: { bridge_token: 'fixture-bridge-secret' } }, result: { content: [{ type: 'image', data: 'fixture-base64-image', mimeType: 'image/png' }, { type: 'text', text: 'saved D:/fixture/output.png' }] } } })
    const detail = events[0]!.detail!
    expect(detail).not.toContain('fixture-secret-key'); expect(detail).not.toContain('fixture-bridge-secret'); expect(detail).not.toContain('fixture-base64-image')
    expect(detail).toContain('D:/fixture/output.png'); expect(detail).toContain('binary payload omitted')
  })
})
