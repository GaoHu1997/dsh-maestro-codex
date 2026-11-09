import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GROK_FS_TIMEOUT_MS, runGrokTask } from '../src/channels/grok.js'

/**
 * A hung home directory (network mount, stuck lock) must fail the run within
 * the bounded pre-run budget instead of blocking dispatch forever.
 */
const fsState = vi.hoisted(() => ({ openHang: false, writeHang: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: (...args: unknown[]) => fsState.openHang ? new Promise<never>(() => {}) : (actual.open as (...a: unknown[]) => unknown)(...args),
    writeFile: (...args: unknown[]) => fsState.writeHang ? new Promise<never>(() => {}) : (actual.writeFile as (...a: unknown[]) => unknown)(...args),
  }
})

const FS_TIMEOUT_MS = 50

function grokOptions(home: string) {
  return {
    grokPath: process.execPath,
    task: 'hello',
    cwd: undefined,
    model: 'grok-code',
    permissionMode: 'inherit' as const,
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'test-key',
    grokHome: home,
    timeoutMs: 10_000,
    fsTimeoutMs: FS_TIMEOUT_MS,
    signal: new AbortController().signal,
    onEvent: () => {},
  }
}

afterEach(() => {
  fsState.openHang = false
  fsState.writeHang = false
  vi.restoreAllMocks()
})

describe('grok pre-run filesystem bounds', () => {
  it('defaults the pre-run budget to 30 seconds', () => {
    expect(GROK_FS_TIMEOUT_MS).toBe(30_000)
  })

  it('fails the run when the cross-process lease never returns', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-grok-fs-'))
    try {
      fsState.openHang = true
      const error = await runGrokTask(grokOptions(home)).then(() => null, (e: unknown) => e as Error)
      expect(error).toBeInstanceOf(Error)
      expect(error?.message).toContain('Grok 目录租约获取')
      expect(error?.message).toContain('已停止等待')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('releases the in-process home gate after a lease timeout', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-grok-gate-'))
    try {
      fsState.openHang = true
      const first = await runGrokTask(grokOptions(home)).then(() => null, (e: unknown) => e as Error)
      expect(first?.message).toContain('Grok 目录租约获取')
      // A second run must reach the same (hanging) lease step instead of
      // queueing forever behind a leaked in-memory gate.
      const second = await runGrokTask(grokOptions(home)).then(() => null, (e: unknown) => e as Error)
      expect(second?.message).toContain('Grok 目录租约获取')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('fails the run when the config write never returns and still frees the lease', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-grok-config-'))
    try {
      fsState.writeHang = true
      const error = await runGrokTask(grokOptions(home)).then(() => null, (e: unknown) => e as Error)
      expect(error?.message).toContain('Grok 配置写入')

      // The run's finally released the file lease.
      fsState.writeHang = false
      await expect(access(join(home, '.maestro-run.lock'))).rejects.toThrow()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
