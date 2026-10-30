import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentNodePopover, attachLocale, JobsDrawer, TasksGraph, TasksTree, WorkflowNodePopover,
  type TasksAgentNode, type TasksNode, type TasksWorkflowNode,
} from '../src/client/board/upstream/index.js'
import css from '../src/client/board/upstream/client/tasks-graph.module.css'
import canvasCss from '../src/client/board/upstream/client/tasks-canvas.module.css'

const root: TasksAgentNode = { kind: 'agent', id: 'root', label: '主任务', state: 'running', activity: 'running', current: true, depth: 0 }
const cli: TasksAgentNode = { kind: 'agent', id: 'cli:codex', parentId: 'root', label: 'CLI · codex', mode: 'external', state: 'running', activity: 'running', current: false, depth: 1, live: { text: '正在审查代码' } }
const callbacks = { onNodeInfo() {}, onWorkflowInfo() {}, onOpenTask() {}, onToggleFold() {}, onExpandGroup() {}, onModeChange() {} }
const graph = (nodes: TasksNode[] = [root, cli]) => renderToStaticMarkup(createElement(TasksGraph, { ...callbacks, nodes, rootId: 'root', folded: true, mode: 'graph', onFoldNode() {} }))
const tree = (collapsedIds = new Set<string>()) => renderToStaticMarkup(createElement(TasksTree, { ...callbacks, nodes: [root, cli], folded: true, mode: 'tree', collapsedIds, onToggleCollapse() {}, onCollapseAll() {}, onExpandAll() {} }))

beforeEach(() => { attachLocale({ getSnapshot: () => ({ active: 'zh' }) }) })
afterEach(() => { attachLocale(undefined) })

describe('original renderer entry points', () => {
  it('renders the original graph geometry, card segments and host buttons', () => {
    const html = graph()
    expect(html).toContain(css.graphView)
    expect(html).toContain(css.cardTop)
    expect(html).toContain(css.cardBar)
    expect(html).toContain('CLI · codex')
    expect(html).toContain('width:190px')
    expect(html).toContain('animation-delay:26ms')
    expect(html).toContain('data-graph-controls')
    expect(html).toContain('data-host-size="sm"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('d="M ')
  })

  it('renders the original accessible tree and its independent collapse axis', () => {
    const expanded = tree()
    expect(expanded).toContain('role="tree"')
    expect(expanded).toContain('aria-level="2"')
    expect(expanded).toContain('data-tree-node="cli:codex"')
    expect(expanded).toContain('aria-current="true"')
    expect(expanded).toContain(css.treeRow)
    const collapsed = tree(new Set(['root']))
    expect(collapsed).toContain('aria-expanded="false"')
    expect(collapsed).not.toContain('data-tree-node="cli:codex"')
  })

  it('keeps folded aggregates and the empty-canvas loading hint', () => {
    expect(graph([root, { kind: 'fold', id: 'fold:root', parentId: 'root', depth: 1, foldKind: 'done', count: 2, doneCount: 1, idleCount: 0, errorCount: 1, memberIds: ['a', 'b'], previews: ['审查', '测试'] }])).toContain(css.nodeFold)
    const html = renderToStaticMarkup(createElement(TasksGraph, { ...callbacks, nodes: [], rootId: undefined, folded: true, mode: 'graph', loading: true, onFoldNode() {} }))
    expect(html).toContain(canvasCss.loading)
    expect(html).toContain('data-host-icon="loading"')
  })

  it('preserves the node and workflow detail skeletons', () => {
    const node = { ...root, metrics: { usage: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 0 } } }
    const agent = renderToStaticMarkup(createElement(AgentNodePopover, { node, asideAvailable: false, onJump() {}, onOpenTask() {}, onClose() {} }))
    expect(agent).toContain(css.popCard)
    expect(agent).toContain('1.7K')
    const workflow: TasksWorkflowNode = { kind: 'workflow', id: 'run:1', parentId: 'root', depth: 1, run: { runId: '1', name: '审查流水线', originSessionId: 'root', status: 'running', startedSeq: 1, startedAt: 1, phases: [{ title: '审查', members: [{ seq: 2, childId: 'child', label: '代码审查' }] }] } }
    const html = renderToStaticMarkup(createElement(WorkflowNodePopover, { node: workflow, onJumpMember() {} }))
    expect(html).toContain(css.popCard)
    expect(html).toContain('审查流水线')
    expect(html).toContain('代码审查')
  })

  it('renders background jobs through the original drawer and host status primitives', () => {
    const html = renderToStaticMarkup(createElement(JobsDrawer, { rows: [{ ownerSessionId: 'root', ownerTitle: '主任务', job: { id: 'bash-1', kind: 'bash', label: 'npm test', status: 'failed', startedAt: 1000, finishedAt: 2000 } }], jobs: undefined, observed: undefined, agentCount: 2, onOpenOutput() {} }))
    expect(html).toContain('npm test')
    expect(html).toContain('data-host-state-dot="error"')
    expect(html).toContain('data-host-tag="danger"')
  })
})
