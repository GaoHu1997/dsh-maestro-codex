// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BoardCliState } from '../src/client/board/data.js'

// React 18 的 act 需要显式声明测试环境。
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* 页头 chip 的数据全部来自 board/data 的 feed；这里把 feed 换成固定快照，
 * 验证“本地 + CLI 合并计数、CLI 行带阶段/耗时/token、external 不重复”这一层。 */
vi.mock('../src/client/board/data.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/board/data.js')>()
  const state: BoardCliState = {
    tasks: [
      {
        id: 'task-1', cli: 'codex', title: '实现登录页', phase: 'running', model: 'gpt-5',
        sessionId: 's1', startedAt: Date.now() - 65_000,
      },
    ],
    loading: false,
    error: undefined,
    refresh: () => {},
    cancel: async () => undefined,
  }
  return {
    ...actual,
    useSessionList: () => ({
      byId: {
        's1': { id: 's1', displayTitle: '主会话', running: true },
        'child-1': { id: 'child-1', displayTitle: '修复同步（截断的对话）', running: true, parentId: 's1', origin: 'subagent' },
      },
      projectionsBySession: {
        's1': {
          values: {
            subagentCatalog: [
              { id: 'child-1', createdAt: 1, mode: 'continuable', label: '修复同步配置' },
              { id: 'task-1', createdAt: 2, mode: 'external', label: 'cli · 实现登录页' },
            ],
            maestroCliUsage: {
              recent: [{ taskId: 'task-1', inputTokens: 1200, outputTokens: 340, cachedInputTokens: 800, cacheWriteTokens: 0 }],
            },
          },
        },
      },
    }),
    useCliTasks: () => state,
    useNow: () => Date.now(),
    sessionOpener: () => () => {},
  }
})

const { CliCatalogChip } = await import('../src/client/header/CliCatalogChip.js')

describe('CliCatalogChip', () => {
  it('merges the local catalog and the running CLI task into one count', () => {
    const html = renderToStaticMarkup(createElement(CliCatalogChip, { sessionId: 's1', host: { get: () => undefined } }))
    expect(html).toContain('2 个子智能体')
    expect(html).toContain('data-dmc-trigger')
  })

  it('retains the owned unified trigger and explicit executor summaries with legacy nativeCatalog=true', () => {
    const html = renderToStaticMarkup(createElement(CliCatalogChip, { sessionId: 's1', nativeCatalog: true, host: { get: () => undefined } }))
    expect(html).toContain('2 个子智能体')
    expect(html).toContain('data-dmc-trigger')
    expect(html).toContain('data-cli-summary="DSH"')
    expect(html).toContain('data-cli-summary="codex"')
    expect(html).toContain('data-cli-icon="DSH"')
    expect(html).toContain('data-cli-icon="codex"')
    expect(html).toContain('Codex 1 个')
    expect(html).not.toContain('CLI 任务 (')
  })

  it('hides itself on subagent sessions (the core lineage chip owns that header)', () => {
    const html = renderToStaticMarkup(createElement(CliCatalogChip, { sessionId: 'child-1', host: { get: () => undefined } }))
    expect(html).toBe('')
  })
})

/* 菜单行要等触发器点开才渲染，静态渲染只出 chip 本体；这里直接驱动组件
 * 的菜单层：行头执行者徽标 + 副行的模式词（已移除）。 */
describe('header catalog menu rows', () => {
  const roots: Root[] = []
  afterEach(() => {
    act(() => { for (const root of roots.splice(0)) root.unmount() })
    document.querySelector('.dmch-menu')?.remove()
    document.body.innerHTML = ''
    document.body.removeAttribute('data-maestro-cli-header')
  })

  const renderMenu = (): HTMLElement => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => {
      root.render(createElement(CliCatalogChip, { sessionId: 's1', host: { get: () => undefined } }))
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-dmc-trigger]')?.click()
    })
    const menu = document.querySelector<HTMLElement>('.dmch-menu')
    if (menu === null) throw new Error('menu did not open')
    return menu
  }

  it('badges every row with its executor and drops the mode words', () => {
    const menu = renderMenu()
    const badges = [...menu.querySelectorAll<HTMLElement>('[data-cli-executor]')].map(badge => badge.dataset.cliExecutor)
    // dsh 原生行标 DSH；CLI 行标它真正的执行者（不是笼统的 CLI）。
    expect(badges.sort()).toEqual(['DSH', 'codex'])
    for (const executor of badges) {
      const icon = menu.querySelector(`[data-cli-executor="${executor}"] [data-cli-icon="${executor}"]`)
      expect(icon).not.toBeNull()
      expect(icon?.getAttribute('role')).toBe('img')
    }
    expect(menu.textContent).toContain('运行中')
    expect(menu.textContent).toContain('tok')
    expect(menu.textContent).not.toContain('可续接')
    expect(menu.textContent).not.toContain('一次性')
    // CLI 行副行不再重复 CLI 名（执行者徽标已经说了）。
    expect(menu.textContent).not.toContain('codex cli')
  })
})
