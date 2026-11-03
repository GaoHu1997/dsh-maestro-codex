// @vitest-environment jsdom
/**
 * 会话页 composer 的三段同构（宿主 InputBar 的画法）与能力补齐：
 * 卡外 notice → 卡片（输入行 + 工具行）→ 卡外 footer（轮次 / 用量 /
 * 续接引用）。工具行里只有只读 CLI 徽标与唯一主操作——CLI 续发没有附件、
 * @ 引用、模型选择的协议支撑，不能放看起来能点却没有后端的控件。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MaestroTaskSummary } from '../src/wire.js'

const { SessionPage } = await import('../src/client/board/Session.js')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const access = { sessionId: 'owner-a', token: 'a'.repeat(64) }
const summary: MaestroTaskSummary = {
  id: 'task-a', sessionId: 'owner-a', cli: 'codex', title: 'task title', phase: 'done', model: 'm',
  startedAt: 1_000, endedAt: 61_000, durationMs: 60_000, sessionRef: 'abcdef0123456789',
  usage: { uncachedInputTokens: 1_000, outputTokens: 2_000, cacheReadTokens: 3_000, cacheWriteTokens: 500 },
}
const response = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body } as Response)
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mount(tasks: MaestroTaskSummary[] = [summary], taskId = 'task-a'): Promise<ReturnType<typeof vi.fn>> {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://host')
    return url.searchParams.has('cursor')
      ? response({ summary: tasks.find(task => task.id === taskId) ?? tasks[0], events: [], nextCursor: 0 })
      : response({ tasks })
  })
  vi.stubGlobal('fetch', mock)
  await act(async () => {
    root.render(<SessionPage taskId={taskId} access={access} sessionIds={['owner-a']} place="panel" />)
  })
  return mock
}

function composer(): HTMLElement {
  const element = container.querySelector<HTMLElement>('.dms-composer')
  expect(element).not.toBeNull()
  return element!
}

describe('composer 三段同构', () => {
  it('把输入卡与统计条分成卡内 / 卡外两层，并把 CLI 徽标放进工具行', async () => {
    await mount()
    const root = composer()
    const card = root.querySelector<HTMLElement>('.dms-card')
    const stats = root.querySelector<HTMLElement>('.dms-stats')
    expect(card).not.toBeNull()
    expect(stats).not.toBeNull()
    expect(card!.contains(stats!)).toBe(false)
    expect(card!.querySelector('.dms-inputrow textarea')).not.toBeNull()
    const toolrow = card!.querySelector<HTMLElement>('.dms-toolrow')
    expect(toolrow).not.toBeNull()
    // 左下角是当前 CLI 的品牌 logo（不再是通用代码图标），文字只留在 tooltip。
    const badge = toolrow!.querySelector<HTMLElement>('.dms-cli-badge')
    expect(badge?.dataset['cli']).toBe('codex')
    expect(badge?.getAttribute('aria-label')).toBe('codex cli')
    expect(badge?.title).toContain('codex cli')
    expect(badge?.querySelector('.dms-cli-logo')).not.toBeNull()
    // 工具行左侧只有只读徽标：没有假控件的入口。
    const left = toolrow!.querySelector<HTMLElement>('.dms-toolrow-left')
    expect(left!.querySelector('button, input, select, textarea, [role="button"]')).toBeNull()
  })

  it('footer 按宿主 StatsPills 的顺序与文案：tok/s，总量 · 缓存命中', async () => {
    await mount()
    const stats = container.querySelector<HTMLElement>('.dms-stats')
    const text = stats!.textContent ?? ''
    // 状态一律不在 footer：页头徽标与看板已经常驻显示阶段。
    expect(stats!.querySelector('[data-composer-stat="status"]')).toBeNull()
    expect(text).not.toContain('已完成')
    // 单轮也报轮次：这是宿主 ActivityPill 的固定读数，不是可有可无的信息。
    expect(text).toContain('1 轮')
    // 1000 + 2000 + 3000 + 500 = 6500 → 6.5k（宿主单位是 tok，不是 tokens）
    expect(text).toContain('6.5k tok')
    // 3000 / (1000 + 3000) = 75%
    expect(text).toContain('缓存命中 75%')
    // 2000 output / 60 s = 33 tok/s
    expect(text).toContain('33 tok/s')
    // 宿主把「轮次 · 速度」放同一个 pill，「总量 · 缓存命中」放下一个。
    const activity = stats!.querySelector('[data-composer-stat="activity"]')
    expect(activity?.textContent).toContain('1 轮')
    expect(activity?.textContent).toContain('33 tok/s')
    const usage = stats!.querySelector('[data-composer-stat="usage"]')
    expect(usage?.textContent).toContain('6.5k tok')
    expect(usage?.querySelector('svg')).not.toBeNull()
    // 分隔符与宿主一致是 "·" 文本，不是自绘竖线。
    expect(stats!.querySelector('.dms-sep')?.textContent).toBe('·')
  })

  it('多轮链路才报轮次，且与速度同格', async () => {
    const first: MaestroTaskSummary = { ...summary, id: 'task-a' }
    const second: MaestroTaskSummary = { ...summary, id: 'task-b', replyTo: 'task-a', startedAt: 2_000 }
    await mount([first, second], 'task-b')
    const activity = container.querySelector<HTMLElement>('[data-composer-stat="activity"]')
    expect(activity?.textContent).toContain('2 轮')
    expect(activity?.textContent).toContain('33 tok/s')
  })

  it('没有数据的读数整块不渲染，不留空 pill 或孤立分隔符', async () => {
    const bare: MaestroTaskSummary = { ...summary, endedAt: undefined, durationMs: undefined, usage: undefined }
    await mount([bare])
    const stats = container.querySelector<HTMLElement>('.dms-stats')
    expect(stats!.querySelector('[data-composer-stat="usage"]')).toBeNull()
    // 没有用量也要有轮次：单轮同样显示。
    expect(stats!.querySelector('[data-composer-stat="activity"]')?.textContent).toBe('1 轮')
    expect(stats!.textContent).not.toContain('缓存命中')
    expect(stats!.textContent).not.toContain('tok/s')
    expect(stats!.textContent).not.toContain('tok')
    // 剩下的 pill 之间不能出现连续或悬空的分隔符。
    expect(stats!.textContent).not.toMatch(/·\s*·|·\s*$/)
  })

  it('任何阶段都不在 footer 出现状态格', async () => {
    for (const phase of ['running', 'queued', 'failed', 'timeout', 'interrupted', 'cancelled'] as const) {
      await mount([{ ...summary, phase }])
      expect(container.querySelector('[data-composer-stat="status"]')).toBeNull()
    }
  })

  it('续接引用只在后台使用，不在 footer 展示', async () => {
    await mount()
    expect(container.querySelector('.dms-refcopy')).toBeNull()
    expect(container.querySelector<HTMLElement>('.dms-stats')!.textContent).not.toContain('resume')
  })

  it('窄栏规则交给容器查询，不在 JS 里猜宽度', async () => {
    await mount()
    const css = document.getElementById('dsh-maestro-codex-session-styles')?.textContent ?? ''
    expect(css).toContain('@container dms-composer (max-width: 560px)')
    expect(css).toContain('container-type: inline-size')
    // 图标与宿主 StatsPills 同规格。
    expect(css).toContain('.dms-stat-pill svg')
  })
})

describe('运行态的唯一主操作', () => {
  it('发送钮换成停止钮，点击取消该轮而不是再发一条', async () => {
    const running: MaestroTaskSummary = { ...summary, phase: 'running', endedAt: undefined, durationMs: undefined }
    const mock = await mount([running])
    const stop = container.querySelector<HTMLButtonElement>('.dms-card .dms-stop')
    expect(stop).not.toBeNull()
    expect(container.querySelector('.dms-card .dms-send')).toBeNull()
    expect(container.querySelector<HTMLTextAreaElement>('.dms-textarea')?.disabled).toBe(true)
    await act(async () => { stop!.click() })
    const cancelCall = mock.mock.calls.map(call => call as unknown[]).find(call => String(call[0]).includes('/task/cancel'))
    expect(cancelCall).toBeDefined()
    expect((cancelCall![1] as RequestInit).method).toBe('POST')
  })

  it('空草稿时发送钮禁用，输入后启用', async () => {
    await mount()
    const send = container.querySelector<HTMLButtonElement>('.dms-card .dms-send')
    expect(send).not.toBeNull()
    expect(send!.disabled).toBe(true)
    const textarea = container.querySelector<HTMLTextAreaElement>('.dms-textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(textarea, '继续')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector<HTMLButtonElement>('.dms-card .dms-send')!.disabled).toBe(false)
  })
})
