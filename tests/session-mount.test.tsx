// @vitest-environment jsdom
/**
 * 会话页的真实挂载（jsdom + 真实 effects + mock fetch）：看板覆盖层与右栏
 * tab 内容体两条路都挂一遍——SSR 静态渲染跑不到 effects，真实环境里
 * mount 阶段的崩溃（会把右栏 tab 炸成 SlotErrorBoundary 的空 deadCell，
 * 用户看到「空白」）只有真挂载才能抓到。
 */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CliSessionTabBody, cliSessionAddress } from '../src/client/board/session-tab.js'
import { SessionPage } from '../src/client/board/Session.js'
import { useCliAccess } from '../src/client/access.js'
const access = { sessionId: 'root', token: 'a'.repeat(64) }
const accessList = { byId: { root: { id: 'root', displayTitle: 'Root' } }, projectionsBySession: { root: { values: { maestroCliAccess: access } } } }
function TrustedTab(props: { useTabInfo: () => { tab: { contentId: string; navigation: { address: string; revision: number } } }; owner?: string }) {
  const owner = props.owner ?? 'root'
  const currentAccess = { sessionId: owner, token: owner === 'root' ? access.token : 'b'.repeat(64) }
  const list = owner === 'root' ? accessList : { byId: { [owner]: { id: owner, displayTitle: owner } }, projectionsBySession: { [owner]: { values: { maestroCliAccess: currentAccess } } } }
  useCliAccess(list, owner)
  return <CliSessionTabBody useTabInfo={props.useTabInfo} />
}
import { ROUTE_TASK_DETAIL } from '../src/wire.js' // 留作文档：detail 路由是 /task
import type { MaestroTaskDetail, MaestroTaskSummary } from '../src/wire.js'

// React 18 的 act 需要显式声明测试环境。
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLElement | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = undefined
  root = undefined
  errorEvents.length = 0
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const summary: MaestroTaskSummary = {
  id: 'task-a', cli: 'claude', title: 'CLI implementation', phase: 'done', model: 'gpt-6.1',
  sessionId: 'root', startedAt: Date.now() - 60_000, endedAt: Date.now(), inputPreview: '修一个登录 bug',
}

function mockRoutes(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body } as unknown as Response)
    // 注意：detail 路由是 `<prefix>/task`，与 `<prefix>/tasks` 只差一个 s，
    // 用 cursor 查询参数区分（detail 独有）。
    if (url.includes('cursor=')) {
      const detail: MaestroTaskDetail = {
        summary,
        prompt: '修一个登录 bug',
        finalText: '已修复：原因是空指针。',
        events: [
          { seq: 1, at: 1, kind: 'thinking', text: '先看入口文件' },
          { seq: 2, at: 2, kind: 'tool', text: 'Read', detail: 'src/a.ts\n{"file_path":"src/a.ts"}' },
          { seq: 3, at: 3, kind: 'text', text: '**已修复**：原因是空指针。' },
        ],
        nextCursor: 4,
      }
      return json(detail)
    }
    return json({ tasks: [summary] })
  }))
}

/** 收集 window error 事件（React 渲染崩溃在 jsdom 里走这里）。 */
const errorEvents: unknown[] = []
function captureErrors(): { thrown: () => unknown } {
  const listener = (event: ErrorEvent): void => { errorEvents.push(event.error) }
  window.addEventListener('error', listener)
  return { thrown: () => errorEvents[0] }
}

describe('SessionPage real mount', () => {
  it('mounts the panel overlay with content and no crash', async () => {
    mockRoutes()
    const errors = captureErrors()
    await act(async () => { root?.render(<SessionPage access={access} taskId='task-a' cli='claude' place='panel' onClose={() => {}} />) })
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 20) }) })
    expect(container?.textContent).toContain('看板')
    expect(container?.textContent).toContain('修一个登录 bug')
    expect(errors.thrown()).toBeUndefined()
  })

  it('mounts the sidebar tab body through a realistic useTabInfo hook', async () => {
    mockRoutes()
    // 仿真 tabInfoFactory：真 hook 形态（内部有 useState/useSyncExternalStore
    // 一族），返回 SidebarRightTabInfo 的 tab 面。
    function useTabInfo(): { tab: { contentId: string; navigation: { address: string; revision: number } } } {
      const [tick] = useState(0)
      const address = cliSessionAddress({ taskId: 'task-a', cli: 'claude', title: 'T' })
      return { tab: { contentId: address, navigation: { address, revision: tick } } }
    }
    const errors = captureErrors()
    await act(async () => { root?.render(<TrustedTab useTabInfo={useTabInfo} />) })
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 20) }) })
    // 任务详情的气泡与 composer 都在：不是空壳。
    expect(container?.textContent).toContain('修一个登录 bug')
    expect(container?.querySelector('button[aria-label]')).not.toBeNull()
    expect(errors.thrown()).toBeUndefined()
  })

  it('clears an A transcript and refuses its copied resource URL after the actual host selects B', async () => {
    mockRoutes()
    const address = cliSessionAddress({ taskId: 'task-a', cli: 'claude', sessionIds: ['root'] })
    const useTabInfo = () => ({ tab: { contentId: address, navigation: { address, revision: 0 } } })
    await act(async () => { root?.render(<TrustedTab useTabInfo={useTabInfo} owner="root" />) })
    expect(container?.textContent).toContain('修一个登录 bug')
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()
    await act(async () => { root?.render(<TrustedTab useTabInfo={useTabInfo} owner="other-parent" />) })
    expect(container?.textContent).toContain('不属于当前父会话')
    expect(container?.textContent).not.toContain('修一个登录 bug')
    expect(container?.querySelector('textarea')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(container?.innerHTML).not.toContain(access.token)
  })

  it('uses only the actual active B capability for a scope-less copied URL, not a URL-selected A capability', async () => {
    mockRoutes()
    const address = cliSessionAddress({ taskId: 'task-a', cli: 'claude' })
    const useTabInfo = () => ({ tab: { contentId: address, navigation: { address, revision: 0 } } })
    await act(async () => { root?.render(<TrustedTab useTabInfo={useTabInfo} owner="other-parent" />) })
    const calls = vi.mocked(fetch).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    for (const [, init] of calls) {
      const headers = init?.headers as Record<string, string>
      expect(Object.values(headers)).toContain('b'.repeat(64))
      expect(Object.values(headers)).not.toContain(access.token)
    }
    expect(address).not.toContain(access.token)
  })
})
