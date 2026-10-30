/**
 * 规模与性能回归：把会在真实使用里变大的路径放到千级规模下压一遍。
 *
 * 时间预算都放得很宽（本机毫秒级的操作给到数百毫秒），只用来抓「复杂度回
 * 退」——比如 buildSessionTree 曾对每个节点全量扫会话表（O(n²)），会话上百
 * 后看板每 2.5s 的重建就会卡顿；这类回退在这里会直接超预算。
 */

import { describe, expect, it } from 'vitest'
import { TaskRegistry } from '../src/task-registry.js'
import { cleanLogText } from '../src/wire.js'
import { renderSummary } from '../src/tool.js'
import { keywordScore, routingHint } from '../src/routing.js'
import { effectiveOf } from '../src/config.js'
import {
  attachRows, buildSessionTree, expandFolds, filterTree, flattenTree, foldFinished, collectTreeIds,
  type BoardCatalogEntry, type BoardSession,
} from '../src/client/board/model.js'
import type { MaestroTaskSummary } from '../src/wire.js'

function elapsed(ms: number, budget: number, label: string): void {
  // 预算用 `lessThan` 让失败信息带上实际耗时，方便定位回退幅度。
  expect(ms, `${label} 超出预算：${String(ms)}ms > ${String(budget)}ms`).toBeLessThan(budget)
}

describe('TaskRegistry at scale', () => {
  it('holds 60 tasks x 800 events; list/eventsSince stay flat and the ring truncates', () => {
    const registry = new TaskRegistry()
    for (let taskIndex = 0; taskIndex < 60; taskIndex += 1) {
      const task = registry.create({ id: `task-${String(taskIndex)}`, cli: taskIndex % 2 === 0 ? 'claude' : 'codex', title: `任务 ${String(taskIndex)}`, model: '' })
      registry.setPhase(task, 'running', '开始')
      for (let eventIndex = 0; eventIndex < 900; eventIndex += 1) registry.push(task, 'note', `事件 ${String(eventIndex)}`)
      registry.setPhase(task, 'done', '完成')
    }
    // 60 上限：最早的任务被剪掉，运行完成的都进来过。
    expect(registry.list()).toHaveLength(60)
    // 事件环封顶 800 + truncated 标记。
    const page = registry.eventsSince('task-59', 0)
    expect(page?.events).toHaveLength(800)
    expect(page?.task.truncated).toBe(true)
    // 游标轮询：从中间续读只给增量。
    const tail = registry.eventsSince('task-59', 850)
    expect(tail?.events.every(entry => entry.seq > 850)).toBe(true)

    const start = Date.now()
    for (let poll = 0; poll < 200; poll += 1) {
      registry.list()
      registry.eventsSince('task-59', 790)
    }
    elapsed(Date.now() - start, 1500, 'registry list/eventsSince x200')
  })
})

describe('board model at scale', () => {
  /** depth 4、每层 6 个孩子 ≈ 1555 个会话节点 + 每节点一份目录行。 */
  function bigTree(): {
    sessions: Record<string, BoardSession>
    catalogs: Record<string, BoardCatalogEntry[]>
    nodeCount: number
    leaves: string[]
  } {
    const sessions: Record<string, BoardSession> = { root: { id: 'root', displayTitle: '根会话', running: true } }
    const catalogs: Record<string, BoardCatalogEntry[]> = { root: [] }
    let nodeCount = 1
    let layer = ['root']
    for (let depth = 1; depth <= 4; depth += 1) {
      const next: string[] = []
      for (const parent of layer) {
        for (let childIndex = 0; childIndex < 6; childIndex += 1) {
          const id = `s${String(depth)}-${parent}-${String(childIndex)}`
          sessions[id] = { id, displayTitle: `子代理 ${id}`, parentId: parent, running: depth === 4 ? false : childIndex === 0 }
          catalogs[parent] = catalogs[parent] ?? []
          catalogs[parent].push({ id, createdAt: nodeCount, mode: depth === 4 ? 'one-shot' : 'continuable', label: `目录 ${id}` })
          next.push(id)
          nodeCount += 1
        }
      }
      layer = next
    }
    return { sessions, catalogs, nodeCount, leaves: layer }
  }

  function cliTask(index: number, sessionId: string): MaestroTaskSummary {
    return { id: `cli-${String(index)}`, cli: index % 2 === 0 ? 'claude' : 'codex', title: `CLI 任务 ${String(index)}`, phase: index % 3 === 0 ? 'running' : 'done', model: '', sessionId, startedAt: 1 }
  }

  it('builds, folds, filters and flattens a ~1.5k-node tree with 200 attached CLI tasks inside the budget', () => {
    const { sessions, catalogs, nodeCount, leaves } = bigTree()
    // 挂到真实存在的叶子会话上；树外归属的任务会被 attachRows 丢弃（隔离语义）。
    const tasks = Array.from({ length: 200 }, (_, index) => cliTask(index, leaves[index % leaves.length] ?? 'root'))

    const start = Date.now()
    const tree = buildSessionTree({ rootId: 'root', sessions, catalogs })
    const attached = attachRows(tree, { tasks })
    const folded = foldFinished(attached)
    const expanded = expandFolds(folded, new Set<string>())
    const rows = flattenTree(expanded)
    const visible = filterTree(expanded, 'running')
    const ids = collectTreeIds(expanded)
    const elapsedMs = Date.now() - start

    expect(nodeCount).toBe(1555)
    // 折叠前：全部会话 + 200 个 CLI 节点都在明面上。
    const allRows = flattenTree(attached)
    expect(allRows).toHaveLength(nodeCount + 200)
    // 折叠把最深的已结束兄弟收成组：行数大幅变少（这正是折叠的功能）。
    expect(rows.length).toBeLessThan(allRows.length)
    expect(ids.every(id => !id.startsWith('cli:'))).toBe(true)
    expect(visible).toBeDefined()
    elapsed(elapsedMs, 2000, 'tree pipeline (build+attach+fold+expand+flatten+filter)')
  })

  it('repeated rebuilds (per board poll) stay inside the budget', () => {
    const { sessions, catalogs } = bigTree()
    const start = Date.now()
    for (let round = 0; round < 20; round += 1) {
      const tree = buildSessionTree({ rootId: 'root', sessions, catalogs })
      flattenTree(foldFinished(tree))
    }
    // 20 轮 ≈ 看板连续运行 50 秒的重建开销；索引化之前这里是 O(n²)。
    elapsed(Date.now() - start, 2000, '20x tree rebuild')
  })
})

describe('hot string paths at scale', () => {
  it('renderSummary caps a 60k answer and stays flat', () => {
    const start = Date.now()
    for (let round = 0; round < 50; round += 1) {
      const text = renderSummary({
        ok: true, cli: 'codex', model: 'm', cwd: 'C:\\x', durationMs: 1_000,
        exitCode: 0, sessionRef: 's', finalText: 'x'.repeat(60_000), notes: [],
      })
      expect(text.length).toBeLessThan(21_500)
    }
    elapsed(Date.now() - start, 1500, 'renderSummary x50 @60k')
  })

  it('cleanLogText strips ANSI from a 1MB log inside the budget', () => {
    const raw = `\u001b[32m${'进度'.repeat(200_000)}\u001b[0m\u001b]0;title\u0007`
    const start = Date.now()
    const cleaned = cleanLogText(raw)
    elapsed(Date.now() - start, 2000, 'cleanLogText @1MB')
    expect(cleaned).not.toContain('\u001b')
    expect(cleaned.length).toBe(raw.length - '\u001b[32m'.length - '\u001b[0m'.length - '\u001b]0;title\u0007'.length)
  })

  it('keywordScore and routingHint stay flat on a 100k task text', () => {
    const config = effectiveOf({})
    const task = '代码生成 数据处理 '.repeat(20_000)
    const start = Date.now()
    for (let round = 0; round < 20; round += 1) {
      keywordScore(config, 'codex', task)
      routingHint(config, 'dispatch_cli_task')
    }
    elapsed(Date.now() - start, 2000, 'keywordScore/routingHint x20 @100k')
  })
})
