import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runClaudeTask } from '../src/channels/claude.js'
import { scriptedSpawn } from './fake-child.js'

afterEach(() => { vi.unstubAllEnvs() })
describe('delegated Claude repository-memory isolation', () => {
  it.each([undefined, '11111111-2222-3333-4444-555555555555'])('disables shared auto memory without disabling native transcript resume (%s)', async resume => {
    vi.stubEnv('CLAUDE_CODE_DISABLE_AUTO_MEMORY', '0')
    let settingsPath = ''
    const { spawnFn: fake } = scriptedSpawn(child => {
      settingsPath = child.spawnArgs[child.spawnArgs.indexOf('--settings') + 1] ?? ''
      expect(settingsPath).not.toBe('')
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { env: Record<string, string> }
      expect(settings.env['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1')
      expect(child.spawnArgs).not.toContain('--no-session-persistence')
      expect(child.spawnArgs).not.toContain('--dangerously-skip-permissions')
      if (resume !== undefined) expect(child.spawnArgs.slice(child.spawnArgs.indexOf('--resume'), child.spawnArgs.indexOf('--resume') + 2)).toEqual(['--resume', resume])
      child.finish(JSON.stringify({ type: 'result', result: 'test-only answer', session_id: resume ?? 'test-only-session' }))
    })
    const result = await runClaudeTask({
      spawnFn: (file, args, options) => {
        expect(options.env?.['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1')
        return fake(file, args)
      },
      claudePath: 'fake-claude-no-process', task: 'test-only task', cwd: undefined, model: 'test-model',
      permissionMode: 'default', ...(resume === undefined ? {} : { resume }),
      baseUrl: '', authToken: '', timeoutMs: 5000, signal: new AbortController().signal, onEvent: () => {},
    })
    expect(result.ok).toBe(true)
    expect(existsSync(settingsPath)).toBe(false)
    expect(process.env['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('0')
  })
})
