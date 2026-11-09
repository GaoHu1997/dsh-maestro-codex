// @vitest-environment jsdom
/** 上线独立回归：真实 React 组件与浏览器 api，仅 fetch/feed 为内存夹具；不是 GUI 验收。 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionPage } from '../src/client/board/Session.js'
import { UsageGroup } from '../src/client/MaestroCard.js'
import type { BoardHost, BoardSessionList } from '../src/client/board/data.js'
import type { CliUsageState } from '../src/usage.js'
import { CLI_ACCESS_HEADER, type MaestroTaskSummary } from '../src/wire.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const access = { sessionId: 'acceptance-parent', token: 'a'.repeat(64) }
const scope = ['acceptance-child', access.sessionId]
const original: MaestroTaskSummary = {
  id: 'acceptance-original', kind: 'cli', cli: 'codex', sessionId: access.sessionId,
  title: 'original', model: 'configured-model', phase: 'done', startedAt: 1, endedAt: 2,
  sessionRef: 'fictional-test-thread',
}
const continued: MaestroTaskSummary = {
  ...original, id: 'acceptance-reply', title: 'continued', replyTo: original.id,
  replySessionIds: scope, startedAt: 3, endedAt: 4,
}
const response = (body: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
} as Response)
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-07T12:00:00Z'))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const textarea = () => container.querySelector<HTMLTextAreaElement>('.dms-textarea')!
const sendButton = () => container.querySelector<HTMLButtonElement>('.dms-send')!
async function typeDraft(text: string): Promise<void> {
  expect(textarea().disabled).toBe(false)
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(textarea(), text)
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(textarea().value).toBe(text)
}
function replyFixture() {
  let tasks: MaestroTaskSummary[] = [original]
  const replies: ReturnType<typeof deferred<Response>>[] = []
  const bodies: Record<string, unknown>[] = []
  const calls: Array<{ url: URL; token: string | null }> = []
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://test.invalid')
    calls.push({ url, token: new Headers(init?.headers).get(CLI_ACCESS_HEADER) })
    if (url.pathname.endsWith('/task/reply')) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      const reply = deferred<Response>()
      replies.push(reply)
      return reply.promise
    }
    if (url.pathname.endsWith('/tasks')) return response({ tasks })
    if (url.searchParams.has('cursor')) return response({
      summary: tasks.find(task => task.id === url.searchParams.get('id')) ?? continued,
      events: [], nextCursor: 0,
    })
    throw new Error(`Unexpected test route: ${url.pathname}`)
  })
  vi.stubGlobal('fetch', request)
  return { replies, bodies, calls, request, setTasks(next: MaestroTaskSummary[]) { tasks = next } }
}
async function mountSession(): Promise<void> {
  // 倒序传入 scope，验证组件排序后仍带齐同一会话树，而不是丢失子会话。
  await act(async () => root.render(<SessionPage taskId={original.id} access={access} sessionIds={[...scope].reverse()} place="panel" />))
  expect(textarea()).not.toBeNull()
  expect(textarea().disabled).toBe(false)
}
async function poll(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
}

describe('上线回归：续发 composer 的真实 deferred 请求生命周期', () => {
  it('请求 deferred 期间锁 textarea，批内双击及 Enter 只发送一次，保留 capability 与 scope', async () => {
    const fixture = replyFixture()
    await mountSession()
    await typeDraft('  follow-up draft  ')
    await act(async () => {
      // 两次点击发生在 React 提交 disabled 状态前，覆盖同步 sendingRef 防重。
      sendButton().click()
      sendButton().click()
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(fixture.replies).toHaveLength(1)
    expect(fixture.bodies).toEqual([{ id: original.id, text: 'follow-up draft', sessions: scope }])
    expect(textarea().disabled).toBe(true)
    expect(sendButton().disabled).toBe(true)
    expect(textarea().value).toBe('  follow-up draft  ')
    for (const call of fixture.calls) {
      expect(call.token).toBe(access.token)
      if (call.url.searchParams.has('sessions')) expect(call.url.searchParams.get('sessions')).toBe(scope.join(','))
    }
  })

  it('成功响应后未进任务列表仍锁，列表中运行态仍锁，确认终态才解锁并续发到新锚点', async () => {
    const fixture = replyFixture()
    await mountSession()
    await typeDraft('first')
    await act(async () => { sendButton().click() })
    await act(async () => { fixture.replies[0]!.resolve(response({ id: continued.id, phase: 'queued' })) })
    expect(textarea().disabled).toBe(true)
    expect(textarea().value).toBe('')
    await poll() // detail 可读终态，但 task-list 尚未确认：不能据此提前解锁。
    expect(textarea().disabled).toBe(true)
    expect(fixture.replies).toHaveLength(1)
    fixture.setTasks([original, { ...continued, phase: 'running' }])
    await poll()
    expect(textarea().disabled).toBe(true)
    fixture.setTasks([original, continued])
    await poll()
    expect(textarea().disabled).toBe(false)
    await typeDraft('second')
    await act(async () => { sendButton().click() })
    expect(fixture.replies).toHaveLength(2)
    expect(fixture.bodies[1]).toEqual({ id: continued.id, text: 'second', sessions: scope })
    expect(fixture.calls.every(call => call.token === access.token)).toBe(true)
  })

  it.each(['HTTP 409', 'network'])('%s 失败后解锁、保留原稿、显示错误并可重试', async kind => {
    const fixture = replyFixture()
    await mountSession()
    await typeDraft('keep this unsent draft')
    await act(async () => { sendButton().click() })
    await act(async () => {
      if (kind === 'HTTP 409') fixture.replies[0]!.resolve(response({ error: 'acceptance-reply-409' }, 409))
      else fixture.replies[0]!.reject(new Error('acceptance-reply-network'))
    })
    expect(textarea().disabled).toBe(false)
    expect(textarea().value).toBe('keep this unsent draft')
    expect(sendButton().disabled).toBe(false)
    expect(container.textContent).toContain(kind === 'HTTP 409' ? 'acceptance-reply-409' : 'acceptance-reply-network')
    await act(async () => { sendButton().click() })
    expect(fixture.replies).toHaveLength(2)
    expect(fixture.bodies[1]).toEqual(fixture.bodies[0])
    expect(textarea().disabled).toBe(true)
  })

  it('仅有 scope 没有 capability 时不挂 composer，也不发任何请求', async () => {
    const fixture = replyFixture()
    await act(async () => root.render(<SessionPage taskId={original.id} sessionIds={scope} />))
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.textContent).toContain('缺少当前父会话')
    expect(fixture.request).not.toHaveBeenCalled()
  })
})

function feedHost(snapshot: BoardSessionList): BoardHost {
  const sessions = { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } }
  return { get: name => name === 'sessions' ? sessions : undefined }
}
async function mountUsage(ctx: BoardHost | undefined): Promise<void> {
  await act(async () => root.render(<UsageGroup ctx={ctx} />))
}
const sampleTitle = '用量统计（近 7 天可见样本）'
const sampleNote = '每个会话仅最近 20 次调用；不是完整账本。'
const unavailable = '会话用量 feed 不可用，无法统计调用次数。'
const emptySample = '近 7 天可见样本中没有 CLI 调用。'

describe('上线回归：真实 UsageGroup 区分可见样本与 feed 缺失', () => {
  it('总账本 21 次但可见样本仅 1 次时明确标注 7 天 / 20 次 / 非完整账本', async () => {
    const now = Date.now()
    const usage: CliUsageState = {
      recent: [{ taskId: 'acceptance-usage', cli: 'codex', model: '', phase: 'done', startedAt: now - 100, endedAt: now, durationMs: 100,
        inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteTokens: null }],
      totals: { requests: 21, inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, durationMs: 2100 },
    }
    await mountUsage(feedHost({ byId: {}, projectionsBySession: { parent: { values: { maestroCliUsage: usage } } } }))
    expect(container.querySelector('.dmc-grouptitle')?.textContent).toBe(sampleTitle)
    expect(container.textContent).toContain(sampleNote)
    const row = container.querySelector('.dmc-usagerow')!
    expect([...row.querySelectorAll('.dmc-usagenum')].map(cell => cell.textContent)).toEqual(['1', '1', '0'])
    expect(container.textContent).not.toContain(unavailable)
    expect(container.textContent).not.toContain(emptySample)
  })

  it('存在合法空 feed 时只称可见样本为空，不称完整 7 天零调用', async () => {
    await mountUsage(feedHost({ byId: {}, projectionsBySession: {} }))
    expect(container.querySelector('.dmc-grouptitle')?.textContent).toBe(sampleTitle)
    expect(container.textContent).toContain(sampleNote)
    expect(container.textContent).toContain(emptySample)
    expect(container.textContent).not.toContain(unavailable)
    expect(container.textContent).not.toContain('近 7 天还没有 CLI 调用。')
    expect(container.querySelector('.dmc-usagerow')).toBeNull()
  })

  it.each(['no host', 'missing service', 'malformed service'])('%s 不能误显示零调用', async kind => {
    const ctx: BoardHost | undefined = kind === 'no host' ? undefined
      : { get: () => kind === 'malformed service' ? { list: { getSnapshot: () => ({ byId: {} }) } } : undefined }
    await mountUsage(ctx)
    expect(container.textContent).toContain(unavailable)
    expect(container.textContent).not.toContain(emptySample)
    expect(container.textContent).not.toContain('近 7 天还没有 CLI 调用。')
    expect(container.querySelector('.dmc-usagerow')).toBeNull()
  })
})
