import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import { BoardTab } from '../src/client/board/Board.js'
import type { BoardHost, BoardSessionList } from '../src/client/board/data.js'
import { attachRows, buildSessionTree, type BoardJob, type BoardJobRow } from '../src/client/board/model.js'
import { boardRendererInput, boardRootId, hasBoardTranscriptAside, jumpBoardNode, renderBoardNodes } from '../src/client/board/bridge.js'
import { CliNodePopover, cliTranscriptItems } from '../src/client/board/cli-detail.js'
import { AgentNodePopover, TasksGraph, TasksTree, type TasksAgentNode } from '../src/client/board/upstream/index.js'
import { attachLocale } from '../src/client/board/upstream/client/locales.js'
import type { MaestroTaskSummary } from '../src/wire.js'

/** SSR exercises the genuine upstream renderer, without running HTTP effects. */
function host(options: {
  list?: BoardSessionList
  jobRows?: readonly BoardJobRow[]
  withSessions?: boolean
  withJobs?: boolean
} = {}): BoardHost {
  const list = options.list ?? { byId: {} }
  const rows: Record<string, BoardJob[]> = {}
  for (const row of options.jobRows ?? []) (rows[row.ownerSessionId] ??= []).push(row.job)
  const jobSnapshot = { rows, observed: {} }
  const services: Record<string, unknown> = {
    uiWorkspace: { openSession: () => {} },
    locale: { getSnapshot: () => ({ active: 'zh-CN', revision: 0 }), subscribe: () => () => {} },
  }
  if (options.withSessions !== false) {
    services.sessions = { list: { getSnapshot: () => list, subscribe: () => () => {} } }
  }
  if (options.withJobs !== false) {
    services.jobs = {
      state: { getSnapshot: () => jobSnapshot, subscribe: () => () => {} },
      watchRows: () => () => {}, observe: () => () => {}, kill: async () => {},
    }
  }
  return { get: name => services[name] }
}
const job: BoardJob = {
  id: 'job-1', kind: 'workflow', label: '夜间迁移工作流', status: 'running', startedAt: 1_700_000_000_000,
}
function render(input: { host?: BoardHost; visible?: boolean; sessionId?: string } = {}): string {
  return renderToStaticMarkup(createElement(BoardTab, {
    ctx: input.host ?? host(), scope: { sessionId: input.sessionId ?? 'root', cwd: '/work/repo' },
    ...(input.visible === undefined ? {} : { visible: input.visible }),
  }))
}
const list: BoardSessionList = {
  byId: {
    root: { id: 'root', displayTitle: '主任务', cwd: '/work/repo', running: true },
    review: { id: 'review', displayTitle: '代码审查', parentId: 'root', running: true },
  },
  projectionsBySession: {
    root: { values: {
      subagentCatalog: [
        { id: 'review', createdAt: 1, mode: 'continuable' },
        { id: 'cli-2', createdAt: 2, mode: 'external', label: 'code CLI 子代理' },
      ],
      tokenUsage: { uncachedInputTokens: 1500, outputTokens: 200, cacheReadTokens: 9000, cacheWriteTokens: 0 },
    } },
  },
}
function source(currentId = 'root') {
  return boardRendererInput(buildSessionTree({
    rootId: 'root', sessions: list.byId,
    catalogs: { root: list.projectionsBySession?.root?.values.subagentCatalog },
    tokens: { root: list.projectionsBySession?.root?.values.tokenUsage },
  }), currentId)
}
function agent(nodes: ReturnType<typeof renderBoardNodes>, id: string): TasksAgentNode {
  const node = nodes.find(node => node.id === id)
  if (node?.kind !== 'agent') throw new Error(`Missing agent ${id}`)
  return node
}
function rendererProps(nodes: ReturnType<typeof renderBoardNodes>) {
  return {
    nodes, folded: false, rootId: 'root', onNodeInfo: () => {}, onWorkflowInfo: () => {},
    onOpenTask: () => {}, onToggleFold: () => {}, onExpandGroup: () => {}, onFoldNode: () => {},
    mode: 'graph' as const, onModeChange: () => {},
  }
}

beforeEach(() => attachLocale({ getSnapshot: () => ({ active: 'zh-CN' }) }))

describe('BoardTab original renderer integration', () => {
  it('renders the exact original header and graph controls, not custom filters', () => {
    const html = render({ host: host({ list }) })
    expect(html).toContain('任务管理')
    expect(html).toContain('主任务')
    expect(html).toContain('2 个子代理 · 1 运行中')
    for (const name of ['subagentHeader', 'subagentHeading', 'subagentSubject', 'subagentCount', 'subagentRefresh']) {
      expect(html).toContain(`dsh_maestro_upstream_SubagentView_${name}`)
    }
    expect(html).toContain('data-graph-controls')
    expect(html).toContain('aria-label="刷新"')
    expect(html).not.toContain('dmb-')
    expect(html).not.toContain('<select')
  })

  it('uses absolute original cards and genuine cubic SVG edges', () => {
    const html = render({ host: host({ list }) })
    expect(html).toContain('role="group" aria-label="工作流图"')
    expect(html).toContain('data-graph-node="root"')
    expect(html).toContain('data-graph-node="review"')
    expect(html).toMatch(/style="left:[^;]+;top:[^;]+;width:[^;]+;min-height:/)
    expect(html).toContain('<svg')
    expect(html).toMatch(/<path[^>]+d="M [^"]+ C /)
    expect(html).toContain('data-card-kind="main"')
    expect(html).toContain('dsh_maestro_upstream_tasks_graph_edge')
  })

  it('preserves native mode and billed-token detail in the original popover', () => {
    const nodes = renderBoardNodes(source(), { folded: false })
    const popover = renderToStaticMarkup(createElement(AgentNodePopover, {
      node: agent(nodes, 'root'), asideAvailable: false, onJump: () => {}, onOpenTask: () => {}, onClose: () => {},
    }))
    expect(popover).toContain('10.7K')
    expect(popover).toContain('dsh_maestro_upstream_tasks_graph_popRows')
    expect(render({ host: host({ list }) })).toContain('可续接')
  })

  it('retains session-less external nodes without fabricating transcript addresses', () => {
    const nodes = renderBoardNodes(source(), { folded: false })
    const ghost = agent(nodes, 'cli-2')
    expect(ghost.label).toBe('code CLI 子代理')
    expect(ghost.childAddress).toBeUndefined()
    expect(jumpBoardNode(host(), ghost, 'main')).toBe(false)
    const html = renderToStaticMarkup(createElement(TasksGraph, rendererProps(nodes)))
    expect(html).toContain('data-graph-node="cli-2"')
    expect(html).toContain('code CLI 子代理')
  })

  it('keeps jobs in the original bottom drawer rather than graph nodes', () => {
    const html = render({ host: host({ list, jobRows: [{ ownerSessionId: 'root', job }] }) })
    expect(html).toContain('dsh_maestro_upstream_tasks_graph_jobsDrawer')
    expect(html).toContain('dsh_maestro_upstream_tasks_graph_jobsRowMain')
    expect(html).toContain('夜间迁移工作流')
    expect(html).not.toContain('data-graph-node="job:')
    expect(html).toContain('2 个子代理')
    expect(html.match(/class="[^"]*jobsLabel[^"]*"/g)).toHaveLength(1)
  })

  it('drops roster rows owned outside the scoped tree', () => {
    const html = render({ host: host({ list, jobRows: [{ ownerSessionId: 'nope', job: { ...job, owner: 'nope' } }] }) })
    expect(html).not.toContain('夜间迁移工作流')
    expect(html).not.toContain('jobsDrawer')
  })

  it('hides the jobs drawer when the host has no jobs service', () => {
    expect(render({ host: host({ list, withJobs: false }) })).not.toContain('jobsDrawer')
  })

  it('folds completed siblings through the original dashed graph group', () => {
    const html = render({ host: host({ list: { byId: {
      root: { id: 'root', displayTitle: '主任务', running: true },
      a: { id: 'a', displayTitle: '甲', parentId: 'root' },
      b: { id: 'b', displayTitle: '乙', parentId: 'root' },
    } } }) })
    expect(html).toContain('✓ 2 已完成')
    expect(html).toContain('data-graph-node="fold:root"')
    expect(html).toContain('dsh_maestro_upstream_tasks_graph_nodeFold')
    expect(html).toContain('dsh_maestro_upstream_tasks_graph_edgeFold')
    expect(html).not.toContain('data-graph-node="a"')
    expect(html).not.toContain('data-graph-node="b"')
  })

  it('degrades to the current-session card if optional host services are missing', () => {
    const html = render({ host: host({ withSessions: false, withJobs: false }) })
    expect(html).toContain('任务管理')
    expect(html).toContain('当前会话')
    expect(html).toContain('data-graph-node="root"')
  })

  it('omits a running count when nothing is running', () => {
    expect(render({ host: host({ withSessions: false, withJobs: false }) })).not.toContain('1 运行中')
  })

  it('scopes at an ancestor and marks the actual current child', () => {
    expect(boardRootId('review', list.byId)).toBe('root')
    const html = render({ host: host({ list }), sessionId: 'review', visible: false })
    expect(html).toContain('data-maestro-board-root="root"')
    expect(html).toContain('data-graph-node="review"')
    expect(agent(renderBoardNodes(source('review'), { folded: true }), 'review').current).toBe(true)
  })

  it('retains the original table renderer and collapse/mode controls', () => {
    const html = renderToStaticMarkup(createElement(TasksTree, {
      ...rendererProps(renderBoardNodes(source(), { folded: false })), mode: 'tree',
      collapsedIds: new Set<string>(), onToggleCollapse: () => {}, onCollapseAll: () => {}, onExpandAll: () => {},
    }))
    expect(html).toContain('代码审查')
    expect(html).toContain('dsh_maestro_upstream_tasks_graph_treeRow')
    expect(html).toContain('aria-label="全部收起"')
    expect(html).toContain('aria-label="全部展开"')
    expect(html).toContain('aria-expanded="true"')
  })
})

describe('CLI and native navigation bridge', () => {
  it('adds a minimal CLI label/detail/cancel while keeping original cards', () => {
    const task: MaestroTaskSummary = {
      id: 'task-a', cli: 'codex', title: 'CLI implementation', phase: 'running', model: 'provider::model',
      sessionId: 'root', startedAt: 10, truncated: true,
    }
    const tree = attachRows(buildSessionTree({ rootId: 'root', sessions: list.byId }), { tasks: [task] })
    const input = boardRendererInput(tree, 'root')
    const nodes = renderBoardNodes(input, { folded: false })
    const row = input.byNodeId.get('cli:task-a')
    if (row === undefined) throw new Error('Missing CLI row')
    expect(agent(nodes, row.id).childAddress).toBeUndefined()
    const graph = renderToStaticMarkup(createElement(TasksGraph, rendererProps(nodes)))
    expect(graph).toContain('codex cli · CLI implementation')
    expect(graph).toContain('data-graph-node="cli:task-a"')
    const html = renderToStaticMarkup(createElement(CliNodePopover, {
      node: row, now: 100, onOutput: () => {}, onCancel: async () => undefined,
    }))
    expect(html).toContain('dsh_maestro_upstream_tasks_graph_popCard')
    for (const text of ['codex cli', 'provider::model', '取消任务', '查看转录', '较早输出已截断']) expect(html).toContain(text)
  })

  it('merges consecutive CLI chunks using newlines, keeping outcome boundaries', () => {
    const events = cliTranscriptItems([
      { seq: 1, at: 1, kind: 'text', text: 'first' }, { seq: 2, at: 2, kind: 'text', text: 'second' },
      { seq: 3, at: 3, kind: 'error', text: 'failure' }, { seq: 4, at: 4, kind: 'result', text: 'final result' },
    ])
    expect(events.map(event => event.kind)).toEqual(['text', 'error', 'result'])
    expect(events[0]?.text).toBe('first\nsecond')
  })

  it('uses native parent/child addresses in the main and right transcript panes', () => {
    const calls: unknown[] = []
    const services: Record<string, unknown> = {
      uiWorkspace: { openSession: (target: unknown) => calls.push(target) },
      sidebarRightTabs: { get: () => ({}) },
      sidebarRight: { openResource: (target: unknown, options: unknown) => calls.push([target, options]) },
    }
    const ctx: BoardHost = { get: name => services[name] }
    const node = agent(renderBoardNodes(source(), { folded: false }), 'review')
    expect(hasBoardTranscriptAside(ctx)).toBe(true)
    expect(jumpBoardNode(ctx, node, 'main')).toBe(true)
    expect(calls[0]).toEqual({ parentSessionId: 'root', childSessionId: 'review', mode: 'continuable' })
    expect(jumpBoardNode(ctx, node, 'side')).toBe(true)
    expect(calls[1]).toEqual([
      'dsh-resource://subagentchat/session/review?parent=root&mode=continuable',
      { kind: 'subagentchat', preferNewPane: true },
    ])
  })
})
