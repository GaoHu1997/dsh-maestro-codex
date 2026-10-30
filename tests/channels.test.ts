import { readFileSync, statSync, unlinkSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { claudeArgs, claudeEnv, claudeFrameEvents, claudeMcpArgs, claudePermissionArgs, claudeResultOf, lastLines, runClaudeTask, writeClaudeSettingsFile } from '../src/channels/claude.js'
import { codexArgs, codexDshModelArgs, codexEnv, codexFrameEvents, codexSandboxArgs, codexWindowsSandboxArgs, codexUsageStats, runCodexTask, tomlString } from '../src/channels/codex.js'
import { scriptedSpawn } from './fake-child.js'

describe('channel usage normalization', () => {
  it('keeps Codex inclusive input and cache reads mutually exclusive', () => {
    expect(codexUsageStats({ usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 9 } }))
      .toEqual({ inputTokens: 30, cachedInputTokens: 70, outputTokens: 9 })
    expect(codexUsageStats({ usage: { output_tokens: 9 } })).toEqual({ outputTokens: 9 })
    expect(codexUsageStats({})).toEqual({})
  })

  it('keeps real Claude usage even on an error result', () => {
    expect(claudeResultOf({ type: 'result', is_error: true, usage: {
      input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3,
    } }).stats).toEqual({ inputTokens: 11, outputTokens: 7, cachedInputTokens: 5, cacheWriteTokens: 3 })
  })
})

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

  it('rides the thinking level on MAX_THINKING_TOKENS', () => {
    expect(claudeEnv('', '', '')).toEqual({})
    expect(claudeEnv('', '', 'off')).toEqual({ MAX_THINKING_TOKENS: '0' })
    expect(claudeEnv('', '', 'medium')).toEqual({ MAX_THINKING_TOKENS: '10000' })
    expect(claudeEnv('', '', 'high')).toEqual({ MAX_THINKING_TOKENS: '31999' })
    // Levels come from the model's configured reasoningEfforts; an unmapped
    // key (catalog drift) is ignored, never guessed.
    expect(claudeEnv('', '', 'mega')).toEqual({})
  })

  it('puts --settings ahead of --model so the pinned provider env wins', () => {
    // ~/.claude/settings.json carries its own `env` block, which Claude Code
    // applies on top of the process environment: without --settings a stale
    // user gateway silently replaces the dsh-configured one.
    expect(claudeArgs('m1', 'default', undefined, undefined, undefined, 'C:/tmp/s.json'))
      .toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--settings', 'C:/tmp/s.json', '--model', 'm1'])
    // No pinned env → no --settings at all (the run rides claude's own config).
    expect(claudeArgs('m1', 'default', undefined, undefined, undefined, '')).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--model', 'm1'])
  })

  it('writes the one-run settings file with owner-only access', async () => {
    const file = await writeClaudeSettingsFile({ ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-1' })
    try {
      expect(file).toContain('dsh-maestro-claude-')
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        env: { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-1' },
      })
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      unlinkSync(file)
    }
  })

  it('grants bridged servers only through --allowedTools, never as bare argv tokens', () => {
    const args = claudeMcpArgs('C:/tmp/mcp.json', ['dsh-image', 'obsidian_mcp'])
    // A bare `mcp__…` token in `claude -p` lands in the positional prompt and
    // would be prepended to every task's stdin text.
    expect(args.filter(arg => arg === 'mcp__dsh-image' || arg === 'mcp__obsidian_mcp')).toEqual([])
    expect(args).toEqual([
      '--strict-mcp-config',
      '--mcp-config', 'C:/tmp/mcp.json',
      '--allowedTools', 'mcp__dsh-image,mcp__obsidian_mcp',
    ])
    expect(claudeMcpArgs('C:/tmp/mcp.json', [])).toEqual(['--strict-mcp-config', '--mcp-config', 'C:/tmp/mcp.json'])
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

  it('pins the provider env through --settings and drops the file afterwards', async () => {
    let settingsPath = ''
    const { spawnFn } = scriptedSpawn(child => {
      const index = child.spawnArgs.indexOf('--settings')
      expect(index).toBeGreaterThan(-1)
      settingsPath = child.spawnArgs[index + 1] ?? ''
      // The file must exist while the CLI runs, carrying the pinned env.
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
        env: { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_AUTH_TOKEN: 'sk-1' },
      })
      child.finish(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }))
    })
    const result = await runClaudeTask({
      spawnFn,
      claudePath: 'claude',
      task: '任务',
      cwd: undefined,
      model: '',
      permissionMode: 'inherit',
      baseUrl: 'https://gw.example.com',
      authToken: 'sk-1',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      onEvent: () => {},
    })
    expect(result.ok).toBe(true)
    // Unlinked once the run settles: the token does not outlive the task.
    expect(() => statSync(settingsPath)).toThrow()
  })

  it('streams running usage while the answer is still being generated', async () => {
    const { spawnFn } = scriptedSpawn(child => {
      child.finish([
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '想' }], usage: { input_tokens: 900, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 5 } } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '答' }], usage: { input_tokens: 1200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0, output_tokens: 7 } } }),
        JSON.stringify({ type: 'result', subtype: 'success', result: '完成', usage: { input_tokens: 2100, cache_read_input_tokens: 1800, cache_creation_input_tokens: 0, output_tokens: 42 } }),
      ].join('\n'))
    })
    const usage: Array<Record<string, string | number | boolean>> = []
    await runClaudeTask({
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
      onUsage: stats => usage.push(stats),
    })
    // Two assistant frames + the result frame: inputs replace (context size),
    // outputs accumulate, and the final frame lands the authoritative totals.
    expect(usage.length).toBe(3)
    expect(usage[0]?.['inputTokens']).toBe(900)
    expect(usage[1]?.['inputTokens']).toBe(1200)
    expect(usage[1]?.['outputTokens']).toBe(12)
    expect(usage[2]).toMatchObject({ inputTokens: 2100, outputTokens: 42, cachedInputTokens: 1800 })
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

  it('names the missing-answer reason when claude exits 0 without a result frame', async () => {
    const { spawnFn } = scriptedSpawn(child => {
      child.finish([
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
        JSON.stringify({ type: 'result', subtype: 'success', result: '' }),
      ].join('\n'))
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
    expect(result.error).toContain('未返回文本结果')
  })
})

describe('codex argv/env', () => {
  it('builds the exec --json argv with stdin prompt marker', () => {
    expect(codexArgs('gpt-5-codex', 'workspace-write')).toEqual([
      'exec', '--json', '--skip-git-repo-check', '-m', 'gpt-5-codex', '--sandbox', 'workspace-write', '-',
    ])
    expect(codexArgs('', 'read-only')).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-',
    ])
  })

  it('splices -c config overrides before the sandbox flags', () => {
    expect(codexArgs('', 'read-only', ['model_instructions_file="C:\\x.md"'])).toEqual([
      'exec', '--json', '--skip-git-repo-check', '-c', 'model_instructions_file="C:\\x.md"', '--sandbox', 'read-only', '-',
    ])
  })

  it('puts the thinking override ahead of the user -c list, skipping unsupported keys', () => {
    expect(codexArgs('', 'read-only', ['model_reasoning_effort="low"'], undefined, undefined, 'high')).toEqual([
      'exec', '--json', '--skip-git-repo-check',
      '-c', 'model_reasoning_effort="high"',
      '-c', 'model_reasoning_effort="low"',
      '--sandbox', 'read-only',
      '-',
    ])
    expect(codexArgs('', 'read-only', [], undefined, undefined, '')).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-',
    ])
    // codex config-parses the value up front: a key it can't parse (the catalog
    // may declare `off`) must not reach the argv.
    expect(codexArgs('', 'read-only', [], undefined, undefined, 'off')).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-',
    ])
    expect(codexArgs('', 'read-only', [], undefined, undefined, 'mega')).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-',
    ])
  })

  it('synthesizes the dsh provider overrides in place of -m', () => {
    const args = codexArgs('cli-model', 'workspace-write', [], { model: 'group/deepseek-v4.1-flash', baseUrl: 'https://gw/v1' })
    expect(args).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--ignore-user-config',
      '-c', 'model="group/deepseek-v4.1-flash"',
      '-c', 'model_provider=maestro_dsh',
      '-c', 'model_providers.maestro_dsh.name="dsh-maestro"',
      '-c', 'model_providers.maestro_dsh.base_url="https://gw/v1"',
      '-c', 'model_providers.maestro_dsh.env_key="MAESTRO_DSH_PROVIDER_KEY"',
      // codex ≥0.146 refuses `wire_api="chat"` at config-parse time, so the dsh
      // provider is always injected over the responses dialect.
      '-c', 'model_providers.maestro_dsh.wire_api="responses"',
      // `--ignore-user-config` drops the operator's `[windows] sandbox` too, and
      // without it codex refuses every exec_command on Windows — re-stated here.
      ...codexWindowsSandboxArgs(),
      '--sandbox', 'workspace-write',
      '-',
    ])
    expect(codexDshModelArgs('m', 'https://x').envKey).toBe('MAESTRO_DSH_PROVIDER_KEY')
  })

  it('re-states the Windows sandbox only on win32', () => {
    expect(codexWindowsSandboxArgs('win32')).toEqual(['-c', 'windows.sandbox="elevated"'])
    expect(codexWindowsSandboxArgs('darwin')).toEqual([])
    expect(codexWindowsSandboxArgs('linux')).toEqual([])
  })

  it('quotes TOML strings for -c overrides', () => {
    expect(tomlString('a"b\\c')).toBe('"a\\"b\\\\c"')
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
  it('labels command starts and emits the final aggregate only once', () => {
    const item = { type: 'command_execution', command: 'echo hi', aggregated_output: 'hi\n', exit_code: 0, status: 'completed' }
    expect(codexFrameEvents({ type: 'item.started', item })[0]?.text).toContain('(started)')
    expect(codexFrameEvents({ type: 'item.updated', item })).toEqual([])
    const events = codexFrameEvents({ type: 'item.completed', item })
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('note')
    expect(events[0]?.text).toContain('命令完成')
    expect(events[0]?.text).toContain('退出码 0')
    expect(events[0]?.text).toContain('hi\n')
  })

  it.each([
    { exit_code: 1, status: 'completed' },
    { exit_code: 2, status: 'failed' },
    { exit_code: null, status: 'failed' },
    { exit_code: null, status: 'declined' },
  ])('classifies an actual failed/declined command as an error: %j', result => {
    const event = codexFrameEvents({ type: 'item.completed', item: {
      type: 'command_execution', command: 'build', aggregated_output: 'build failed: missing input', ...result,
    } })[0]
    expect(event?.kind).toBe('error')
    expect(event?.text).toContain('命令失败')
    expect(event?.text).toContain('build failed: missing input')
  })

  it('does not classify successful ACL diagnostics or output keywords as failures', () => {
    for (const command of ['icacls target\\maven-status\\inputFiles.lst', 'Get-Acl target\\maven-status\\inputFiles.lst', 'Get-Item target\\maven-status\\inputFiles.lst']) {
      const event = codexFrameEvents({ type: 'item.completed', item: {
        type: 'command_execution', command, exit_code: 0, status: 'completed', aggregated_output: 'error count: 0\nOwner: test\n',
      } })[0]
      expect(event?.kind).toBe('note')
      expect(event?.text).toContain('Owner: test')
    }
    expect(codexFrameEvents({ type: 'item.completed', item: { type: 'command_execution', command: 'diagnose', exit_code: 0, status: 'failed' } })[0]?.kind).toBe('note')
  })

  it('bounds large command previews while preserving the head and diagnostic tail', () => {
    const event = codexFrameEvents({ type: 'item.completed', item: {
      type: 'command_execution', command: 'build', exit_code: 1, aggregated_output: `HEAD\n${'x'.repeat(10_000)}\nROOT CAUSE`,
    } })[0]
    expect(event?.text.length).toBeLessThan(6200)
    expect(event?.text).toContain('HEAD')
    expect(event?.text).toContain('省略')
    expect(event?.text).toContain('ROOT CAUSE')
  })

  it('reads canonical top-level and item errors without truncating their messages', () => {
    const message = `failure:${'x'.repeat(7000)}:details`
    expect(codexFrameEvents({ type: 'error', message })).toEqual([{ kind: 'error', text: message }])
    expect(codexFrameEvents({ type: 'turn.failed', error: { message } })).toEqual([{ kind: 'error', text: message }])
    expect(codexFrameEvents({ type: 'item.completed', item: { type: 'error', message } })).toEqual([{ kind: 'error', text: message }])
    expect(codexFrameEvents({ type: 'item.completed', item: { type: 'error', text: 'older item error' } })[0]?.text).toBe('older item error')
    expect(codexFrameEvents({ type: 'error', error: 'older stream error' })[0]?.text).toBe('older stream error')
    expect(codexFrameEvents({ type: 'error' })[0]?.text).toBe('codex stream error')
  })

  it('accepts the canonical file-change changes field', () => {
    expect(codexFrameEvents({ type: 'item.completed', item: { type: 'file_change', status: 'failed', changes: [{ path: 'a.ts' }] } })[0]).toEqual({ kind: 'error', text: '文件变更 failed a.ts' })
  })
})

async function fakeCodexRun(frames: Array<Parameters<typeof codexFrameEvents>[0]>, code = 0, stderr = '') {
  const events: Array<{ kind: 'text' | 'note' | 'error'; text: string }> = []
  const { spawnFn } = scriptedSpawn(child => { child.finish(frames.map(frame => JSON.stringify(frame)).join('\n'), code, stderr) })
  const result = await runCodexTask({
    spawnFn, codexPath: 'codex', task: '任务', cwd: undefined, model: '', sandbox: 'workspace-write',
    baseUrl: '', apiKey: '', timeoutMs: 10_000, signal: new AbortController().signal,
    onEvent: (kind, text) => { events.push({ kind, text }) },
  })
  return { result, events }
}

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

  it('reports running usage from the turn.completed frame', async () => {
    const { spawnFn } = scriptedSpawn(child => {
      child.finish([
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '完成' } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } }),
      ].join('\n'))
    })
    const usage: Array<Record<string, string | number | boolean>> = []
    await runCodexTask({
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
      onUsage: stats => usage.push(stats),
    })
    // Cached reads are carved out of input, matching the settled stats shape.
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ inputTokens: 60, cachedInputTokens: 40, outputTokens: 7 })
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

  it('allows a command failure and non-fatal item error to recover into a successful answer', async () => {
    const { result, events } = await fakeCodexRun([
      { type: 'item.started', item: { id: 'cmd1', type: 'command_execution', command: 'build' } },
      { type: 'item.updated', item: { id: 'cmd1', type: 'command_execution', command: 'build', aggregated_output: 'partial' } },
      { type: 'item.completed', item: { id: 'cmd1', type: 'command_execution', command: 'build', exit_code: 1, status: 'failed', aggregated_output: 'build failed' } },
      { type: 'item.completed', item: { type: 'error', message: 'recoverable warning' } },
      { type: 'item.completed', item: { type: 'agent_message', text: '已修复并完成' } },
      { type: 'turn.completed' },
    ])
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    expect(events.filter(event => event.text.includes('build failed'))).toHaveLength(1)
    expect(events.some(event => event.kind === 'error' && event.text.includes('recoverable warning'))).toBe(true)
    expect(events.some(event => event.text.includes('partial'))).toBe(false)
  })

  it.each([
    [],
    [{ type: 'thread.started', thread_id: 't' }],
    [{ type: 'turn.completed' }],
    [{ type: 'item.completed', item: { type: 'agent_message', text: '   ' } }, { type: 'turn.completed' }],
    [{ type: 'item.completed', item: { type: 'command_execution', command: 'echo hi', exit_code: 0, aggregated_output: 'hi' } }, { type: 'turn.completed' }],
  ].map(frames => ({ frames })))('does not silently succeed with exit 0 but no final answer: %j', async ({ frames }) => {
    const { result } = await fakeCodexRun(frames)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('未返回最终答复')
    expect(result.exitCode).toBe(0)
  })

  it('fails an unresolved top-level stream error even if an earlier answer exists', async () => {
    const { result, events } = await fakeCodexRun([
      { type: 'item.completed', item: { type: 'agent_message', text: 'earlier answer' } },
      { type: 'error', message: 'stream disconnected: exact reason' },
    ])
    expect(result.ok).toBe(false)
    expect(result.error).toBe('stream disconnected: exact reason')
    expect(events.some(event => event.kind === 'error' && event.text.includes('exact reason'))).toBe(true)
  })

  it('permits a stream error only when a subsequent completed turn proves recovery', async () => {
    const { result } = await fakeCodexRun([
      { type: 'error', message: 'Reconnecting... 1/5' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'completed after reconnect' } },
      { type: 'turn.completed' },
    ])
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    const { result: lateFailure } = await fakeCodexRun([
      { type: 'item.completed', item: { type: 'agent_message', text: 'answer' } },
      { type: 'turn.completed' },
      { type: 'error', message: 'late stream failure' },
    ])
    expect(lateFailure.ok).toBe(false)
    expect(lateFailure.error).toContain('late stream failure')
  })

  it('retains all failure causes, full command output and stderr on a failed run', async () => {
    const output = `BEGIN\n${'x'.repeat(3000)}\nCAUSE IN OMITTED MIDDLE\n${'y'.repeat(5000)}\nEND`
    const { result, events } = await fakeCodexRun([
      { type: 'item.completed', item: { type: 'command_execution', command: 'build', exit_code: 1, aggregated_output: output } },
      { type: 'item.completed', item: { type: 'error', message: 'tool warning detail' } },
      { type: 'error', message: 'connection diagnostic' },
      { type: 'turn.failed', error: { message: 'turn failure detail' } },
    ], 1, 'line one\nline two\nline three\nline four\nline five')
    expect(result.ok).toBe(false)
    expect(result.error).toContain(output)
    expect(result.error).toContain('tool warning detail')
    expect(result.error).toContain('connection diagnostic')
    expect(result.error).toContain('turn failure detail')
    expect(result.error).toContain('进程退出码 1')
    expect(result.error).toContain('line one\nline two\nline three\nline four\nline five')
    expect(events.find(event => event.text.startsWith('命令失败'))?.text).not.toContain('CAUSE IN OMITTED MIDDLE')
  })

  it('retains exit-0 stderr diagnostics when the CLI gives no answer', async () => {
    const { result } = await fakeCodexRun([{ type: 'error', error: { message: 'provider unavailable' } }], 0, 'network diagnostic')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('provider unavailable')
    expect(result.error).toContain('未返回最终答复')
    expect(result.error).toContain('network diagnostic')
  })

  it('keeps a large agent answer intact rather than applying command preview limits', async () => {
    const answer = `结论：${'x'.repeat(20_000)}`
    const { result, events } = await fakeCodexRun([
      { type: 'item.completed', item: { type: 'agent_message', text: answer } },
      { type: 'turn.completed' },
    ])
    expect(result.ok).toBe(true)
    expect(result.finalText).toBe(answer)
    expect(events.find(event => event.kind === 'text')?.text).toBe(answer)
  })

  it('fails a terminal turn.failed even when an earlier answer and exit 0 exist', async () => {
    const { result } = await fakeCodexRun([
      { type: 'item.completed', item: { type: 'agent_message', text: 'intermediate answer' } },
      { type: 'turn.failed', error: { message: 'terminal turn failure' } },
    ])
    expect(result.ok).toBe(false)
    expect(result.finalText).toBe('intermediate answer')
    expect(result.error).toBe('terminal turn failure')
  })

  it('does not report success if cancellation races with a child that already exited 0', async () => {
    const controller = new AbortController()
    controller.abort()
    const { spawnFn } = scriptedSpawn(child => {
      // The child has already exited, so killTree returns without invoking any
      // OS process killer. Stdout/close delivery is still queued by the fake.
      child.exitCode = 0
      child.finish(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer' } }))
    })
    const result = await runCodexTask({
      spawnFn, codexPath: 'codex', task: '任务', cwd: undefined, model: '', sandbox: 'workspace-write',
      baseUrl: '', apiKey: '', timeoutMs: 10_000, signal: controller.signal, onEvent: () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.error).toContain('任务已取消')
  })

  it('reports a non-zero process exit even after a completed turn and answer', async () => {
    const { result } = await fakeCodexRun([
      { type: 'item.completed', item: { type: 'agent_message', text: 'answer' } },
      { type: 'turn.completed' },
    ], 2, 'shutdown failed')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('进程退出码 2')
    expect(result.error).toContain('shutdown failed')
  })
})
