import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { BoardTab, collectBands } from '../src/client/board/Board.js'
import type { BoardHost, BoardSessionList } from '../src/client/board/data.js'
import { buildSessionTree, type BoardJob, type BoardJobRow } from '../src/client/board/model.js'

/**
 * 一个假的客户端宿主：只实现看板结构探测要用的那几层。
 *
 * SSR 只跑渲染、不跑 effect，所以这里不需要真的订阅——只要 `getSnapshot`
 * 能给出稳定快照即可。这正好把「数据折行 → 渲染」整条链路压一遍：会话树、
 * 底部面板里的后台作业、筛选计数、external 幽灵节点。
 *
 * CLI 子代理来自 HTTP 轮询（`useCliTasks` 的 effect），SSR 里不跑，所以它的
 * 挂载逻辑由 `board-model.test.ts` 的 `attachRows` 覆盖。
 */
function host(options: {
  list?: BoardSessionList
  jobRows?: readonly BoardJobRow[]
  withSessions?: boolean
  withJobs?: boolean
} = {}): BoardHost {
  const list = options.list ?? { byId: {} }
  const rows: Record<string, BoardJob[]> = {}
  for (const row of options.jobRows ?? []) {
    const bucket = rows[row.ownerSessionId] ?? (rows[row.ownerSessionId] = [])
    bucket.push(row.job)
  }
  const jobSnapshot = { rows, observed: {} }
  const services: Record<string, unknown> = {
    workspace: { openSession: () => {} },
  }
  if (options.withSessions !== false) {
    services.sessions = { list: { getSnapshot: () => list, subscribe: () => () => {} } }
  }
  if (options.withJobs !== false) {
    services.jobs = {
      state: { getSnapshot: () => jobSnapshot, subscribe: () => () => {} },
      watchRows: () => () => {},
      observe: () => () => {},
      kill: async () => {},
    }
  }
  return { get: name => services[name] }
}

const job: BoardJob = {
  id: 'job-1',
  kind: 'workflow',
  label: '夜间迁移工作流',
  status: 'running',
  startedAt: 1_700_000_000_000,
}

function render(input: { host?: BoardHost; visible?: boolean } = {}): string {
  return renderToStaticMarkup(createElement(BoardTab, {
    ctx: input.host ?? host(),
    scope: { sessionId: 'root', cwd: '/work/repo' },
    ...(input.visible === undefined ? {} : { visible: input.visible }),
  }))
}

const list: BoardSessionList = {
  byId: {
    root: { id: 'root', displayTitle: '主任务', cwd: '/work/repo', running: true },
    // review 还在跑：所以它不会被收进「已完成」折叠组，幽灵节点也留在明面上。
    review: { id: 'review', displayTitle: '代码审查', parentId: 'root', running: true },
  },
  projectionsBySession: {
    root: {
      values: {
        subagentCatalog: [
          { id: 'review', createdAt: 1, mode: 'continuable' },
          { id: 'cli-2', createdAt: 2, mode: 'external', label: 'code CLI 子代理' },
        ],
        tokenUsage: { uncachedInputTokens: 1500, outputTokens: 200, cacheReadTokens: 9000, cacheWriteTokens: 0 },
      },
    },
  },
}

describe('BoardTab', () => {
  it('renders the header, filters and the single tree surface', () => {
    const html = render({ host: host({ list }) })
    expect(html).toContain('任务看板')
    expect(html).toContain('会话树 · CLI 子代理 · 后台任务')
    for (const label of ['全部', '运行中', '已结束', '失败']) expect(html).toContain(label)
    // 三类任务现在共用一棵树，不再各占一段列表。
    expect(html).toContain('role="tree"')
    expect(html).toContain('dmb-graph')
    expect(html).not.toContain('dmb-sec')
  })

  it('lays the tree out as layered bands of cards', () => {
    const html = render({ host: host({ list }) })
    // 根一张卡 + 子级一层：`collectBands` 把层级折成带。
    expect(html).toContain('dmb-gcard dmb-gcard-root')
    expect(html.match(/dmb-band/g)).toHaveLength(2)
    expect(html).toContain('dmb-gcard-kids')
    expect(html).toContain('aria-level="2"')
    expect(html).toContain('aria-expanded="true"')
  })

  it('shows the root task with its token summary and mode chip', () => {
    const html = render({ host: host({ list }) })
    expect(html).toContain('主任务')
    expect(html).toContain('入 1.5k · 出 200 · 缓存 9.0k')
    // 根与 review 都在跑 → 2 个活跃。
    expect(html).toContain('运行中 2')
    expect(html).toContain('可续接')
  })

  it('lists subagent nodes including session-less external ones', () => {
    const html = render({ host: host({ list }) })
    expect(html).toContain('代码审查')
    expect(html).toContain('code CLI 子代理')
    // external 子级没有本地会话：画成斜体幽灵卡，不暗示能点进去。
    expect(html).toContain('dmb-gcard-title-ghost')
  })

  it('lists background jobs in the bottom panel instead of the tree', () => {
    const html = render({ host: host({ list, jobRows: [{ ownerSessionId: 'root', job }] }) })
    expect(html).toContain('后台任务')
    expect(html).toContain('dmb-jobs')
    expect(html).toContain('data-node="job:root:job-1"')
    // 树里不再有作业：根只报 2 个子级（review + external 幽灵），带还是两层。
    expect(html).toContain('子 2')
    expect(html.match(/dmb-band/g)).toHaveLength(2)
    // 作业标题只在面板里出现一次，没有同时挂在树上。
    expect(html.match(/夜间迁移工作流/g)).toHaveLength(1)
  })

  it('drops roster rows whose owner is outside the session tree', () => {
    // job.owner 指向树外会话 → 丢弃；无主作业（owner 缺省）任何名册都可见。
    const html = render({
      host: host({ list, jobRows: [{ ownerSessionId: 'nope', job: { ...job, owner: 'nope' } }] }),
    })
    expect(html).not.toContain('夜间迁移工作流')
    expect(html).toContain('没有后台任务')
  })

  it('hides the jobs panel when the host has no jobs service', () => {
    const html = render({ host: host({ list, withJobs: false }) })
    expect(html).not.toContain('dmb-jobs')
  })

  it('folds finished siblings into one dashed row that names its members', () => {
    const html = render({
      host: host({
        list: {
          byId: {
            root: { id: 'root', displayTitle: '主任务', running: true },
            a: { id: 'a', displayTitle: '甲', parentId: 'root' },
            b: { id: 'b', displayTitle: '乙', parentId: 'root' },
          },
        },
      }),
    })
    // 两个已结束的兄弟收成一行，标题报数，chip 里点名（CLI 节点也不能凭空消失）。
    expect(html).toContain('已完成 2')
    expect(html).toContain('dmb-gcard-fold')
    expect(html).toContain('dmb-chip-fold')
    expect(html).toContain('甲 / 乙')
    // 收起状态：成员不在带里，只有折叠行自己。
    expect(html.match(/dmb-band/g)).toHaveLength(2)
  })

  it('degrades to a single current-session node when the host services are missing', () => {
    const html = render({ host: host({ withSessions: false, withJobs: false }) })
    expect(html).toContain('任务看板')
    expect(html).toContain('当前会话')
    expect(html).toContain('role="tree"')
  })

  it('hides the live badge when nothing is running', () => {
    const html = render({ host: host({ withSessions: false, withJobs: false }) })
    expect(html).not.toContain('运行中 1')
  })
})

describe('collectBands', () => {
  const root = buildSessionTree({
    rootId: 'root',
    sessions: {
      root: { id: 'root', displayTitle: '主任务', running: true },
      review: { id: 'review', displayTitle: '代码审查', parentId: 'root' },
      docs: { id: 'docs', displayTitle: '文档任务', parentId: 'root' },
      deep: { id: 'deep', displayTitle: '深层子代理', parentId: 'review' },
    },
  })

  it('folds each level of the tree into one band', () => {
    const bands = collectBands(root, new Set())
    expect(bands.map(band => band.map(node => node.title))).toEqual([
      ['主任务'],
      ['代码审查', '文档任务'],
      ['深层子代理'],
    ])
  })

  it('stops descending at a folded node', () => {
    const bands = collectBands(root, new Set(['review']))
    // review 收起 → deep 不再出现在带里，它的兄弟照旧。
    expect(bands).toHaveLength(2)
    expect(bands[1]?.map(node => node.id)).toEqual(['review', 'docs'])
  })

  it('skips bands that would be empty', () => {
    const leaf = buildSessionTree({ rootId: 'solo', sessions: { solo: { id: 'solo', displayTitle: '独苗' } } })
    expect(collectBands(leaf, new Set())).toHaveLength(1)
  })
})
