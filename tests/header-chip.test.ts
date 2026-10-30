import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { BoardCliState } from '../src/client/board/data.js'

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

  it('hides itself on subagent sessions (the core lineage chip owns that header)', () => {
    const html = renderToStaticMarkup(createElement(CliCatalogChip, { sessionId: 'child-1', host: { get: () => undefined } }))
    expect(html).toBe('')
  })
})
