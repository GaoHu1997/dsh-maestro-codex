/**
 * Regression tests for the stdout line splitter. The old implementation
 * flushed any buffer over 8 KB without a newline, which shredded multi-kilobyte
 * JSONL records (a single `agent_message` easily exceeds that): the head was
 * dropped as an unterminated line and the tail was parsed as garbage, so the
 * dispatch reported success with an empty `finalText`.
 */

import { describe, expect, it } from 'vitest'
import { runProcess, type SpawnFn } from '../src/spawn.js'
import { scriptedSpawn } from './fake-child.js'

function harness(chunks: readonly string[]) {
  const lines: string[] = []
  const stderrLines: string[] = []
  const { spawnFn, launches } = scriptedSpawn((child) => {
    queueMicrotask(() => {
      for (const chunk of chunks) child.stdout.emit('data', Buffer.from(chunk, 'utf8'))
      child.stdout.emit('end')
      child.exitCode = 0
      child.emit('close', 0, null)
    })
  })
  const { outcome } = runProcess({
    file: 'node',
    args: [],
    spawnFn: spawnFn as unknown as SpawnFn,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    onStdoutLine: (line) => lines.push(line),
    onStderrLine: (line) => stderrLines.push(line),
  })
  return { outcome, lines, stderrLines, launches }
}

describe('runProcess line splitting', () => {
  it('keeps a 20 KB JSON line intact across chunks', async () => {
    const record = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'x'.repeat(20_000) },
    })
    const { outcome, lines } = harness([record.slice(0, 5_000), record.slice(5_000) + '\n'])
    await outcome
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0] as string) as { item: { text: string } }
    expect(parsed.item.text).toHaveLength(20_000)
  })

  it('delivers a final line that never received a newline', async () => {
    const { outcome, lines } = harness(['{"type":"thread.started"}'])
    await outcome
    expect(lines).toEqual(['{"type":"thread.started"}'])
  })

  it('drops a pathological oversized line instead of cutting it', async () => {
    const { outcome, lines } = harness(['a'.repeat(4_100_000), '\n'])
    const result = await outcome
    expect(lines).toEqual([])
    expect(result.stderrTail).toContain('dropped an oversized line')
  })

  it('survives a stdio stream error without crashing the host', async () => {
    // 管道错误没有监听器就是未捕获异常——宿主必须活下来，退出路径照常结算。
    const lines: string[] = []
    const { spawnFn } = scriptedSpawn((child) => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('{"ok":true}\n', 'utf8'))
        child.stdout.emit('error', new Error('EPIPE'))
        child.exitCode = 0
        child.emit('close', 0, null)
      })
    })
    const { outcome } = runProcess({
      file: 'node',
      args: [],
      spawnFn: spawnFn as unknown as SpawnFn,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      onStdoutLine: (line) => { lines.push(line) },
    })
    const result = await outcome
    expect(result.code).toBe(0)
    expect(lines).toEqual(['{"ok":true}'])
    expect(result.stderrTail).toContain('stdout stream error: EPIPE')
  })
})
