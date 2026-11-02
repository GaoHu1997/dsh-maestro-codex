// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MaestroTaskEvent, MaestroTaskSummary } from '../src/wire.js'

// Exercise the supported missing-host-DisclosureRow fallback, not a visual imitation.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (importOriginal) => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-client-ui-primitives')>(), DisclosureRow: undefined,
}))
const { SessionPage, buildChain, flowBlocksOf, processTextSeqs } = await import('../src/client/board/Session.js')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const access = { sessionId: 'owner-a', token: 'a'.repeat(64) }
const summary: MaestroTaskSummary = { id: 'task-a', sessionId: 'owner-a', cli: 'codex', title: 'task title', phase: 'done', model: 'm', startedAt: 1, sessionRef: 'native-ref' }
const event = (seq: number, text: string, kind: MaestroTaskEvent['kind'] = 'text'): MaestroTaskEvent => ({ seq, at: seq, text, kind })
const bodies = (events: readonly MaestroTaskEvent[], final?: string) => flowBlocksOf(events, final).flatMap(block => block.kind === 'text' ? [block.body] : [])
const response = (body: unknown, status = 200): Response => ({ ok: status === 200, status, json: async () => body } as Response)
let root: Root
let container: HTMLDivElement
beforeEach(() => { vi.useFakeTimers(); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function mount(sessionIds = ['owner-a'], currentAccess = access): Promise<void> {
  await act(async () => { root.render(<SessionPage taskId="task-a" access={currentAccess} sessionIds={sessionIds} place="panel" />) })
}
function executionGroup(): HTMLDetailsElement {
  const group = container.querySelector<HTMLDetailsElement>('[data-execution-process]')
  expect(group).not.toBeNull()
  return group!
}
async function expandExecutionGroup(group = executionGroup()): Promise<void> {
  if (!group.open) await act(async () => { group.querySelector('summary')?.click() })
  expect(group.open).toBe(true)
}
function routes(detail: (url: URL) => Response | Promise<Response>, tasks: MaestroTaskSummary[] = [summary]) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://host')
    return url.searchParams.has('cursor') ? detail(url) : response({ tasks })
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('transcript reconciliation regressions MA-03/04/07', () => {
  it('merges adjacent text frames without adding Markdown-breaking newlines', () => {
    expect(bodies([event(1, '**hel'), event(2, 'lo**\n```ts\ncon'), event(3, 'st a=1\n```')])).toEqual(['**hello**\n```ts\nconst a=1\n```'])
  })
  it('preserves final additions while replacing the exact streamed snapshot once', () => {
    expect(bodies([event(1, '已修复。')], '已修复。新增：测试通过。')).toEqual(['已修复。新增：测试通过。'])
  })
  it('suppresses only a final already present in the stream', () => {
    expect(bodies([event(1, 'prefix 完整答复 suffix')], '完整答复')).toEqual(['prefix 完整答复 suffix'])
    expect(bodies([], 'final only')).toEqual(['final only'])
  })
  it('reconciles cross-boundary snapshots while retaining tool ordering', () => {
    const blocks = flowBlocksOf([event(1, 'A'), event(2, 'Read', 'tool'), event(3, 'B')], 'AB+C')
    expect(blocks.map(block => block.kind)).toEqual(['tool', 'text'])
    expect(bodies([event(1, 'A'), event(2, 'Read', 'tool'), event(3, 'B')], 'AB+C')).toEqual(['AB+C'])
  })
  it('deduplicates exact suffix-prefix overlap without normalizing Markdown spaces', () => {
    expect(bodies([event(1, 'prefix\nshared')], 'shared\nnew')).toEqual(['prefix\nshared\nnew'])
    expect(bodies([event(1, 'x  y')], 'x y')).toEqual(['x  y', 'x y'])
    expect(bodies([event(1, 'before😀')], '😀new')).toEqual(['before😀new'])
  })
  it('preserves the selected sibling and its ancestry instead of choosing the oldest child', () => {
    const tasks = { a: { ...summary, id: 'a' }, b: { ...summary, id: 'b', replyTo: 'a', startedAt: 2 }, c: { ...summary, id: 'c', replyTo: 'a', startedAt: 3 }, d: { ...summary, id: 'd', replyTo: 'c', startedAt: 4 } }
    expect(buildChain('c', tasks)).toEqual(['a', 'c', 'd'])
    expect(buildChain('d', tasks)).toEqual(['a', 'c', 'd'])
  })
})

describe('safe execution prose disclosure', () => {
  it('folds only earlier complete prose blocks while preserving exact final and last partial output', () => {
    const blocks = flowBlocksOf([event(1, 'PROCESS-ONE'), event(2, 'Read', 'tool'), event(3, 'PROCESS-TWO'), event(4, 'Write', 'tool'), event(5, 'FINAL')], 'FINAL')
    expect([...processTextSeqs(blocks, 'FINAL')]).toEqual([1, 3])
    expect([...processTextSeqs(flowBlocksOf([event(1, 'PROCESS'), event(2, 'Read', 'tool'), event(3, 'partial answer')], 'standalone final'), 'standalone final')]).toEqual([1])
  })
  it('protects finals in an earlier block, across blocks, and inside complete Markdown', () => {
    expect([...processTextSeqs(flowBlocksOf([event(1, 'FINAL'), event(2, 'Read', 'tool'), event(3, 'later useful reply')], 'FINAL'), 'FINAL')]).toEqual([])
    expect([...processTextSeqs(flowBlocksOf([event(1, 'FIRST'), event(2, 'Read', 'tool'), event(3, 'SECOND')], 'FIRSTSECOND'), 'FIRSTSECOND')]).toEqual([])
    expect([...processTextSeqs(flowBlocksOf([event(1, 'prefix FINAL suffix'), event(2, 'Read', 'tool')], 'FINAL'), 'FINAL')]).toEqual([])
    expect([...processTextSeqs(flowBlocksOf([event(1, 'only partial'), event(2, 'Read', 'tool')]), undefined)]).toEqual([])
  })
  it('renders old untyped process prose closed, with final and errors outside the disclosure', async () => {
    const finalText = '正在分析，下一步请参考最终结论。'
    routes(() => response({ summary, finalText, events: [event(1, 'PROCESS-FIRST\nPROCESS-FULL'), { ...event(2, 'Read', 'tool'), detail: 'arguments\noutput' }, event(3, 'VISIBLE-ERROR', 'error'), event(4, finalText)], nextCursor: 5 }))
    await mount()
    const process = executionGroup()
    expect(process.open).toBe(false)
    expect(process.querySelector('summary')?.textContent).toContain('思考与执行过程')
    expect(container.querySelector('.dms-agent .dms-md')?.textContent).toBe(finalText)
    expect(container.querySelector('.dms-errline')?.closest('[data-execution-process]')).toBeNull()
    expect(container.querySelector('.dms-errline')?.textContent).toContain('VISIBLE-ERROR')
    await expandExecutionGroup(process)
    expect(container.querySelector('[data-process-text]')?.textContent).toContain('PROCESS-FULL')
  })
  it.each(['failed', 'timeout', 'cancelled', 'interrupted'] as const)('keeps partial replies visible for %s turns even with a saved final snapshot', async phase => {
    routes(() => response({ summary: { ...summary, phase }, finalText: 'saved partial', events: [event(1, 'earlier useful partial'), event(2, 'Read', 'tool'), event(3, 'saved partial')], nextCursor: 4 }))
    await mount()
    expect(container.querySelector('[data-process-text]')).toBeNull()
    expect([...container.querySelectorAll('.dms-agent .dms-md')].map(row => row.textContent)).toEqual(['earlier useful partial', 'saved partial'])
  })
})

describe('real effects regressions MA-05/06/10/23 and synchronous send lock', () => {
  it('retains historical text and cursor through a transient detail failure', async () => {
    let calls = 0
    const cursors: string[] = []
    routes(url => {
      cursors.push(url.searchParams.get('cursor') ?? '')
      calls += 1
      if (calls === 2) return response({ error: 'temporary 503' }, 503)
      return response({ summary: { ...summary, phase: calls < 3 ? 'running' : 'done' }, events: [event(calls === 1 ? 1 : 2, calls === 1 ? 'EARLY-HISTORY ' : 'LATEST')], nextCursor: calls === 1 ? 2 : 3 })
    }, [{ ...summary, phase: 'running' }])
    await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(container.textContent).toContain('EARLY-HISTORY')
    expect(container.textContent).toContain('已保留历史')
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(container.textContent).toContain('EARLY-HISTORY LATEST')
    expect(cursors).toEqual(['0', '2', '2'])
  })
  it('labels the local 800-event cap and restores available server history on demand', async () => {
    const events = Array.from({ length: 805 }, (_, index) => event(index + 1, index === 0 ? 'RESTORED-FIRST ' : 'x'))
    const mock = routes(() => response({ summary, events, nextCursor: 806 }))
    await mount()
    expect(container.textContent).toContain('最近 800 个事件')
    expect(container.textContent).not.toContain('RESTORED-FIRST')
    const restore = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('恢复服务端'))
    await act(async () => { restore?.click() })
    expect(container.textContent).toContain('RESTORED-FIRST')
    expect(container.textContent).not.toContain('最近 800 个事件')
    expect(mock.mock.calls.filter(([url]) => String(url).includes('cursor=0'))).toHaveLength(2)
  })
  it('clears old scope text immediately and rejects its late detail response', async () => {
    let resolveOld: ((value: Response) => void) | undefined
    routes(url => url.searchParams.get('sessions') === 'owner-a'
      ? new Promise<Response>(resolve => { resolveOld = resolve })
      : response({ summary: { ...summary, sessionId: 'owner-b' }, events: [event(1, 'NEW-SCOPE')], nextCursor: 2 }))
    await mount()
    await mount(['owner-b'], { sessionId: 'owner-b', token: 'b'.repeat(64) })
    await act(async () => { resolveOld?.(response({ summary, events: [event(1, 'SECRET-OLD-SCOPE')], nextCursor: 2 })) })
    expect(container.textContent).toContain('NEW-SCOPE')
    expect(container.textContent).not.toContain('SECRET-OLD-SCOPE')
  })
  it('resets expanded native process and inner rows when the same task changes authorization scope', async () => {
    routes(url => {
      const owner = url.searchParams.get('sessions') === 'owner-b' ? 'owner-b' : 'owner-a'
      return response({ summary: { ...summary, sessionId: owner }, events: [event(1, `${owner}-THOUGHT`, 'thinking'),
        { ...event(2, `${owner}-TOOL`, 'tool'), detail: `${owner}-DETAIL` }], nextCursor: 3 })
    })
    await mount()
    await expandExecutionGroup()
    const oldGroup = executionGroup()
    const oldRows = [...container.querySelectorAll('details:not([data-execution-process])')]
    await act(async () => { oldRows.forEach(row => row.querySelector('summary')?.click()) })
    expect(oldGroup.open).toBe(true)
    expect(oldRows.map(row => row.open)).toEqual([true, true])
    await mount(['owner-b'], { sessionId: 'owner-b', token: 'b'.repeat(64) })
    const newGroup = executionGroup()
    const newRows = [...container.querySelectorAll('details:not([data-execution-process])')]
    expect(newGroup).not.toBe(oldGroup)
    expect(newGroup.open).toBe(false)
    expect(newRows).toHaveLength(2)
    expect(newRows.every(row => !row.open && !oldRows.includes(row))).toBe(true)
    expect(getComputedStyle(newGroup.querySelector('.dms-execution-body')!).display).toBe('none')
    expect(container.textContent).toContain('owner-b-THOUGHT')
    expect(container.textContent).not.toContain('owner-a-THOUGHT')
  })
  it('deduplicates error event/terminal metadata and provides native details for full thinking/results', async () => {
    routes(() => response({ summary: { ...summary, phase: 'failed' }, error: 'SAME-ERROR', events: [event(1, 'SAME-ERROR', 'error'), event(2, 'SAME-ERROR', 'error'), event(3, 'THOUGHT-FIRST\nTHOUGHT-FULL', 'thinking'), { ...event(4, 'Tool result', 'result'), detail: 'RESULT-FIRST\nRESULT-FULL' }], nextCursor: 5 }))
    await mount()
    expect(container.textContent?.match(/SAME-ERROR/g)).toHaveLength(1)
    expect(executionGroup().open).toBe(false)
    expect(container.querySelector('.dms-errline')?.closest('[data-execution-process]')).toBeNull()
    await expandExecutionGroup()
    const details = container.querySelectorAll('details:not([data-execution-process])')
    expect(details).toHaveLength(2)
    expect(details[0]?.textContent).toContain('THOUGHT-FULL')
    expect(details[1]?.textContent).toContain('RESULT-FULL')
  })
  it('QA-04 keeps distinct tool error details readable in native disclosures (M)', async () => {
    const reasonA = 'Read denied\nNATIVE-CAUSE-A'
    const reasonB = 'Read denied\nNATIVE-CAUSE-B'
    routes(() => response({ summary: { ...summary, phase: 'failed' }, error: reasonA, nextCursor: 5,
      events: [event(1, '有效部分回复'), { ...event(2, 'Read', 'error'), detail: reasonA },
        { ...event(3, 'Read', 'error'), detail: reasonA }, { ...event(4, 'Read', 'error'), detail: reasonB }] }))
    await mount()
    const details = [...container.querySelectorAll('details:not([data-execution-process])')]
    expect(details).toHaveLength(2)
    expect(details.every(row => !row.open)).toBe(true)
    expect(details.map(row => row.querySelector('pre')?.textContent)).toEqual([reasonA, reasonB])
    expect(details[0]?.querySelector('summary')?.textContent).toContain('✖Read')
    expect(container.textContent?.match(/NATIVE-CAUSE-A/g)).toHaveLength(1)
    expect(container.textContent?.match(/NATIVE-CAUSE-B/g)).toHaveLength(1)
    await act(async () => { details[0]?.querySelector('summary')?.click() })
    expect(details[0]?.open).toBe(true)
    expect(container.querySelector('.dms-md')?.textContent).toBe('有效部分回复')
  })
  it('QA-05 preserves native disclosure nodes and open state when final text removes preceding blocks (M)', async () => {
    let calls = 0
    const events = [event(1, 'A'), event(2, '公开合成摘要\n详细摘要', 'thinking'),
      { ...event(3, 'Read', 'tool'), detail: '完整参数' }, event(4, 'B'), event(5, '保持折叠的公开摘要', 'thinking')]
    routes(() => {
      calls += 1
      return response({ summary: { ...summary, phase: calls === 1 ? 'running' : 'done' }, events: calls === 1 ? events : [],
        nextCursor: 6, ...(calls === 1 ? {} : { finalText: 'AB+C' }) })
    })
    await mount()
    await expandExecutionGroup()
    const before = [...container.querySelectorAll('details:not([data-execution-process])')]
    expect(before).toHaveLength(3)
    await act(async () => { before[0]?.querySelector('summary')?.click(); before[1]?.querySelector('summary')?.click() })
    expect(before.map(row => row.open)).toEqual([true, true, false])
    const outer = executionGroup()
    await act(async () => { outer.querySelector('summary')?.click() })
    expect(outer.open).toBe(false)
    expect(getComputedStyle(outer.querySelector('.dms-execution-body')!).display).toBe('none')
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(executionGroup()).toBe(outer)
    expect(outer.open).toBe(false)
    await expandExecutionGroup()
    expect(executionGroup()).toBe(outer)
    expect(outer.open).toBe(true)
    const after = [...container.querySelectorAll('details:not([data-execution-process])')]
    expect(after).toHaveLength(3)
    for (let index = 0; index < before.length; index += 1) expect(after[index]).toBe(before[index])
    expect(after.map(row => row.open)).toEqual([true, true, false])
    expect(container.querySelector('.dms-md')?.textContent).toBe('AB+C')
  })
  it('fails closed with no access and never sends a fetch', async () => {
    const mock = routes(() => response({ summary, events: [], nextCursor: 0 }))
    await act(async () => { root.render(<SessionPage taskId="task-a" sessionIds={['owner-a']} />) })
    expect(container.textContent).toContain('缺少当前父会话')
    expect(mock).not.toHaveBeenCalled()
  })
  it('preserves a host Markdown link delegate and externally opens only unhandled HTTP links', async () => {
    routes(() => response({ summary, events: [event(1, 'ready')], nextCursor: 2 }))
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    await mount()
    const stream = container.querySelector('.dms-stream') as HTMLElement
    const handled = document.createElement('a')
    handled.href = 'https://host.example/file-preview'
    handled.textContent = 'host file'
    handled.addEventListener('click', event => { event.preventDefault() })
    stream.append(handled)
    await act(async () => { handled.click() })
    expect(open).not.toHaveBeenCalled()
    const external = document.createElement('a')
    external.href = 'https://example.com/doc'
    external.textContent = 'external'
    stream.append(external)
    await act(async () => { external.click() })
    expect(open).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith('https://example.com/doc', '_blank', 'noopener')
  })
  it('locks duplicate same-render Enter submits synchronously and sends the CLI anchor', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/task/reply')) { calls.push(JSON.parse(String(init?.body))); return response({ id: 'task-b', cli: 'codex' }) }
      return url.includes('cursor=') ? response({ summary, events: [event(1, 'ready')], nextCursor: 2 }) : response({ tasks: [summary] })
    }))
    await mount()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'hello')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ id: 'task-a', text: 'hello' })
    expect(JSON.stringify(calls)).not.toContain(access.token)
  })
})
