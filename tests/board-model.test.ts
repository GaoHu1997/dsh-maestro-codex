import { describe, expect, it } from 'vitest'

import {
  buildSessionTree,
  cliStatusOf,
  collectTreeIds,
  countActive,
  filterTree,
  flattenTree,
  formatDuration,
  formatTokens,
  jobLive,
  jobStatusOf,
  matchesFilter,
  taskCancellable,
  taskDuration,
  timingSummary,
  tokenSummary,
  type BoardCatalogEntry,
  type BoardJob,
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
