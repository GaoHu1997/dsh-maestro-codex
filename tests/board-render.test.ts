import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import { BoardTab } from '../src/client/board/Board.js'
import type { BoardHost, BoardSessionList } from '../src/client/board/data.js'
import { attachRows, buildSessionTree, type BoardJob, type BoardJobRow } from '../src/client/board/model.js'
import { boardRendererInput, boardRootId, groupMemberIds, hasBoardCliSessionAside, hasBoardTranscriptAside, jumpBoardAddress, jumpBoardCliSession, jumpBoardNode, renderBoardNodes, withBoardNative } from '../src/client/board/bridge.js'
import { CliNodePopover } from '../src/client/board/cli-detail.js'
import { flowBlocksOf } from '../src/client/board/Session.js'
import { applyBoardCopy } from '../src/client/board/copy.js'
import { AgentNodePopover, TasksGraph, TasksTree, foldGroupId, type TasksAgentNode, type TasksFoldNode } from '../src/client/board/upstream/index.js'
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

beforeEach(() => {
  applyBoardCopy()
  attachLocale({ getSnapshot: () => ({ active: 'zh-CN' }) })
})

describe('BoardTab original renderer integration', () => {
  it('renders the exact original header and graph controls, not custom filters', () => {
    const html = render({ host: host({ list }) })
    expect(html).toContain('任务管理')
    expect(html).toContain('主任务')
    expect(html).toContain('2 个子智能体 · 1 运行中')
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

  it('drops the mode word and badges subagents by source in the original cards', () => {
    const nodes = renderBoardNodes(source(), { folded: false })
    const popover = renderToStaticMarkup(createElement(AgentNodePopover, {
      node: agent(nodes, 'review'), asideAvailable: false, onJump: () => {}, onOpenTask: () => {}, onClose: () => {},
    }))
    expect(popover).toContain('dsh_maestro_upstream_tasks_graph_popRows')
    // 「可续接 / 一次性」模式词从卡片、meta 行与详情浮层整体移除。
    expect(popover).not.toContain('模式')
    const html = render({ host: host({ list }) })
    expect(html).not.toContain('可续接')
    // 来源标识：dsh 原生子智能体右上角 DSH 徽标；主智能体与 CLI 幽灵行没有。
    expect(html).toContain('data-cli-executor="DSH"')
    expect(agent(nodes, 'review').executor).toBe('DSH')
    expect(nodes.find(node => node.id === 'root')?.executor).toBeUndefined()
    expect(nodes.find(node => node.id === 'cli-2')?.executor).toBeUndefined()
  })

  it('retains session-less external nodes without fabricating transcript addresses', () => {
    const nodes = renderBoardNodes(source(), { folded: false })
    const ghost = agent(nodes, 'cli-2')
    expect(ghost.label).toBe('code CLI 子代理')
    expect(ghost.childAddress).toBeUndefined()
    expect(jumpBoardNode(host(), ghost)).toBe(false)
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
    expect(html).toContain('2 个子智能体')
    expect(html.match(/class="[^"]*jobsLabel[^"]*"/g)).toHaveLength(1)
  })

  it('docks the jobs drawer below the canvas in a fixed-height slot', () => {
    const html = render({ host: host({ list, jobRows: [{ ownerSessionId: 'root', job }] }) })
    // 槽位包裹抽屉，并排在画布之后（看板底部）。
    const canvas = html.indexOf('dsh_maestro_upstream_tasks_graph_graphView')
    const dock = html.indexOf('data-maestro-jobs-dock')
    expect(html).toContain('data-maestro-jobs-dock=""')
    expect(canvas).toBeGreaterThan(-1)
    expect(dock).toBeGreaterThan(canvas)
    expect(dock).toBeLessThan(html.indexOf('dsh_maestro_upstream_tasks_graph_jobsDrawer'))
    // 固定 1/5 的槽位不能再被“代理较多”自动收起，否则只剩 28px 标题栏。
    expect(html).not.toContain('dsh_maestro_upstream_tasks_graph_jobsAutoNote')
    expect(html).toContain('dsh_maestro_upstream_tasks_graph_jobsDrawerBody')
  })

  it('draws an empty dock pinned at the bottom when no job belongs to the scoped tree', () => {
    const html = render({ host: host({ list }) })
    // 后台任务为空也要保留停靠槽（空态自绘抽屉），固定在看板底部。
    expect(html).toContain('data-maestro-jobs-dock=""')
    expect(html).toContain('dsh_maestro_upstream_tasks_graph_jobsDrawer')
    expect(html).toContain('dsh_maestro_upstream_tasks_graph_jobsDrawerBody')
  })

  it('drops roster rows owned outside the scoped tree', () => {
    const html = render({ host: host({ list, jobRows: [{ ownerSessionId: 'nope', job: { ...job, owner: 'nope' } }] }) })
    expect(html).not.toContain('夜间迁移工作流')
    // 行被过滤后是空列表：停靠槽照常保留（空态自绘抽屉），但不再渲染任务行。
    expect(html).toContain('data-maestro-jobs-dock=""')
    expect(html).not.toContain('jobsRowMain')
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
    // 节点名就是任务名，没有 `cli · ` 前缀：来源 CLI 由 executor 徽标标识。
    expect(graph).toContain('CLI implementation')
    expect(graph).not.toContain('codex cli ·')
    expect(graph).toContain('data-cli-executor="codex"')
    expect(graph).toContain('data-graph-node="cli:task-a"')
    const html = renderToStaticMarkup(createElement(CliNodePopover, {
      node: row, now: 100, onOpenSession: () => {}, onCancel: async () => undefined,
    }))
    expect(html).toContain('dsh_maestro_upstream_tasks_graph_popCard')
    // 与原生子代理详情同一套字段：状态 / Token 用量 / 耗时；CLI、模型、
    // 开始、结束、退出码都不再出现。
    for (const text of ['节点详情', '状态', '运行中', '耗时', '取消任务', '查看会话', '较早输出已截断']) expect(html).toContain(text)
    expect(html).not.toContain('codex cli')
    expect(html).not.toContain('provider::model')
    expect(html).not.toContain('模型')
    expect(html).not.toContain('查看转录')
    // 跳转只有侧边一条路：没有「在主窗口中打开」的 caret 或菜单。
    expect(html).not.toContain('在主窗口中打开')
    expect(html).not.toContain('jumpMore')
  })

  it('names nodes after the task and renders the truncated input as the card description', () => {
    const task: MaestroTaskSummary = {
      id: 'task-b', cli: 'claude', title: '修复登录页', inputPreview: '修复登录页 在 iOS Safari 上点击登录按钮没有反应，需要排查…',
      phase: 'running', model: '', sessionId: 'root', startedAt: 10,
    }
    const input = boardRendererInput(attachRows(buildSessionTree({ rootId: 'root', sessions: list.byId }), { tasks: [task] }), 'root')
    const nodes = renderBoardNodes(input, { folded: false })
    const graph = renderToStaticMarkup(createElement(TasksGraph, rendererProps(nodes)))
    expect(graph).toContain('title="修复登录页"')
    // 描述行画在卡片名称下方（卡片尾部的 text 槽），不是节点标题。
    expect(graph).toContain('修复登录页 在 iOS Safari 上点击登录按钮没有反应')
    // 原生子代理：displayTitle（截断的对话首句）在目录 label 之外时也降为描述行。
    const native = renderBoardNodes(withBoardNative(boardRendererInput(buildSessionTree({
      rootId: 'root',
      sessions: { ...list.byId, named: { id: 'named', displayTitle: '帮我把 README 里的安装步骤整理成中英双语', parentId: 'root' } },
      catalogs: { root: [{ id: 'named', createdAt: 3, mode: 'one-shot', label: '整理 README 安装步骤' }] },
    }), 'root'), { byId: {}, projectionsBySession: {} }, {}, []), { folded: false })
    const named = agent(native, 'named')
    expect(named.label).toBe('整理 README 安装步骤')
    const nativeHtml = renderToStaticMarkup(createElement(TasksGraph, rendererProps(native)))
    expect(nativeHtml).toContain('整理 README 安装步骤')
    expect(named.live?.text).toBe('帮我把 README 里的安装步骤整理成中英双语')
  })

  it('never badges a CLI turn with its reply-chain length', () => {
    const task: MaestroTaskSummary = {
      id: 'task-a', cli: 'codex', title: 'CLI implementation', phase: 'running', model: 'provider::model',
      sessionId: 'root', startedAt: 10,
    }
    const tree = attachRows(buildSessionTree({ rootId: 'root', sessions: list.byId }), { tasks: [task] })
    const input = boardRendererInput(tree, 'root')
    // 返工链再长也不在卡片上加注记（phase 徽标槽留给别的语义）。
    const nodes = renderBoardNodes(input, { folded: false })
    const cliNode = nodes.find(node => node.kind === 'agent' && node.id === 'cli:task-a')
    expect(cliNode?.phase).toBeUndefined()
    const graph = renderToStaticMarkup(createElement(TasksGraph, rendererProps(nodes)))
    expect(graph).not.toContain('已续接')
  })

  it('re-folds an expanded group through its members (the re-collapse entry)', () => {
    const settled: BoardSessionList = { byId: {
      root: { id: 'root', displayTitle: '主任务', running: true },
      a: { id: 'a', displayTitle: '甲', parentId: 'root' },
      b: { id: 'b', displayTitle: '乙', parentId: 'root' },
    } }
    const base = boardRendererInput(buildSessionTree({ rootId: 'root', sessions: settled.byId }), 'root')
    const group = foldGroupId('done', 'root')
    const expanded = renderBoardNodes(base, { folded: true, expandedGroups: new Set([group]) })
    // 展开态：成员卡片可见、聚合行消失；成员箭头是唯一的收起入口。
    expect(expanded.find(node => node.kind === 'fold')).toBeUndefined()
    const memberA = agent(expanded, 'a')
    expect(groupMemberIds(expanded, memberA)).toEqual(['a', 'b'])
    // 整组收起 = 删展开记录 + 成员重新手动折叠（Board.foldNode 的状态转移）。
    const refolded = renderBoardNodes(base, {
      folded: true, expandedGroups: new Set<string>(), foldedIds: new Set(groupMemberIds(expanded, memberA)),
    })
    const aggregate = refolded.find((node): node is TasksFoldNode => node.kind === 'fold')
    expect(aggregate?.memberIds).toEqual(['a', 'b'])
  })

  it('opens child transcripts in the right sidebar only, never the main window', () => {
    const calls: unknown[] = []
    const services: Record<string, unknown> = {
      uiWorkspace: { openSession: (target: unknown) => calls.push(['main', target]) },
      sessions: { open: (target: unknown) => calls.push(['sessions', target]) },
      sidebarRightTabs: { get: () => ({}) },
      sidebarRight: { openResource: (target: unknown, options: unknown) => calls.push(['side', target, options]) },
    }
    const ctx: BoardHost = { get: name => services[name] }
    const node = agent(renderBoardNodes(source(), { folded: false }), 'review')
    expect(hasBoardTranscriptAside(ctx)).toBe(true)
    expect(jumpBoardNode(ctx, node)).toBe(true)
    expect(calls[0]).toEqual([
      'side', 'dsh-resource://subagentchat/session/review?parent=root&mode=continuable',
      { kind: 'subagentchat', preferNewPane: true },
    ])
    // 工作流成员行走同一条侧边通道。
    expect(jumpBoardAddress(ctx, { parentSessionId: 'root', childSessionId: 'review', mode: 'one-shot' })).toBe(true)
    expect(calls[1]).toEqual([
      'side', 'dsh-resource://subagentchat/session/review?parent=root&mode=one-shot',
      { kind: 'subagentchat', preferNewPane: true },
    ])
    // 没有侧栏座位就无处可开：不回落主窗口（宿主导航一个都不碰）。
    const bare: BoardHost = { get: name => (name === 'uiWorkspace' ? services.uiWorkspace : undefined) }
    expect(jumpBoardNode(bare, node)).toBe(false)
    // 根节点没有子会话地址，同样无处可开。
    expect(jumpBoardNode(ctx, agent(renderBoardNodes(source(), { folded: false }), 'root'))).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it('opens the CLI session in the right sidebar through the plugin tab type, and no wider', () => {
    const calls: unknown[] = []
    const services: Record<string, unknown> = {
      sidebarRightTabs: { get: (kind: string) => (kind === 'maestro-cli-chat' ? {} : undefined) },
      sidebarRight: { openResource: (target: unknown, options: unknown) => calls.push([target, options]) },
    }
    const ctx: BoardHost = { get: name => services[name] }
    const task: MaestroTaskSummary = {
      id: 'task-a', cli: 'claude', title: 'CLI implementation', phase: 'done', model: '', sessionId: 'root', startedAt: 10,
    }
    expect(hasBoardCliSessionAside(ctx)).toBe(true)
    expect(jumpBoardCliSession(ctx, task, ['root'])).toBe(true)
    // 地址带打开时事实（cli/标题给 chip/scope 给还原），kind 指向我们自己的类型。
    expect(calls[0]).toEqual([
      'dsh-resource://maestro-cli-chat/task/task-a?cli=claude&title=CLI+implementation&scope=root',
      { kind: 'maestro-cli-chat', preferNewPane: true },
    ])
    // 类型没注册上（宿主没有 sidebarRightTabs 面）就无处可开，调用方回落覆盖层。
    const bare: BoardHost = { get: () => undefined }
    expect(jumpBoardCliSession(bare, task)).toBe(false)
    expect(jumpBoardCliSession({ get: name => (name === 'sidebarRight' ? services.sidebarRight : undefined) }, task)).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

describe('transcript flow blocks', () => {
  it('merges consecutive thinking events and keeps tools as their own rows', () => {
    const blocks = flowBlocksOf([
      { seq: 1, at: 0, kind: 'thinking', text: '先看入口' },
      { seq: 2, at: 1, kind: 'thinking', text: '再查配置' },
      { seq: 3, at: 2, kind: 'text', text: '开始改' },
      { seq: 4, at: 3, kind: 'tool', text: 'Bash', detail: 'ls -la\n输出…' },
      { seq: 5, at: 4, kind: 'note', text: 'stderr: x' },
    ])
    expect(blocks).toHaveLength(4)
    expect(blocks[0]).toEqual({ kind: 'thinking', body: '先看入口\n\n再查配置', seq: 1 })
    expect(blocks[1]).toEqual({ kind: 'text', body: '开始改', seq: 3 })
    expect(blocks[2]).toMatchObject({ kind: 'tool', event: { text: 'Bash' } })
    expect(blocks[3]).toMatchObject({ kind: 'plain', event: { seq: 5 } })
    // 被 text 隔开的 thinking 不再合并。
    const separated = flowBlocksOf([
      { seq: 1, at: 0, kind: 'thinking', text: 'a' },
      { seq: 2, at: 1, kind: 'text', text: 'b' },
      { seq: 3, at: 2, kind: 'thinking', text: 'c' },
    ])
    expect(separated.filter(block => block.kind === 'thinking')).toHaveLength(2)
  })
})
