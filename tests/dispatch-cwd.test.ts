import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { effectiveOf } from '../src/config.js'
import { CliPathCache, parseDispatchParams, runDispatch, usableWorkspaceCwd } from '../src/dispatch.js'
import { Limiter, TaskRegistry } from '../src/task-registry.js'
import { createOwnedTestFixture, type OwnedTestFixture } from './owned-test-fixture.js'

let fixture: OwnedTestFixture
let file: string
beforeAll(() => {
  fixture = createOwnedTestFixture(realpathSync.native(tmpdir()), 'maestro-cwd-validation-')
  file = join(fixture.path, 'not-a-directory.txt')
  writeFileSync(file, 'synthetic file, never a workspace')
})
afterAll(() => { fixture?.remove() }, 40_000)

const request = { task: '多步核验任务', cli: 'codex', task_difficulty: 'medium', difficulty_reason: '检查目录后执行和验证' }

describe('enterable workspace validation', () => {
  it('accepts an existing directory without rewriting its workspace identity', () => {
    expect(usableWorkspaceCwd(fixture.path)).toBe(fixture.path)
    expect(parseDispatchParams({ ...request, cwd: fixture.path })).toMatchObject({ cwd: fixture.path })
  })

  it.each(['relative', 'missing', 'file', 'empty'] as const)('rejects %s cwd before a process can be launched', kind => {
    const candidate = kind === 'relative' ? './workspace' : kind === 'missing' ? join(fixture.path, 'missing') : kind === 'file' ? file : ''
    expect(usableWorkspaceCwd(candidate)).toBeUndefined()
    if (candidate !== '') expect(parseDispatchParams({ ...request, cwd: candidate })).toEqual(expect.stringContaining('目录绝对路径'))
  })

  it('preserves omission semantics rather than silently turning the existing fallback into a breaking change', () => {
    expect(parseDispatchParams(request)).toMatchObject({ cwd: undefined })
    expect(parseDispatchParams({ ...request, cwd: '   ' })).toMatchObject({ cwd: undefined })
    expect(usableWorkspaceCwd(undefined)).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('rejects an existing POSIX directory without search permission', () => {
    chmodSync(fixture.path, 0o600)
    try { expect(usableWorkspaceCwd(fixture.path)).toBeUndefined() }
    finally { chmodSync(fixture.path, 0o700) }
  })

  it('also validates internal dispatch requests instead of relying only on the JSON parser', async () => {
    const config = effectiveOf({ codexCliPath: process.execPath })
    const registry = new TaskRegistry()
    const spawnFn = vi.fn(() => { throw new Error('must never spawn with a file cwd') })
    await expect(runDispatch({
      readConfig: () => config, registry, controllers: new Map(),
      limiter: new Limiter(() => 1), pathCache: new CliPathCache(() => config, spawnFn), spawnFn,
    }, { cli: 'codex', task: request.task, taskDifficulty: 'medium', difficultyReason: request.difficulty_reason, cwd: file }, new AbortController().signal))
      .rejects.toThrow('目录绝对路径')
    expect(spawnFn).not.toHaveBeenCalled()
    expect(registry.list()).toEqual([])
  })
})
