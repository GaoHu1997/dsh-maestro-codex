import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { BoardTab } from '../src/client/board/Board.js'
import type { BoardHost, BoardSessionList } from '../src/client/board/data.js'
import type { BoardJob, BoardJobRow } from '../src/client/board/model.js'

/**
 * 一个假的客户端宿主：只实现看板结构探测要用的那几层。
 *
 * SSR 只跑渲染、不跑 effect，所以这里不需要真的订阅——只要 `getSnapshot`
 * 能给出稳定快照即可。这正好把「数据折行 → 渲染」整条链路压一遍：树、筛选
 * 计数、四个区块、external 幽灵行、CLI 行、作业行。
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
    review: { id: 'review', displayTitle: '代码审查', parentId: 'root' },
  },
  projectionsBySession: {
    root: {
      values: {
        subagentCatalog: [
          { id: 'review', createdAt: 1, mode: 'continuable' },
          { id: 'cli-2', createdAt: 2, mode: 'external', label: 'codex cli 子代理' },
        ],
        tokenUsage: { uncachedInputTokens: 1500, outputTokens: 200, cacheReadTokens: 9000, cacheWriteTokens: 0 },
      },
    },
  },
}

describe('BoardTab', () => {
  it('renders the header, pills and filters', () => {
    const html = render({ host: host({ list }) })
    expect(html).toContain('任务看板')
    expect(html).toContain('会话树 · CLI 子代理 · 后台任务')
    for (const label of ['全部', '运行中', '已结束', '失败']) expect(html).toContain(label)
    for (const section of ['DSH 会话树', 'CLI 任务', '后台任务']) expect(html).toContain(section)
    // 对应原生标题栏的两个入口胶囊。
    expect(html).toContain('2 个子智能体')
    expect(html).toContain('个后台任务')
  })

  it('renders the session tree with nesting, carets and jump affordances', () => {
    const html = render({ host: host({ list }) })
    expect(html).toContain('dmb-tree')
    expect(html).toContain('dmb-node dmb-node-root')
    expect(html).toContain('dmb-kids')
    expect(html).toContain('aria-expanded="true"')
    // 有会话的子节点可点进去；external 叶子不可点。
    expect(html).toContain('打开这个子会话')
    expect(html).toContain('dmb-node-jump')
  })

  it('shows the root task with its token summary and cwd', () => {
    const html = render({ host: host({ list }) })
    expect(html).toContain('主任务')
    expect(html).toContain('/work/repo')
    expect(html).toContain('入 1.5k · 出 200 · 缓存 9.0k')
    expect(html).toContain('运行中 1')
  })

  it('lists subagent nodes including session-less external ones', () => {
    const html = render({ host: host({ list }) })
    expect(html).toContain('代码审查')
    expect(html).toContain('codex cli 子代理')
    expect(html).toContain('dmb-rowtitle-ghost')
  })

  it('renders a background job row with its lifecycle metadata', () => {
    const html = render({ host: host({ list, jobRows: [{ ownerSessionId: 'root', job }] }) })
    expect(html).toContain('夜间迁移工作流')
    expect(html).toContain('workflow')
    expect(html).toContain('终止')
    expect(html).toContain('打开这个任务所属的会话')
  })

  it('degrades to empty sections when the host services are missing', () => {
    const html = render({ host: host({ withSessions: false, withJobs: false }) })
    expect(html).toContain('任务看板')
    expect(html).toContain('DSH 会话树')
    expect(html).toContain('当前会话')
  })

  it('hides the live badge when nothing is running', () => {
    const html = render({ host: host({ withSessions: false, withJobs: false }) })
    expect(html).not.toContain('运行中 1')
  })
})
