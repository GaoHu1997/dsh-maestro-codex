// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import type { MaestroTaskSummary } from '../src/wire.js'
import { attachRows, buildSessionTree, type BoardSession } from '../src/client/board/model.js'
import { boardRendererInput, renderBoardNodes } from '../src/client/board/bridge.js'
import { CliNodePopover } from '../src/client/board/cli-detail.js'
import { applyBoardCopy, interruptedStateLabel } from '../src/client/board/copy.js'
import { TasksGraph, TasksTree, type TasksAgentNode, type TasksNode } from '../src/client/board/upstream/index.js'
import { CardBar } from '../src/client/board/upstream/client/tasks-card.js'
import { attachLocale } from '../src/client/board/upstream/client/locales.js'

const clis = ['claude', 'codex', 'grok'] as const
function task(cli: typeof clis[number], id = 'interrupted', phase: MaestroTaskSummary['phase'] = 'interrupted', sessionId = 'root'): MaestroTaskSummary {
  return { id, cli, title: 'CLI acceptance task', phase, model: '', sessionId, startedAt: 10 }
}
function source(cli: typeof clis[number], nested = false) {
  const sessions: Record<string, BoardSession> = {
    root: { id: 'root', displayTitle: 'Native root', running: true },
    native: { id: 'native', displayTitle: 'Native completed child', parentId: 'root', running: false },
    ...(nested ? { branch: { id: 'branch', displayTitle: 'Native branch', parentId: 'root', running: false } } : {}),
  }
  return boardRendererInput(attachRows(buildSessionTree({ rootId: 'root', sessions }), {
    tasks: [task(cli, 'interrupted', 'interrupted', nested ? 'branch' : 'root'), task(cli, 'completed', 'done')],
  }), 'root')
}
function agent(nodes: readonly TasksNode[], id: string): TasksAgentNode {
  const node = nodes.find(row => row.id === id)
  if (node?.kind !== 'agent') throw new Error(`Missing visible agent ${id}`)
  return node
}
function renderers(nodes: TasksNode[], folded = false) {
  const common = {
    nodes, folded, rootId: 'root', onNodeInfo: () => {}, onWorkflowInfo: () => {}, onOpenTask: () => {},
    onToggleFold: () => {}, onExpandGroup: () => {}, onFoldNode: () => {}, onModeChange: () => {},
  }
  const graph = document.createElement('div')
  graph.innerHTML = renderToStaticMarkup(createElement(TasksGraph, { ...common, mode: 'graph' }))
  const tree = document.createElement('div')
  tree.innerHTML = renderToStaticMarkup(createElement(TasksTree, {
    ...common, mode: 'tree', collapsedIds: new Set<string>(), onToggleCollapse: () => {},
    onCollapseAll: () => {}, onExpandAll: () => {},
  }))
  return { graph, tree }
}

beforeEach(() => {
  applyBoardCopy()
  attachLocale({ getSnapshot: () => ({ active: 'zh-CN' }) })
})

describe('frozen interrupted-state acceptance', () => {
  it.each(clis.flatMap(cli => [false, true].map(folded => ({ cli, folded }))))(
    'keeps $cli interrupted visible with folded=$folded without forging running', ({ cli, folded }) => {
      const input = source(cli)
      const nodes = renderBoardNodes(input, { folded, autoFoldSettled: true, autoFoldBranches: true, autoFoldIdle: true })
      const node = agent(nodes, 'cli:interrupted')
      expect(node.state).toBe('idle')
      expect(node.activity).toBe('inactive')
      expect(node.stateText).toBe('已中断')
      expect(node.executor).toBe(cli)
      expect(input.input.byId[node.id]?.running).toBe(false)
      expect(input.input.live?.[node.id]?.running).toBe(false)
      expect(nodes.some(row => row.kind === 'fold' && row.foldKind === 'done' && row.memberIds.includes(node.id))).toBe(false)
      if (folded) expect(nodes.some(row => row.kind === 'fold' && row.memberIds.includes('native'))).toBe(true)
      const { graph, tree } = renderers(nodes, folded)
      const card = graph.querySelector('[data-graph-node="cli:interrupted"]')
      const treeRow = tree.querySelector('[data-tree-node="cli:interrupted"]')
      expect(card?.textContent).toContain('已中断')
      expect(card?.querySelector('[data-card-bar]')?.getAttribute('data-card-bar')).toBe('idle')
      expect(card?.querySelector('[data-running="true"]')).toBeNull()
      expect(card?.getAttribute('aria-label')).toContain('已中断')
      expect(card?.getAttribute('aria-label')).not.toContain('待命')
      expect(treeRow?.getAttribute('aria-label')).toContain('已中断')
      expect(treeRow?.textContent).toContain('已中断')
    },
  )

  it.each(clis.flatMap(cli => ['zh-CN', 'en-US'].map(locale => ({ cli, locale }))))(
    'keeps $cli graph, tree, accessible name and detail consistent in $locale', ({ cli, locale }) => {
      attachLocale({ getSnapshot: () => ({ active: locale }) })
      const input = source(cli)
      const nodes = renderBoardNodes(input, { folded: false })
      const expected = locale === 'zh-CN' ? '已中断' : 'Interrupted'
      expect(interruptedStateLabel()).toBe(expected)
      const { graph, tree } = renderers(nodes)
      const card = graph.querySelector('[data-graph-node="cli:interrupted"]')
      const treeRow = tree.querySelector('[data-tree-node="cli:interrupted"]')
      expect(card?.textContent).toContain(expected)
      expect(card?.getAttribute('aria-label')).toContain(expected)
      expect(treeRow?.textContent).toContain(expected)
      expect(treeRow?.getAttribute('aria-label')).toContain(expected)
      const row = input.byNodeId.get('cli:interrupted')
      if (row === undefined) throw new Error('Missing CLI domain row')
      const detail = renderToStaticMarkup(createElement(CliNodePopover, {
        node: row, now: 100, onCancel: async () => undefined, onOpenSession: () => {},
      }))
      expect(detail).toContain(expected)
    },
  )

  it.each(['running', 'idle', 'done', 'error'] as const)('leaves native %s card output identical without the opt-in field', state => {
    const base = { state, running: state === 'running', activity: 'Native activity' }
    expect(renderToStaticMarkup(createElement(CardBar, { ...base, stateText: undefined })))
      .toBe(renderToStaticMarkup(createElement(CardBar, base)))
  })

  it('does not automatically hide a completed native branch containing an interrupted child', () => {
    const nodes = renderBoardNodes(source('codex', true), { folded: true, autoFoldBranches: true })
    expect(agent(nodes, 'branch').stateText).toBeUndefined()
    expect(agent(nodes, 'cli:interrupted').state).toBe('idle')
    expect(nodes.some(row => row.kind === 'fold' && row.memberIds.includes('native'))).toBe(true)
  })

  it('keeps explicit manual folding in the idle group, never the completed group', () => {
    const nodes = renderBoardNodes(source('grok'), { folded: false, foldedIds: new Set(['cli:interrupted']) })
    const group = nodes.find(row => row.kind === 'fold' && row.memberIds.includes('cli:interrupted'))
    expect(group?.kind === 'fold' ? group.foldKind : undefined).toBe('idle')
  })

  it('does not attach interrupted wording to native or completed CLI nodes', () => {
    const nodes = renderBoardNodes(source('claude'), { folded: false })
    expect(agent(nodes, 'native')).toMatchObject({ state: 'done', executor: 'DSH' })
    expect(agent(nodes, 'native').stateText).toBeUndefined()
    expect(agent(nodes, 'cli:completed')).toMatchObject({ state: 'done', executor: 'claude' })
    expect(agent(nodes, 'cli:completed').stateText).toBeUndefined()
  })
})
