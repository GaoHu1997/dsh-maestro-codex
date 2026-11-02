import { describe, expect, it } from 'vitest'
import { PREPARE_OUTPUT_CAP, PREPARE_TIMEOUT_MS, prepareInvocation, runPrepare } from '../src/prepare.js'
import { scriptedSpawn } from './fake-child.js'

describe('prepareInvocation', () => {
  it('uses cmd.exe on Windows so .cmd shims resolve', () => {
    expect(prepareInvocation('git worktree add ../wt', 'win32')).toEqual({ file: 'cmd.exe', args: ['/d', '/s', '/c', 'git worktree add ../wt'] })
  })

  it('uses sh -c everywhere else', () => {
    expect(prepareInvocation('git worktree add ../wt', 'linux')).toEqual({ file: 'sh', args: ['-c', 'git worktree add ../wt'] })
  })
})

describe('runPrepare', () => {
  it('reports success with the trimmed output', async () => {
    const spawn = scriptedSpawn(child => { child.finish('Preparing worktree\n') })
    const outcome = await runPrepare('git worktree add ../wt', { cwd: 'C:/repo', spawnFn: spawn.spawnFn })
    expect(outcome).toMatchObject({ ok: true, code: 0, timedOut: false })
    expect(outcome.output).toBe('Preparing worktree')
    expect(spawn.launches[0]?.spawnFile).toMatch(/cmd\.exe|sh/)
  })

  it('turns a non-zero exit into a failure that carries stdout and stderr', async () => {
    const spawn = scriptedSpawn(child => { child.finish('', 2, 'fatal: 目录已存在') })
    const outcome = await runPrepare('git worktree add ../wt', { cwd: 'C:/repo', spawnFn: spawn.spawnFn })
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe(2)
    expect(outcome.output).toContain('fatal: 目录已存在')
  })

  it('kills the command and reports a timeout', async () => {
    const spawn = scriptedSpawn(() => { /* 一直不退出 */ })
    const outcome = await runPrepare('git fetch', { cwd: 'C:/repo', spawnFn: spawn.spawnFn, timeoutMs: 5, platform: 'linux' })
    expect(outcome.timedOut).toBe(true)
    expect(outcome.ok).toBe(false)
  })

  it('folds a spawn error into a failure instead of throwing', async () => {
    const outcome = await runPrepare('git fetch', {
      cwd: 'C:/repo',
      spawnFn: () => { throw new Error('ENOENT: 没有 git') },
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toContain('没有 git')
  })

  it('keeps the head of the output and marks the cut', async () => {
    const spawn = scriptedSpawn(child => { child.finish('x'.repeat(PREPARE_OUTPUT_CAP + 50)) })
    const outcome = await runPrepare('git status', { cwd: 'C:/repo', spawnFn: spawn.spawnFn })
    expect(outcome.output.length).toBeLessThanOrEqual(PREPARE_OUTPUT_CAP + 20)
    expect(outcome.output).toContain('输出已截断')
  })

  it('defaults to a ten minute budget', () => {
    expect(PREPARE_TIMEOUT_MS).toBe(10 * 60_000)
  })
})
