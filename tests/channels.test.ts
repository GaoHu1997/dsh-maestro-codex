import { describe, expect, it } from 'vitest'
import { claudeArgs, claudeEnv, claudeFrameEvents, claudePermissionArgs, claudeResultOf, lastLines, runClaudeTask } from '../src/channels/claude.js'
import { codexArgs, codexEnv, codexFrameEvents, codexSandboxArgs, runCodexTask } from '../src/channels/codex.js'
import { scriptedSpawn } from './fake-child.js'

describe('claude argv/env', () => {
  it('builds the headless stream-json argv', () => {
    expect(claudeArgs('m1', 'default')).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--model', 'm1'])
    expect(claudeArgs('', 'inherit')).toEqual(['-p', '--output-format', 'stream-json', '--verbose'])
  })

  it('maps permission modes', () => {
    expect(claudePermissionArgs('inherit')).toEqual([])
    expect(claudePermissionArgs('default')).toEqual([])
    expect(claudePermissionArgs('acceptEdits')).toEqual(['--permission-mode', 'acceptEdits'])
    expect(claudePermissionArgs('plan')).toEqual(['--permission-mode', 'plan'])
    expect(claudePermissionArgs('bypassPermissions')).toEqual(['--dangerously-skip-permissions'])
  })

  it('only sets provider env when configured', () => {
    expect(claudeEnv('', '')).toEqual({})
    expect(claudeEnv('https://gw.example.com', 'sk-1')).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
      ANTHROPIC_AUTH_TOKEN: 'sk-1',
    })
  })
})

describe('claude frame parsing', () => {
  it('surfaces init, text, tool calls and result labels', () => {
    const init = claudeFrameEvents({ type: 'system', subtype: 'init', model: 'm', session_id: 's1' })
    expect(init[0]?.kind).toBe('note')
    expect(init[0]?.text).toContain('m')

    const assistant = claudeFrameEvents({ type: 'assistant', message: { content: [
      { type: 'text', text: '正在分析' },
      { type: 'tool_use', name: 'Read' },
    ] } })
    expect(assistant.map(event => event.kind)).toEqual(['text', 'note'])

    const result = claudeFrameEvents({ type: 'result', subtype: 'success' })
    expect(result[0]?.text).toBe('运行完成')
  })

  it('extracts the final answer and stats', () => {
    const parsed = claudeResultOf({ type: 'result', result: '答案是 42', num_turns: 3, total_cost_usd: 0.01003, session_id: 's1' })
    expect(parsed.finalText).toBe('答案是 42')
    expect(parsed.stats['turns']).toBe(3)
    expect(parsed.stats['costUsd']).toBe(0.01)
  })
})

describe('runClaudeTask (fake spawn)', () => {
  it('streams events and returns the final result', async () => {
    const { spawnFn } = scriptedSpawn(child => {
      child.onStdin = input => {
        expect(input).toContain('完整任务')
        child.finish([
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 's9', model: 'm' }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '思考中' }] } }),
          JSON.stringify({ type: 'result', subtype: 'success', result: '任务完成 42', num_turns: 2, session_id: 's9' }),
        ].join('\n'))
      }
    })
    const events: string[] = []
    const result = await runClaudeTask({
      spawnFn,
      claudePath: 'claude',
      task: '一个完整任务',
      cwd: undefined,
      model: '',
      permissionMode: 'inherit',
      baseUrl: '',
      authToken: '',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      onEvent: (kind, text) => events.push(`${kind}:${text}`),
    })
    expect(result.ok).toBe(true)
    expect(result.finalText).toBe('任务完成 42')
    expect(result.sessionId).toBe('s9')
    expect(result.stats['turns']).toBe(2)
    expect(events.some(event => event.startsWith('text:思考中'))).toBe(true)
  })

  it('reports a non-zero exit as failure with the stderr tail', async () => {
    const { spawnFn } = scriptedSpawn(child => {
      child.finish('', 1, 'boom happened')
    })
    const result = await runClaudeTask({
      spawnFn,
      claudePath: 'claude',
      task: '任务',
      cwd: undefined,
      model: '',
      permissionMode: 'inherit',
      baseUrl: '',
      authToken: '',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      onEvent: () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('boom happened')
    expect(lastLines('a\nb\nc\nd\ne', 3)).toBe('c | d | e')
  })
})

describe('codex argv/env', () => {
  it('builds the exec --json argv with stdin prompt marker', () => {
    expect(codexArgs('gpt-5-codex', 'workspace-write')).toEqual([
      'exec', '--json', '--skip-git-repo-check', '-m', 'gpt-5-codex', '--sandbox', 'workspace-write', '-',
    ])
    expect(codexArgs('', 'read-only')).toEqual(['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-'])
  })

  it('splices -c config overrides before the sandbox flags', () => {
    expect(codexArgs('', 'read-only', ['model_instructions_file="C:\\x.md"'])).toEqual([
      'exec', '--json', '--skip-git-repo-check', '-c', 'model_instructions_file="C:\\x.md"', '--sandbox', 'read-only', '-',
    ])
  })

  it('maps sandbox modes', () => {
    expect(codexSandboxArgs('workspace-write')).toEqual(['--sandbox', 'workspace-write'])
    expect(codexSandboxArgs('danger-full-access')).toEqual(['--dangerously-bypass-approvals-and-sandbox'])
    expect(codexSandboxArgs('read-only')).toEqual(['--sandbox', 'read-only'])
  })

  it('only sets provider env when configured', () => {
    expect(codexEnv('', '')).toEqual({})
    expect(codexEnv('https://api.example.com/v1', 'sk-2')).toEqual({
      OPENAI_BASE_URL: 'https://api.example.com/v1',
      OPENAI_API_KEY: 'sk-2',
    })
  })
})

describe('codex frame parsing', () => {
  it('surfaces commands, file changes, agent messages and failures', () => {
    expect(codexFrameEvents({ type: 'item.started', item: { type: 'command_execution', command: 'ls -la' } })[0]?.text).toContain('ls -la')
    expect(codexFrameEvents({ type: 'item.completed', item: { type: 'file_change', status: 'completed', files: [{ path: 'a.ts' }] } })[0]?.text).toContain('a.ts')
    expect(codexFrameEvents({ type: 'item.completed', item: { type: 'agent_message', text: '完成' } })[0]?.kind).toBe('text')
    expect(codexFrameEvents({ type: 'turn.failed', error: { message: '配额不足' } })[0]?.kind).toBe('error')
    // Legacy msg dialect still feeds text events.
    expect(codexFrameEvents({ msg: { type: 'agent_message', message: '旧版消息' } })[0]?.kind).toBe('text')
  })
})

describe('runCodexTask (fake spawn)', () => {
  it('returns the last agent message as the final text', async () => {
    const { spawnFn } = scriptedSpawn(child => {
      child.onStdin = input => {
        expect(input).toContain('codex 任务')
        child.finish([
          JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
          JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'echo hi' } }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '第一段' } }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '最终结论' } }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }),
        ].join('\n'))
      }
    })
    const result = await runCodexTask({
      spawnFn,
      codexPath: 'codex',
      task: 'codex 任务',
      cwd: undefined,
      model: '',
      sandbox: 'workspace-write',
      baseUrl: '',
      apiKey: '',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      onEvent: () => {},
    })
    expect(result.ok).toBe(true)
    expect(result.finalText).toBe('最终结论')
    expect(result.threadId).toBe('t1')
    expect(result.stats['outputTokens']).toBe(5)
  })

  it('fails on turn.failed even with exit 0', async () => {
    const { spawnFn } = scriptedSpawn(child => {
      child.finish(JSON.stringify({ type: 'turn.failed', error: { message: '额度用尽' } }), 0)
    })
    const result = await runCodexTask({
      spawnFn,
      codexPath: 'codex',
      task: '任务',
      cwd: undefined,
      model: '',
      sandbox: 'workspace-write',
      baseUrl: '',
      apiKey: '',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      onEvent: () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('额度用尽')
  })
})
