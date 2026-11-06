// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaestroCard, UsageGroup } from '../src/client/MaestroCard.js'
import { useCliAccess } from '../src/client/access.js'
import { MaestroForm } from '../src/client/form.js'
import { SessionPage } from '../src/client/board/Session.js'
import { effectiveOf } from '../src/config.js'
import { handleOverview, handleTasks, StatusStore, type RouteDeps } from '../src/routes.js'
import { TaskRegistry } from '../src/task-registry.js'
import { CLI_ACCESS_HEADER, type MaestroSessionAccess, type MaestroTaskSummary } from '../src/wire.js'
import type { BoardHost, BoardSessionList } from '../src/client/board/data.js'
import type { CliUsageState } from '../src/usage.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, container: HTMLDivElement
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const response = (body: unknown, status = 200): Response => ({ ok: status < 300, status, json: async () => body }) as Response
const access = (id: string, token = 'a'): MaestroSessionAccess => ({ sessionId: id, token: token.repeat(64) })
function Publisher({ value }: { value: MaestroSessionAccess }) {
  const list: BoardSessionList = { byId: {}, projectionsBySession: { [value.sessionId]: { values: { maestroCliAccess: value } } } }
  useCliAccess(list, value.sessionId)
  return null
}
const form = () => new MaestroForm({ getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: true } }), set: async () => true, subscribe: () => () => {} })
const task = (id: string): MaestroTaskSummary => ({ id, cli: 'codex', title: id, phase: 'running', model: '', sessionId: 'owner', startedAt: Date.now() })
async function monitor() { await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent?.startsWith('任务监视'))!.click() }) }
describe('修复：配置卡真实授权路径', () => {
  it('owner/token切换清旧记录并拒绝旧授权迟到结果；detail/cancel带当前capability', async () => {
    const f = form(); let resolveOld: ((r: Response) => void) | undefined
    const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url), token = (init?.headers as Record<string, string>)?.[CLI_ACCESS_HEADER]
      if (path.endsWith('/overview')) return response({ tasks: [], clis: {}, config: {} })
      if (path.endsWith('/models')) return response({ providers: [] })
      if (path.endsWith('/tasks')) {
        expect(token).toBeDefined()
        if (token === 'a'.repeat(64)) return new Promise<Response>(r => { resolveOld = r })
        return response({ tasks: [task(token === 'b'.repeat(64) ? 'current-b' : 'current-c')] })
      }
      if (path.includes('/task?')) { expect(token).toBe('c'.repeat(64)); return response({ summary: task('current-c'), events: [], nextCursor: 0 }) }
      if (path.endsWith('/task/cancel')) { expect(token).toBe('c'.repeat(64)); return response({ id: 'current-c' }) }
      throw Error(path)
    }); vi.stubGlobal('fetch', request)
    const render = async (value: MaestroSessionAccess) => { await act(async () => { root.render(<><Publisher value={value} /><MaestroCard maestroStore={f.bind()} maestro={f.actions()} /></>) }); await monitor() }
    await render(access('owner', 'a'))
    await render(access('other', 'b'))
    expect(container.textContent).toContain('current-b')
    await act(async () => { resolveOld!(response({ tasks: [task('stale-a')] })) })
    expect(container.textContent).not.toContain('stale-a')
    await render(access('other', 'c'))
    expect(container.textContent).not.toContain('current-b')
    expect(container.textContent).toContain('current-c')
    await act(async () => { container.querySelector<HTMLButtonElement>('.dmc-taskrow')?.click() })
    const cancel = [...container.querySelectorAll('button')].find(b => b.textContent === '取消')
    expect(cancel).toBeDefined(); await act(async () => cancel!.click())
    expect(request.mock.calls.some(([url]) => String(url).endsWith('/task/cancel'))).toBe(true)
  })
  it('匿名overview仍排除owner任务，保留老active和最近20terminal；折叠展开都保留active', async () => {
    const config = effectiveOf({}), registry = new TaskRegistry()
    registry.create({ id: 'private', cli: 'codex', title: 'private', model: '', sessionId: 'owner', phase: 'running' })
    const running = registry.create({ id: 'old-active', kind: 'npm', cli: 'codex', title: 'old-active', model: '', phase: 'running' }); running.startedAt = 1
    for (let i = 0; i < 30; i++) registry.create({ id: 'done-' + i, kind: 'npm', cli: 'codex', title: 'done-' + i, model: '', phase: 'done' })
    const deps = { registry, readConfig: () => config, statusStore: new StatusStore(() => config) } as RouteDeps
    const result = handleOverview(deps).body as { tasks: MaestroTaskSummary[] }
    expect(result.tasks).toHaveLength(21); expect(result.tasks.map(t => t.id)).toContain('old-active'); expect(result.tasks.map(t => t.id)).not.toContain('private')
    expect((handleTasks(deps, undefined, { sessionId: 'owner' }).body as { tasks: MaestroTaskSummary[] }).tasks.map(t => t.id)).toContain('private')
    vi.stubGlobal('fetch', async (url: RequestInfo | URL) => String(url).endsWith('/overview') ? response(handleOverview(deps).body) : response({ providers: [] }))
    const f = form(); await act(async () => { root.render(<MaestroCard maestroStore={f.bind()} maestro={f.actions()} />) }); await monitor()
    expect(container.textContent).toContain('old-active')
    const expand = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('显示全部') || b.textContent?.includes('展开'))
    expect(expand).toBeDefined(); await act(async () => expand!.click()); expect(container.textContent).toContain('old-active')
  })
})
describe('修复：取消请求single-flight与错误恢复', () => {
  it.each(['409', 'network'])('%s可见且能重试；双击只一次POST；切换授权忽略旧错误', async kind => {
    let settle: ((r: Response) => void) | undefined
    const request = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/task/cancel')) return new Promise<Response>((resolve, reject) => { settle = kind === '409' ? resolve : () => reject(Error('cancel-network')) })
      if (String(url).endsWith('/tasks')) return response({ tasks: [task('running')] })
      return response({ summary: task('running'), events: [], nextCursor: 0, prompt: 'task' })
    }); vi.stubGlobal('fetch', request)
    const render = async (value: MaestroSessionAccess) => { await act(async () => { root.render(<SessionPage access={value} taskId="running" />) }) }
    await render(access('owner'))
    const stop = () => container.querySelector<HTMLButtonElement>('.dms-stop')!
    await act(async () => { stop().click(); stop().click() })
    expect(request.mock.calls.filter(([u]) => String(u).endsWith('/task/cancel'))).toHaveLength(1)
    expect(stop().disabled).toBe(true)
    await act(async () => { settle!(response({ error: 'cancel-409' }, 409)) })
    expect(container.textContent).toContain('cancel-' + kind); expect(stop().disabled).toBe(false)
    await act(async () => stop().click()); const stale = settle
    await render(access('other', 'b'))
    await act(async () => stale!(response({ error: 'old-owner-error' }, 409)))
    expect(container.textContent).not.toContain('old-owner-error')
  })
})
it('真实UsageGroup持续标样本下限，整体及perCLI显示四桶与未知', async () => {
  const now = Date.now()
  const usage: CliUsageState = { recent: [{ taskId: 't', cli: 'codex', model: '', phase: 'done', startedAt: now - 100, endedAt: now, durationMs: 100, inputTokens: null, knownTokens: { inputTokens: 123 }, outputTokens: 11, cachedInputTokens: 13, cacheWriteTokens: 17 }], totals: { requests: 21, inputTokens: null, outputTokens: 999, cachedInputTokens: 999, cacheWriteTokens: 999, durationMs: 999 } }
  const snapshot: BoardSessionList = { byId: {}, projectionsBySession: { owner: { values: { maestroCliUsage: usage } } } }
  const sessions = { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } }
  const host: BoardHost = { get: () => sessions }
  await act(async () => { root.render(<UsageGroup ctx={host} />) })
  expect(container.textContent).toContain('有限可见样本'); expect(container.textContent).toContain('下限')
  expect(container.textContent?.match(/至少 123/g)).toHaveLength(2)
  expect(container.textContent?.match(/缓存写 17/g)).toHaveLength(2)
  expect(container.textContent?.match(/缓存读 13/g)).toHaveLength(2)
  expect(container.textContent).not.toContain('999')
})
