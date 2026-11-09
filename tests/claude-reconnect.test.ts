import { describe, expect, it } from 'vitest'
import { runClaudeTask } from '../src/channels/claude.js'
import { scriptedSpawn } from './fake-child.js'

const baseOptions = {
  claudePath: 'claude',
  task: '一个完整任务',
  cwd: undefined,
  model: '',
  permissionMode: 'inherit' as const,
  baseUrl: '',
  authToken: '',
}

describe('runClaudeTask reconnect recovery budget', () => {
  it('stops a run that only prints reconnect diagnostics', async () => {
    let reconnects = 0
    const { spawnFn } = scriptedSpawn(child => {
      const timer = setInterval(() => {
        reconnects += 1
        child.stderr.emit('data', Buffer.from('Reconnecting... waiting for network (Connection failed: error sending request)\n'))
      }, 10)
      child.onStdin = () => { /* keep the process running */ }
      child.once('close', () => { clearInterval(timer) })
    })
    const result = await runClaudeTask({
      ...baseOptions,
      spawnFn,
      timeoutMs: 80,
      signal: new AbortController().signal,
      onEvent: () => {},
    })
    expect(reconnects).toBeGreaterThan(1)
    expect(result.ok).toBe(false)
    expect(result.stats['reconnectTimedOut']).toBe(true)
    expect(result.error).toContain('持续重连')
  })

  it('keeps the full idle protection once a real frame proves progress', async () => {
    const { spawnFn } = scriptedSpawn(child => {
      child.stderr.emit('data', Buffer.from('Reconnecting... waiting for network\n'))
      setTimeout(() => {
        // A parsed protocol frame clears the recovery budget.
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '继续' }] } })}\n`))
      }, 30)
      const chatter = setInterval(() => {
        child.stderr.emit('data', Buffer.from('still working\n'))
      }, 10)
      child.onStdin = () => { /* keep the process running */ }
      child.once('close', () => { clearInterval(chatter) })
      setTimeout(() => {
        child.finish(JSON.stringify({ type: 'result', subtype: 'success', result: '完成了', num_turns: 1, session_id: 's1' }))
      }, 240)
    })
    const result = await runClaudeTask({
      ...baseOptions,
      spawnFn,
      timeoutMs: 80,
      signal: new AbortController().signal,
      onEvent: () => {},
    })
    expect(result.ok).toBe(true)
    expect(result.finalText).toBe('完成了')
    expect(result.stats['reconnectTimedOut']).toBeUndefined()
  })
})
