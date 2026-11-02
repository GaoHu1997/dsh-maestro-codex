import { describe, expect, it } from 'vitest'
import { boardCliUsage } from '../src/client/board/bridge.js'
import type { BoardSessionList } from '../src/client/board/data.js'
import { EMPTY_CLI_USAGE, type CliUsageRecord } from '../src/usage.js'

function listOf(patch: Partial<CliUsageRecord> = {}): BoardSessionList {
  const run: CliUsageRecord = {
    taskId: 'adapter-task', cli: 'codex', model: 'model-M', phase: 'done',
    startedAt: 1, endedAt: 2, durationMs: 1,
    inputTokens: 2, outputTokens: 3, cachedInputTokens: 5, cacheWriteTokens: 0,
    ...patch,
  }
  return { byId: {}, projectionsBySession: { parent: { values: {
    maestroCliUsage: { ...EMPTY_CLI_USAGE, recent: [run] },
  } } } }
}

describe('numeric upstream CLI usage adapter', () => {
  it('preserves authoritative complete numeric counters, including measured zero', () => {
    expect(boardCliUsage(listOf())).toEqual({ 'adapter-task': {
      uncachedInputTokens: 2, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 0,
    } })
  })
  it('does not turn an unknown cache bucket into zero or a partial numeric total', () => {
    const list = listOf({ cachedInputTokens: null })
    expect(boardCliUsage(list)).toEqual({})
    expect(list.projectionsBySession?.parent?.values.maestroCliUsage?.recent[0]?.cachedInputTokens).toBeNull()
  })
  it('does not turn an unknown input or output bucket into a fabricated numeric projection', () => {
    expect(boardCliUsage(listOf({ inputTokens: null }))).toEqual({})
    expect(boardCliUsage(listOf({ outputTokens: null }))).toEqual({})
  })
})
