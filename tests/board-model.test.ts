import { describe, expect, it } from 'vitest'

import {
  attachRows,
  buildSessionTree,
  CLI_NODE_PREFIX,
  cliStatusOf,
  collectTreeIds,
  countActive,
  expandFolds,
  filterTree,
  flattenTree,
  FOLD_NODE_PREFIX,
  foldFinished,
  formatDuration,
  formatTokens,
  JOB_NODE_PREFIX,
  jobLive,
  jobNode,
  jobStatusOf,
  matchesFilter,
  taskCancellable,
  taskDuration,
  timingSummary,
  tokenSummary,
  type BoardCatalogEntry,
  type BoardJob,
  type BoardJobRow,
  type BoardNode,
  type BoardSession,
  type TreeInput,
} from '../src/client/board/model.js'
import type { MaestroTaskSummary } from '../src/wire.js'

const sessions: Record<string, BoardSession> = {
  root: { id: 'root', displayTitle: '主任务', cwd: '/work', running: true },
  review: { id: 'review', displayTitle: '代码审查', parentId: 'root', running: false },
  docs: { id: 'docs', displayTitle: '文档', parentId: 'root', running: true },
  deep: { id: 'deep', displayTitle: '深层子代理', parentId: 'review', running: false },
}

const catalogs: Record<string, BoardCatalogEntry[]> = {
  root: [
    { id: 'review', createdAt: 10, mode: 'continuable' },
    { id: 'docs', createdAt: 20, mode: 'one-shot' },
    { id: 'cli-1', createdAt: 30, mode: 'external', label: 'codex cli' },
  ],
  review: [{ id: 'deep', createdAt: 40, mode: 'one-shot' }],
}

function tree(overrides: Partial<TreeInput> = {}) {
  return buildSessionTree({ rootId: 'root', sessions, catalogs, ...overrides })
}

describe('buildSessionTree', () => {
  it('keeps catalog order and appends blood-line children after it', () => {
    const root = tree()
    expect(root.children.map(child => child.id)).toEqual(['review', 'docs', 'cli-1'])
    // `deep` 只在 `review` 的目录里，是 review 的子级而不是 root 的。
    expect(root.children[0]?.children.map(child => child.id)).toEqual(['deep'])
  })

  it('marks external children as session-less leaf nodes', () => {
    const cli = tree().children[2]
    expect(cli).toMatchObject({
      id: 'cli-1',
      title: 'codex cli',
      hasSession: false,
      depth: 1,
      running: false,
      status: 'done',
      mode: 'external',
      children: [],
    })
  })

  it('gives the root idle status when it exists but is not running', () => {
    const idle = buildSessionTree({
      rootId: 'root',
      sessions: { root: { id: 'root', displayTitle: '主任务' } },
    })
    expect(idle.status).toBe('idle')
    expect(idle.children).toEqual([])
  })

  it('still returns a renderable root before the session feed catches up', () => {
    const pending = buildSessionTree({ rootId: 'missing', sessions })
    expect(pending).toMatchObject({
      id: 'missing',
      title: '当前会话',
      hasSession: false,
      status: 'idle',
      children: [],
    })
  })

  it('attaches tokens and timing only where the projection has them', () => {
    const root = tree({
      tokens: { review: { uncachedInputTokens: 1200, outputTokens: 340, cacheReadTokens: 9000, cacheWriteTokens: 0 } },
      timings: { review: { settledMs: 7200 } },
    })
    expect(root.children[0]?.tokens?.outputTokens).toBe(340)
    expect(root.children[0]?.timing?.settledMs).toBe(7200)
    expect(root.tokens).toBeUndefined()
  })

  it('breaks parent cycles instead of recursing forever', () => {
    const cyclic: Record<string, BoardSession> = {
      root: { id: 'root', displayTitle: '主任务' },
      a: { id: 'a', displayTitle: 'a', parentId: 'b' },
      b: { id: 'b', displayTitle: 'b', parentId: 'a' },
    }
    const built = buildSessionTree({
      rootId: 'root',
      sessions: cyclic,
      catalogs: { root: [{ id: 'a', createdAt: 1, mode: 'unknown' }], b: [{ id: 'a', createdAt: 1, mode: 'unknown' }] },
    })
    const ids = flattenTree(built).map(node => node.id)
    expect(ids.filter(id => id === 'a')).toHaveLength(1)
  })
})

describe('flattenTree / collectTreeIds', () => {
  it('flattens in pre-order with depth preserved', () => {
    const rows = flattenTree(tree())
    expect(rows.map(row => `${row.id}@${String(row.depth)}`)).toEqual([
      'root@0',
      'review@1',
      'deep@2',
      'docs@1',
      'cli-1@1',
    ])
  })

  it('collects every id including the root', () => {
    expect(collectTreeIds(tree())).toEqual(['root', 'review', 'deep', 'docs', 'cli-1'])
  })
})

describe('status mapping', () => {
  it('maps CLI phases onto board statuses', () => {
    expect(cliStatusOf('queued')).toBe('queued')
    expect(cliStatusOf('running')).toBe('running')
    expect(cliStatusOf('done')).toBe('done')
    expect(cliStatusOf('failed')).toBe('failed')
    expect(cliStatusOf('timeout')).toBe('failed')
    expect(cliStatusOf('cancelled')).toBe('cancelled')
  })

  it('maps job statuses onto board statuses', () => {
    expect(jobStatusOf('stopping')).toBe('running')
    expect(jobStatusOf('completed')).toBe('done')
    expect(jobStatusOf('killed')).toBe('cancelled')
    expect(jobStatusOf('failed')).toBe('failed')
  })

  it('treats queued as running and idle as finished', () => {
    expect(matchesFilter('queued', 'running')).toBe(true)
    expect(matchesFilter('idle', 'done')).toBe(true)
    expect(matchesFilter('cancelled', 'done')).toBe(true)
    expect(matchesFilter('done', 'failed')).toBe(false)
    expect(matchesFilter('failed', 'all')).toBe(true)
  })

  it('counts running and queued rows as active', () => {
    expect(countActive(['running', 'queued', 'done', 'idle'])).toBe(2)
  })
})

describe('formatting', () => {
  it('formats durations by magnitude', () => {
    expect(formatDuration(500)).toBe('<1s')
    expect(formatDuration(18_400)).toBe('18s')
    expect(formatDuration(192_000)).toBe('3m12s')
    expect(formatDuration(3_720_000)).toBe('1h02m')
    expect(formatDuration(-1)).toBe('—')
  })

  it('formats token counts', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(2_500_000)).toBe('2.5M')
  })

  it('summarises tokens only when something was used', () => {
    expect(tokenSummary(undefined)).toBeUndefined()
    expect(tokenSummary({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeUndefined()
    expect(tokenSummary({ uncachedInputTokens: 1500, outputTokens: 200, cacheReadTokens: 9000, cacheWriteTokens: 0 }))
      .toBe('入 1.5k · 出 200 · 缓存 9.0k')
  })

  it('summarises timing for settled and active rounds', () => {
    expect(timingSummary(undefined, 0)).toBeUndefined()
    expect(timingSummary({ settledMs: 0 }, 0)).toBeUndefined()
    expect(timingSummary({ settledMs: 7200 }, 0)).toBe('耗时 7s')
    expect(timingSummary({ settledMs: 7200, active: { since: 10_000, through: 12_000 } }, 25_000)).toBe('进行中 15s')
  })
})

describe('CLI task helpers', () => {
  const base: MaestroTaskSummary = {
    id: 'task-1',
    cli: 'codex',
    title: '重构',
    phase: 'running',
    model: 'gpt-5',
    startedAt: 1000,
  }

  it('measures duration against now until the task ends', () => {
    expect(taskDuration(base, 4000)).toBe(3000)
    expect(taskDuration({ ...base, phase: 'done', endedAt: 2500 }, 9000)).toBe(1500)
  })

  it('allows cancelling only while queued or running', () => {
    expect(taskCancellable(base)).toBe(true)
    expect(taskCancellable({ ...base, phase: 'queued' })).toBe(true)
    expect(taskCancellable({ ...base, phase: 'done' })).toBe(false)
    expect(taskCancellable({ ...base, phase: 'timeout' })).toBe(false)
  })
})

describe('jobLifecycle', () => {
  const job: BoardJob = { id: 'job-1', kind: 'workflow', label: 'wf', status: 'running', startedAt: 1 }

  it('treats running and stopping as live', () => {
    expect(jobLive(job)).toBe(true)
    expect(jobLive({ ...job, status: 'stopping' })).toBe(true)
    expect(jobLive({ ...job, status: 'completed' })).toBe(false)
  })
})

describe('filterTree', () => {
  it('returns the same tree for the "all" filter', () => {
    const root = tree()
    expect(filterTree(root, 'all')).toBe(root)
  })

  it('keeps ancestors of matching descendants so the levels stay connected', () => {
    const kept = filterTree(tree(), 'running')
    // docs 在跑；review 的子树里没有在跑的，被剪掉。
    expect(kept?.children.map(child => child.id)).toEqual(['docs'])
  })

  it('keeps a non-matching parent when a descendant matches', () => {
    const kept = filterTree(tree(), 'done')
    // root 在跑（不命中），但它的后代命中 → 作为祖先保留，且子级被剪到命中的那些。
    expect(kept?.id).toBe('root')
    expect(kept?.children.map(child => child.id)).toEqual(['review', 'cli-1'])
    expect(kept?.children[0]?.children.map(child => child.id)).toEqual(['deep'])
  })

  it('returns undefined when nothing matches', () => {
    expect(filterTree(tree(), 'failed')).toBeUndefined()
  })
})

function cliTask(overrides: Partial<MaestroTaskSummary> = {}): MaestroTaskSummary {
  return {
    id: 'task-1',
    cli: 'codex',
    title: '迁移脚本',
    phase: 'running',
    model: 'gpt-5',
    startedAt: 1_000,
    ...overrides,
  }
}

function jobRow(ownerSessionId: string, overrides: Partial<BoardJob> = {}): BoardJobRow {
  return {
    ownerSessionId,
    job: {
      id: 'job-1',
      kind: 'workflow',
      label: '夜间迁移',
      status: 'running',
      startedAt: 2_000,
      ...overrides,
    },
  }
}

describe('attachRows', () => {
  it('returns the same tree when there is nothing to attach', () => {
    const root = tree()
    expect(attachRows(root, {})).toBe(root)
    expect(attachRows(root, { tasks: [] })).toBe(root)
  })

  it('hangs a CLI task under the session that dispatched it', () => {
    const root = attachRows(tree(), { tasks: [cliTask({ sessionId: 'review' })] })
    const review = root.children.find(child => child.id === 'review')
    // 血缘子级在前，挂上来的 CLI 任务在后。
    expect(review?.children.map(child => child.id)).toEqual(['deep', `${CLI_NODE_PREFIX}task-1`])
    const node = review?.children[1]
    expect(node).toMatchObject({ kind: 'cli', title: '迁移脚本', status: 'running', hasSession: false })
    expect(node?.task?.cli).toBe('codex')
  })

  it('hangs an unowned task under the root and drops one with a foreign session', () => {
    const root = attachRows(tree(), {
      tasks: [cliTask({ id: 'loose' }), cliTask({ id: 'alien', sessionId: 'nope' })],
    })
    const ids = root.children.map(child => child.id)
    expect(ids).toContain(`${CLI_NODE_PREFIX}loose`)
    expect(ids).not.toContain(`${CLI_NODE_PREFIX}alien`)
  })

  it('builds job nodes for the bottom panel, outside the session tree', () => {
    const node = jobNode(jobRow('root'))
    expect(node).toMatchObject({
      kind: 'job',
      id: `${JOB_NODE_PREFIX}root:job-1`,
      title: '夜间迁移',
      status: 'running',
      hasSession: false,
    })
    expect(node.jobRow?.ownerSessionId).toBe('root')
    expect(node.children).toEqual([])
  })

  it('keeps node identity for untouched branches', () => {
    const base = tree()
    const root = attachRows(base, { tasks: [cliTask({ sessionId: 'review' })] })
    const docsBefore = base.children.find(child => child.id === 'docs')
    const docsAfter = root.children.find(child => child.id === 'docs')
    expect(docsAfter).toBe(docsBefore)
  })

  it('keeps CLI ids out of the session id list', () => {
    const root = attachRows(tree(), { tasks: [cliTask({ sessionId: 'root' })] })
    // 会话 id 只该有 agent 节点：混进挂载节点的 id 会让 watchRows 查错会话。
    expect(collectTreeIds(root)).toEqual(['root', 'review', 'deep', 'docs', 'cli-1'])
  })

  it('flattens attached nodes with recomputed depth', () => {
    const root = attachRows(tree(), { tasks: [cliTask({ sessionId: 'review' })] })
    const rows = flattenTree(root)
    const cli = rows.find(row => row.kind === 'cli')
    // review 在第 2 层（depth 1），挂上来的任务在它下面 → depth 2。
    expect(cli?.depth).toBe(2)
  })
})

describe('foldFinished / expandFolds', () => {
  /** 一个父节点挂三个已结束子级 + 一个还在跑的。 */
  function settledSiblings(): BoardNode {
    return buildSessionTree({
      rootId: 'root',
      sessions: {
        root: { id: 'root', displayTitle: '主任务', running: true },
        a: { id: 'a', displayTitle: '甲', parentId: 'root' },
        b: { id: 'b', displayTitle: '乙', parentId: 'root' },
        c: { id: 'c', displayTitle: '丙', parentId: 'root' },
        live: { id: 'live', displayTitle: '还在跑', parentId: 'root', running: true },
      },
    })
  }

  it('collects settled siblings into one row and leaves live ones alone', () => {
    const folded = foldFinished(settledSiblings())
    const root = folded.children
    // 运行中的留在明面上，三个已结束的收成一行。
    expect(root.map(child => child.title)).toEqual(['还在跑', '已完成 3'])
    const group = root[1]
    expect(group?.kind).toBe('fold')
    expect(group?.id).toBe(`${FOLD_NODE_PREFIX}root`)
    // 默认收起：children 是空的，但 members 留着原节点（顺序即树里的顺序）。
    expect(group?.children).toEqual([])
    expect(group?.members?.map(member => member.title)).toEqual(['丙', '甲', '乙'])
  })

  it('leaves a lone settled sibling in place', () => {
    const folded = foldFinished(buildSessionTree({
      rootId: 'root',
      sessions: {
        root: { id: 'root', displayTitle: '主任务', running: true },
        a: { id: 'a', displayTitle: '甲', parentId: 'root' },
      },
    }))
    // 只有一个已结束的兄弟：收起来反而多点一次，保持原样。
    expect(folded.children.map(child => child.title)).toEqual(['甲'])
  })

  it('returns the same tree when there is nothing worth folding', () => {
    const live = buildSessionTree({
      rootId: 'root',
      sessions: {
        root: { id: 'root', displayTitle: '主任务', running: true },
        a: { id: 'a', displayTitle: '甲', parentId: 'root', running: true },
      },
    })
    expect(foldFinished(live)).toBe(live)
    expect(expandFolds(live, new Set())).toBe(live)
  })

  it('spreads members back into children only for expanded groups', () => {
    const folded = foldFinished(settledSiblings())
    const id = `${FOLD_NODE_PREFIX}root`
    const opened = expandFolds(folded, new Set([id]))
    expect(opened.children[1]?.children.map(child => child.title)).toEqual(['丙', '甲', '乙'])
    // 没在集合里的折叠组保持收起。
    expect(expandFolds(folded, new Set(['other'])).children[1]?.children).toEqual([])
  })

  it('keeps a settled node with running descendants out of the group', () => {
    // review 自身已结束，但它底下还有在跑的 deep —— 收起来会把活的东西藏掉。
    const root = buildSessionTree({
      rootId: 'root',
      sessions: {
        root: { id: 'root', displayTitle: '主任务', running: true },
        review: { id: 'review', displayTitle: '代码审查', parentId: 'root' },
        deep: { id: 'deep', displayTitle: '深层子代理', parentId: 'review', running: true },
      },
    })
    const folded = foldFinished(root)
    const review = folded.children.find(child => child.id === 'review')
    expect(review?.children.map(child => child.id)).toEqual(['deep'])
  })
})
