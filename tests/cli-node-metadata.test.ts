import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TaskRegistry } from '../src/task-registry.js'
import { tokenUsageOfStats, type MaestroTaskSummary } from '../src/wire.js'
import { attachRows, buildSessionTree, cliNode } from '../src/client/board/model.js'
import { boardRendererInput, renderBoardNodes } from '../src/client/board/bridge.js'
import { CliNodePopover } from '../src/client/board/cli-detail.js'
import { headerTokenText } from '../src/client/header/CliCatalogChip.js'
import { TasksGraph, TasksTree, type TasksAgentNode } from '../src/client/board/upstream/index.js'

const callbacks = { rootId: 'root', folded: false, onNodeInfo() {}, onWorkflowInfo() {},
  onOpenTask() {}, onToggleFold() {}, onExpandGroup() {}, onFoldNode() {}, onModeChange() {} }
const sessions = { root: { id: 'root', displayTitle: 'Main', running: true } }
const task = (cli: MaestroTaskSummary['cli']): MaestroTaskSummary => ({
  id: 'task-a', cli, title: 'Implementation', phase: 'running', model: 'provider::model', sessionId: 'root', startedAt: 10,
})
const markup = (nodes: TasksAgentNode[]) => [
  renderToStaticMarkup(createElement(TasksGraph, { ...callbacks, nodes, mode: 'graph' })),
  renderToStaticMarkup(createElement(TasksTree, { ...callbacks, nodes, mode: 'tree', collapsedIds: new Set<string>(),
    onToggleCollapse() {}, onCollapseAll() {}, onExpandAll() {} })),
]

describe('CLI executor identity and measured usage', () => {
  it.each(['codex', 'claude'] as const)('labels %s in the right-aligned identity row of both renderers', cli => {
    const input = boardRendererInput(attachRows(buildSessionTree({ rootId: 'root', sessions }), { tasks: [task(cli)] }), 'root')
    const nodes = renderBoardNodes(input, { folded: false }).filter((node): node is TasksAgentNode => node.kind === 'agent')
    expect(nodes.find(node => node.id === 'cli:task-a')?.executor).toBe(cli)
    expect(nodes.find(node => node.id === 'root')?.executor).toBeUndefined()
    for (const html of markup(nodes)) {
      expect(html).toContain(`data-cli-executor="${cli}"`)
      expect(html).toContain('margin-left:auto;flex-shrink:0')
      expect(html.match(/data-cli-executor=/g)).toHaveLength(1)
    }
  })

  it('supports other executor names without inferring a CLI from a native title', () => {
    const native: TasksAgentNode = { kind: 'agent', id: 'root', label: 'codex analysis', depth: 0,
      state: 'running', activity: 'running', current: true }
    for (const html of markup([native])) expect(html).not.toContain('data-cli-executor')
    for (const html of markup([{ ...native, executor: 'other-cli' }])) expect(html).toContain('data-cli-executor="other-cli"')
  })

  it('uses measured summary usage even without the recent-20 projection and overrides stale projection zero', () => {
    const usage = { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 }
    const row = cliNode({ ...task('codex'), phase: 'timeout', usage }, {
      uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    })
    expect(row.tokens).toEqual(usage)
    expect(Object.values(row.tokens ?? {}).reduce((sum, value) => sum + value, 0)).toBe(100)
  })

  it('keeps missing token telemetry unknown rather than manufacturing a zero', () => {
    expect(tokenUsageOfStats(undefined)).toBeUndefined()
    expect(tokenUsageOfStats({ threadId: 'known', timedOut: true, items: 38 })).toBeUndefined()
    expect(tokenUsageOfStats({ inputTokens: Number.NaN, outputTokens: -1 })).toBeUndefined()
    expect(tokenUsageOfStats({ inputTokens: 0, outputTokens: 0 })).toEqual({
      uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    })
  })

  it.each(['timeout', 'failed', 'cancelled'] as const)('carries known %s usage in the public task summary without exposing raw stats', phase => {
    const registry = new TaskRegistry()
    const row = registry.create({ id: 'measured', cli: 'codex', title: 'Measured', model: '' })
    row.stats = { inputTokens: 100, outputTokens: 200, cachedInputTokens: 300, cacheWriteTokens: 400, threadId: 'private-metadata' }
    registry.setPhase(row, phase)
    const summary = registry.summaryOf(row)
    expect(summary.usage).toEqual({ uncachedInputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400 })
    expect(summary).not.toHaveProperty('stats')
    expect(JSON.stringify(summary)).not.toContain('private-metadata')
  })

  it('distinguishes measured zero from absent telemetry in the top subagent list', () => {
    const zero = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    expect(headerTokenText(undefined, { cli: true })).toBe('用量未采集')
    expect(headerTokenText(undefined, { cli: true, running: true })).toBe('尚未收到用量')
    expect(headerTokenText(zero, { cli: true })).toBe('用量未采集')
    expect(headerTokenText(zero, { cli: true, usageMeasured: true })).toBe('0 tok')
    expect(headerTokenText({ ...zero, outputTokens: 100 }, { cli: true })).toBe('100 tok')
    expect(headerTokenText(undefined)).toBe('')
  })

  it('tells the user missing settled telemetry does not mean zero spend', () => {
    const row = cliNode({ ...task('codex'), phase: 'timeout', endedAt: 100 })
    const html = renderToStaticMarkup(createElement(CliNodePopover, { node: row, now: 100, onOutput() {}, onCancel: async () => undefined }))
    expect(html).toContain('未采集（不代表零消耗）')
    expect(html).not.toContain('任务结束后上报')
  })
})
