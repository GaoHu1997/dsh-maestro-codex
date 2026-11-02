import { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  jobsFaceOf, killJob, sessionsFaceOf, useBoardJobs, useSessionList,
  type BoardHost, type BoardJobsFace, type BoardSessionList, type BoardSessionsFace,
} from '../src/client/board/data.js'
import { BoardTab } from '../src/client/board/Board.js'
import { attachLocale } from '../src/client/board/upstream/client/locales.js'

beforeEach(() => {
  attachLocale({ getSnapshot: () => ({ active: 'zh-CN' }) })
})

const list: BoardSessionList = {
  byId: { root: { id: 'root', displayTitle: 'Native root', running: true } },
  projectionsBySession: { root: {
    state: 'ready', error: null,
    values: {
      agentTeam: { members: [{ id: 'root', name: 'Lead', role: 'lead', phase: 'active' }], tasks: [] },
    },
  } },
}
function sessions(snapshot = list): BoardSessionsFace {
  return { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } }
}
function jobs(): BoardJobsFace {
  return {
    state: {
      getSnapshot: () => ({
        rows: { root: [{ id: 'native-job', kind: 'bash', label: 'Native output', status: 'running', startedAt: 1 }] },
        observed: { 'native-job': { text: 'live output', gapBefore: false, streaming: true } },
      }),
      subscribe: () => () => {},
    },
    watchRows: vi.fn(() => () => {}), observe: vi.fn(() => () => {}), kill: vi.fn(async () => {}),
  }
}
function Snapshot(props: { ctx: BoardHost }) {
  const current = useSessionList(props.ctx)
  const roster = useBoardJobs(props.ctx, ['root'], false, null)
  return createElement('pre', null, JSON.stringify({
    title: current.byId.root?.displayTitle,
    projection: current.projectionsBySession?.root,
    jobs: roster.rows, observed: roster.observed, available: roster.available,
  }))
}

describe('native Board context service properties', () => {
  it('prefers direct typed sessions/jobs without touching get fallback', () => {
    const sessionService = sessions()
    const jobService = jobs()
    const get = vi.fn(() => { throw new Error('Native properties must win') })
    const ctx: BoardHost = { sessions: sessionService, jobs: jobService, get }
    expect(sessionsFaceOf(ctx)).toBe(sessionService)
    expect(jobsFaceOf(ctx)).toBe(jobService)
    const html = renderToStaticMarkup(createElement(Snapshot, { ctx }))
    for (const text of ['Native root', 'Native output', 'live output', 'Lead', 'ready']) expect(html).toContain(text)
    expect(get).not.toHaveBeenCalled()
    // Hidden SSR reads do not start watches or output observations.
    expect(jobService.watchRows).not.toHaveBeenCalled()
    expect(jobService.observe).not.toHaveBeenCalled()
  })

  it('retains get-based host compatibility when direct services are absent', () => {
    const sessionService = sessions()
    const jobService = jobs()
    const services: Record<string, unknown> = { sessions: sessionService, jobs: jobService }
    const ctx: BoardHost = { get: vi.fn(name => services[name]) }
    expect(sessionsFaceOf(ctx)).toBe(sessionService)
    expect(jobsFaceOf(ctx)).toBe(jobService)
    expect(renderToStaticMarkup(createElement(Snapshot, { ctx }))).toContain('Native root')
  })

  it('rejects malformed fallback services without inventing a feed', () => {
    expect(sessionsFaceOf({ get: () => ({ list: {} }) })).toBeUndefined()
    expect(jobsFaceOf({ get: () => ({ state: {} }) })).toBeUndefined()
    expect(sessionsFaceOf({ get: () => null })).toBeUndefined()
    expect(jobsFaceOf({ get: () => undefined })).toBeUndefined()
  })

  it('renders the board in a real sidebar Cordis scope without jobs injection', async () => {
    const root = new Context()
    const sessionService = sessions()
    const jobService = jobs()
    const provider = root.plugin({
      name: 'host-jobs',
      apply(ctx: Context) {
        ctx.provide('sessions', sessionService)
        ctx.provide('jobs', jobService)
      },
    })
    await provider.await()
    let scope: BoardHost | undefined
    const fiber = root.plugin({
      name: 'dsh-better-sidebar',
      apply(ctx: Context) { scope = ctx as unknown as BoardHost },
    })
    await fiber.await()
    try {
      expect(scope).toBeDefined()
      if (scope === undefined) throw new Error('Sidebar scope did not load')
      // Reproduce the real host guard, rather than a permissive plain-object mock.
      expect(() => scope.jobs).toThrow('cannot get property "jobs" without inject')
      expect(sessionsFaceOf(scope)?.list.getSnapshot()).toEqual(list)
      expect(jobsFaceOf(scope)?.state.getSnapshot().rows.root?.[0]?.id).toBe('native-job')
      const html = renderToStaticMarkup(createElement(BoardTab, {
        ctx: scope, scope: { sessionId: 'root' }, visible: false,
      }))
      expect(html).toContain('data-maestro-board-root="root"')
      expect(html).toContain('Native output')
      expect(await killJob(scope, 'root', 'native-job')).toBeUndefined()
      expect(jobService.kill).toHaveBeenCalledWith('root', 'native-job')
    } finally { await fiber.dispose(); await root.fiber.dispose() }
  })

  it('renders a real Cordis board when the optional jobs service is absent', async () => {
    const root = new Context()
    root.provide('sessions', sessions())
    let scope: BoardHost | undefined
    const fiber = root.plugin({
      name: 'dsh-better-sidebar',
      apply(ctx: Context) { scope = ctx as unknown as BoardHost },
    })
    await fiber.await()
    try {
      if (scope === undefined) throw new Error('Sidebar scope did not load')
      expect(() => scope.jobs).toThrow('cannot get property "jobs" without inject')
      expect(jobsFaceOf(scope)).toBeUndefined()
      const html = renderToStaticMarkup(createElement(BoardTab, {
        ctx: scope, scope: { sessionId: 'root' }, visible: false,
      }))
      expect(html).toContain('data-maestro-board-root="root"')
      expect(await killJob(scope, 'root', 'missing')).toBe('当前部署没有后台作业服务')
    } finally { await fiber.dispose(); await root.fiber.dispose() }
  })

  it('sends cancellation through the native property service', async () => {
    const service = jobs()
    const ctx: BoardHost = { jobs: service, get: () => undefined }
    expect(await killJob(ctx, 'root', 'native-job')).toBeUndefined()
    expect(service.kill).toHaveBeenCalledWith('root', 'native-job')
  })

  it('counts only the main session background jobs, not subagent session rosters', () => {
    const tree: BoardSessionList = {
      byId: {
        root: { id: 'root', displayTitle: 'Root session', running: true },
        child: { id: 'child', parentId: 'root', displayTitle: 'Child session' },
      },
      projectionsBySession: {
        root: { state: 'ready', error: null, values: {
          subagentCatalog: [{ id: 'child', createdAt: 1, mode: 'one-shot', label: 'Child session' }],
        } },
        child: { state: 'ready', error: null, values: {} },
      },
    }
    const jobService: BoardJobsFace = {
      state: {
        getSnapshot: () => ({
          rows: {
            root: [{ id: 'job-root', kind: 'bash', label: 'Root job', owner: 'root', status: 'completed', startedAt: 2 }],
            child: [{ id: 'job-child', kind: 'bash', label: 'Child job', owner: 'child', status: 'completed', startedAt: 1 }],
          },
          observed: {},
        }),
        subscribe: () => () => {},
      },
      watchRows: vi.fn(() => () => {}), observe: vi.fn(() => () => {}), kill: vi.fn(async () => {}),
    }
    const ctx: BoardHost = {
      sessions: { list: { getSnapshot: () => tree, subscribe: () => () => {} } },
      jobs: jobService,
      get: () => undefined,
    }
    const html = renderToStaticMarkup(createElement(BoardTab, {
      ctx, scope: { sessionId: 'root' }, visible: false,
    }))
    // 子会话那条作业不进看板的后台任务抽屉，计数与宿主页头保持同一口径。
    expect(html).toContain('1 个后台任务')
    expect(html).not.toContain('2 个后台任务')
    expect(html).toContain('Root job')
    expect(html).not.toContain('Child job')
  })
})
