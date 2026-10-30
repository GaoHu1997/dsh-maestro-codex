/**
 * The SDK tab's action buttons: while one CLI's `npm -g` job runs, that card
 * must show 「安装中…」/「卸载中…」 and refuse a second click. These tests pin the
 * three helpers that make that decision (the render just wires them together):
 * `liveNpmTask` (what the overview says runs), `npmRunningOf` (job + the click
 * the card just fired, so the button locks before the 4s poll catches up) and
 * `sdkActionButtons` (labels + disabled flags).
 */
import { describe, expect, it } from 'vitest'
import {
  liveNpmTask,
  npmRunningOf,
  sdkActionButtons,
  type NpmRunning,
} from '../src/client/MaestroCard.js'
import type { MaestroPhase, MaestroTaskSummary } from '../src/wire.js'

function task(overrides: Partial<MaestroTaskSummary> & Pick<MaestroTaskSummary, 'id' | 'cli'>): MaestroTaskSummary {
  return {
    title: `安装/更新 ${overrides.cli}`,
    phase: 'running' as MaestroPhase,
    model: '',
    startedAt: 1,
    ...overrides,
  }
}

const idle = { busy: false, installed: false, current: '', selected: '' }

describe('liveNpmTask', () => {
  it('finds the non-terminal npm job of that CLI only', () => {
    const tasks = [
      task({ id: 'npm-aaaa1111', cli: 'claude' }),
      task({ id: 'npm-bbbb2222', cli: 'codex' }),
    ]
    expect(liveNpmTask(tasks, 'claude')?.id).toBe('npm-aaaa1111')
    expect(liveNpmTask(tasks, 'codex')?.id).toBe('npm-bbbb2222')
  })

  it('ignores agent tasks, finished jobs and unknown CLIs', () => {
    const tasks = [
      task({ id: 'task-1111', cli: 'claude' }),
      task({ id: 'npm-cccc3333', cli: 'claude', phase: 'done' }),
      task({ id: 'npm-dddd4444', cli: 'claude', phase: 'failed' }),
      task({ id: 'npm-eeee5555', cli: 'claude', phase: 'queued' }),
    ]
    expect(liveNpmTask(tasks, 'claude')?.id).toBe('npm-eeee5555')
    expect(liveNpmTask(tasks, 'codex')).toBeUndefined()
  })
})

describe('npmRunningOf', () => {
  it('is idle with neither a live job nor a click', () => {
    expect(npmRunningOf([], 'claude', undefined)).toBeUndefined()
  })

  it('reports the click action while the overview has not caught up yet', () => {
    // The window that used to allow a duplicate: request fired, poll still empty.
    expect(npmRunningOf([], 'claude', { id: '', action: 'install', at: 1 })).toBe('install')
    expect(npmRunningOf([], 'claude', { id: '', action: 'uninstall', at: 1 })).toBe('uninstall')
  })

  it('keeps the click action once its task shows up under the same id', () => {
    const tasks = [task({ id: 'npm-aaaa1111', cli: 'claude', title: '卸载 Claude Code（npm -g @anthropic-ai/claude-code）' })]
    expect(npmRunningOf(tasks, 'claude', { id: 'npm-aaaa1111', action: 'uninstall', at: 1 })).toBe('uninstall')
  })

  it('reads the action off the title for a job this card did not start', () => {
    const install = [task({ id: 'npm-aaaa1111', cli: 'claude', title: '安装 1.2.3 Claude Code（npm -g @anthropic-ai/claude-code）' })]
    const uninstall = [task({ id: 'npm-bbbb2222', cli: 'claude', title: '卸载 Claude Code（npm -g @anthropic-ai/claude-code）' })]
    expect(npmRunningOf(install, 'claude', undefined)).toBe('install')
    expect(npmRunningOf(uninstall, 'claude', undefined)).toBe('uninstall')
  })

  it('does not leak one CLI’s job onto the other card', () => {
    const tasks = [task({ id: 'npm-aaaa1111', cli: 'claude' })]
    expect(npmRunningOf(tasks, 'claude', undefined)).toBe('install')
    expect(npmRunningOf(tasks, 'codex', undefined)).toBeUndefined()
  })

  it('unlocks once the job is terminal', () => {
    const tasks = [task({ id: 'npm-aaaa1111', cli: 'claude', phase: 'failed' })]
    expect(npmRunningOf(tasks, 'claude', undefined)).toBeUndefined()
  })
})

describe('sdkActionButtons', () => {
  it('installs the registry latest when nothing is selected', () => {
    expect(sdkActionButtons({ running: undefined, ...idle })).toEqual({
      installLabel: '安装最新版',
      installDisabled: false,
      uninstallLabel: '卸载',
      uninstallDisabled: true,
      locked: false,
    })
  })

  it('installs a pinned version', () => {
    const buttons = sdkActionButtons({ running: undefined, ...idle, selected: '2.1.0' })
    expect(buttons.installLabel).toBe('安装 v2.1.0')
    expect(buttons.installDisabled).toBe(false)
  })

  it('disables both buttons while this CLI is installing', () => {
    const buttons = sdkActionButtons({ running: 'install', ...idle, installed: true, current: '1.0.0', selected: '2.0.0' })
    expect(buttons.installLabel).toBe('安装中…')
    expect(buttons.uninstallLabel).toBe('卸载')
    expect(buttons.installDisabled).toBe(true)
    expect(buttons.uninstallDisabled).toBe(true)
    expect(buttons.locked).toBe(true)
  })

  it('disables both buttons while this CLI is uninstalling', () => {
    const buttons = sdkActionButtons({ running: 'uninstall', ...idle, installed: true, current: '1.0.0' })
    expect(buttons.uninstallLabel).toBe('卸载中…')
    expect(buttons.installLabel).toBe('安装最新版')
    expect(buttons.installDisabled).toBe(true)
    expect(buttons.uninstallDisabled).toBe(true)
  })

  it('keeps the version picker locked through a running job', () => {
    const running: NpmRunning = 'install'
    expect(sdkActionButtons({ running, busy: false, installed: false, current: '', selected: '' }).locked).toBe(true)
  })

  it('stays locked for any other in-flight request (busy)', () => {
    const buttons = sdkActionButtons({ ...idle, busy: true, installed: true, current: '1.0.0', selected: '2.0.0' })
    expect(buttons.installDisabled).toBe(true)
    expect(buttons.uninstallDisabled).toBe(true)
  })

  it('offers no reinstall of the version already running', () => {
    const buttons = sdkActionButtons({ running: undefined, busy: false, installed: true, current: '1.0.0', selected: '1.0.0' })
    expect(buttons.installLabel).toBe('当前版本')
    expect(buttons.installDisabled).toBe(true)
    expect(buttons.uninstallDisabled).toBe(false)
  })

  it('lets an uninstalled CLI shrink back to 「安装最新版」 after a job ends', () => {
    const buttons = sdkActionButtons({ running: undefined, ...idle })
    expect(buttons.installDisabled).toBe(false)
    expect(buttons.uninstallDisabled).toBe(true)
  })
})
