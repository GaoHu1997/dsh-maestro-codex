// @vitest-environment jsdom
/** QA-04/05：挂载真实 SessionPage，只有 HTTP 与宿主 UI primitives 使用替身。
 * 证据级别 M；不证明真实浏览器排版/滚动，也不启动 CLI。thinking 仅含合成公开摘要。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionPage } from '../src/client/board/Session.js'
import { claudeToolResultEvents } from '../src/channels/claude.js'
import type { MaestroTaskDetail, MaestroTaskEvent, MaestroTaskSummary } from '../src/wire.js'

const access = { sessionId: 'qa-session-owner', token: 'c'.repeat(64) }
const summary: MaestroTaskSummary = {
  id: 'qa-task-a', sessionId: access.sessionId, cli: 'claude', title: 'Synthetic UI acceptance',
  phase: 'done', model: 'synthetic', startedAt: 1, sessionRef: 'synthetic-ref',
}
const event = (seq: number, text: string, kind: MaestroTaskEvent['kind'] = 'text', detail?: string): MaestroTaskEvent => (
  { seq, at: seq, text, kind, ...(detail === undefined ? {} : { detail }) }
)
const response = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body } as Response)
let root: Root
let container: HTMLDivElement
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => {
  vi.useFakeTimers()
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
function routes(detail: (url: URL) => MaestroTaskDetail, tasks: MaestroTaskSummary[] = [summary]): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://synthetic.invalid')
    return response(url.searchParams.has('cursor') ? detail(url) : { tasks })
  }))
}
async function mount(taskId = summary.id): Promise<void> {
  await act(async () => { root.render(<SessionPage taskId={taskId} access={access} sessionIds={[access.sessionId]} place="panel" />) })
}
const disclosureRows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-host-disclosure]')].filter(row => row.closest('[data-process-text]') === null)
const processRows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-process-text]')]
const executionGroups = (): HTMLDetailsElement[] => [...container.querySelectorAll<HTMLDetailsElement>('[data-execution-process]')]
async function expandExecutionGroup(group = executionGroups()[0]): Promise<void> {
  expect(group).toBeDefined()
  if (!group!.open) await act(async () => { group?.querySelector('summary')?.click() })
  expect(group!.open).toBe(true)
}
async function toggle(row: HTMLElement): Promise<void> {
  const title = row.querySelector<HTMLElement>('[data-host-disclosure-title]')
  expect(title).not.toBeNull()
  await act(async () => { title?.click() })
}
async function poll(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(900) })
}
const answerBodies = (): (string | null)[] => [...container.querySelectorAll('.dms-md')].map(element => element.textContent)

describe('QA-04: visible and deduplicated tool error details (M)', () => {
  it('keeps the production Claude is_error cause collapsed by default and readable in full on expansion', async () => {
    const diagnostic = 'SYNTHETIC_PERMISSION_DENIED\n仅合成路径：fixture/中文 文件.txt\n<unsafe-tag>not markup</unsafe-tag>\nDETAIL-END'
    const channel = claudeToolResultEvents({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'qa-use-1', is_error: true, content: diagnostic },
    ] } }, new Map([['qa-use-1', 'Read']]))
    expect(channel).toHaveLength(1)
    expect(channel[0]).toMatchObject({ kind: 'error', detail: diagnostic })
    routes(() => ({
      summary: { ...summary, phase: 'failed' },
      events: channel.map((row, index) => ({ ...row, seq: index + 1, at: index + 1 })), nextCursor: 2,
    }))
    await mount()
    const rows = disclosureRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.getAttribute('data-host-disclosure')).toBe('closed')
    expect(rows[0]?.textContent).toContain('Read（工具失败')
    expect(rows[0]?.textContent).toContain('SYNTHETIC_PERMISSION_DENIED')
    expect(container.querySelector('.dms-tooldetail')).toBeNull()
    expect(container.textContent).not.toContain('DETAIL-END')
    await toggle(rows[0]!)
    expect(container.querySelector('.dms-tooldetail')?.textContent).toBe(diagnostic)
    expect(container.querySelector('unsafe-tag')).toBeNull()
    expect(rows[0]?.querySelector('[aria-label="工具失败"]')).not.toBeNull()
  })

  it('deduplicates only identical text/detail errors and terminal metadata without losing distinct reasons or partial text', async () => {
    const reasonA = '同一工具失败\nSYNTHETIC-CAUSE-A'
    const reasonB = '同一工具失败\nSYNTHETIC-CAUSE-B'
    routes(() => ({
      summary: { ...summary, phase: 'failed' }, error: reasonA, finalText: '有效的部分回复', nextCursor: 6,
      events: [event(1, '有效的部分回复'), event(2, 'Read', 'error', reasonA),
        event(3, 'Read', 'error', reasonA), event(4, 'Read', 'error', reasonB), event(5, 'OTHER-ERROR', 'error')],
    }))
    await mount()
    const rows = disclosureRows()
    expect(rows).toHaveLength(2)
    expect(container.textContent).not.toContain('SYNTHETIC-CAUSE-A')
    for (const row of rows) await toggle(row)
    expect([...container.querySelectorAll('.dms-tooldetail')].map(element => element.textContent)).toEqual([reasonA, reasonB])
    expect(container.textContent?.match(/SYNTHETIC-CAUSE-A/g)).toHaveLength(1)
    expect(container.textContent?.match(/SYNTHETIC-CAUSE-B/g)).toHaveLength(1)
    expect(container.textContent?.match(/OTHER-ERROR/g)).toHaveLength(1)
    expect(answerBodies()).toEqual(['有效的部分回复'])
  })

  it('leaves errors without meaningful detail readable and does not add an empty disclosure', async () => {
    routes(() => ({
      summary: { ...summary, phase: 'failed' }, error: 'BARE-ERROR', nextCursor: 4,
      events: [event(1, 'BARE-ERROR', 'error'), event(2, 'BARE-ERROR', 'error', ''), event(3, 'BARE-ERROR', 'error', '  ')],
    }))
    await mount()
    expect(disclosureRows()).toHaveLength(0)
    expect(container.querySelector('.dms-errline')?.textContent).toBe('✖BARE-ERROR')
    expect(container.textContent?.match(/BARE-ERROR/g)).toHaveLength(1)
  })
})

describe('QA-05: stable disclosure identity through stream reconciliation (M)', () => {
  it.each([
    { name: 'same', finalText: 'ABC共同', expected: ['A', 'B', 'C共同'], processes: 0 },
    { name: 'overlap', finalText: '共同末尾', expected: ['C共同末尾'], processes: 2 },
    { name: 'full snapshot extension', finalText: 'ABC共同\n新增结论', expected: ['ABC共同\n新增结论'], processes: 0 },
    { name: 'last-block extension', finalText: 'C共同\n新增结论', expected: ['C共同\n新增结论'], processes: 2 },
    { name: 'independent addition', finalText: '独立结论', expected: ['C共同', '独立结论'], processes: 2 },
  ])('retains open and closed thinking/tool nodes for a $name final', async ({ finalText, expected, processes }) => {
    let calls = 0
    const publicSummary = '相同的合成公开摘要\n非隐藏推理内容'
    const events = [event(1, 'A'), event(2, publicSummary, 'thinking'), event(3, 'Read', 'tool', '参数\n完整参数'),
      event(4, 'B'), event(5, publicSummary, 'thinking'), event(6, 'Read result', 'result', '结果\n完整结果'), event(7, 'C共同')]
    routes(() => {
      calls += 1
      return { summary: { ...summary, phase: calls === 1 ? 'running' : 'done' },
        events: calls === 1 ? events : [], nextCursor: 8, ...(calls === 1 ? {} : { finalText }) }
    })
    await mount()
    const execution = executionGroups()[0]!
    expect(execution.open).toBe(false)
    await expandExecutionGroup(execution)
    const before = disclosureRows()
    expect(before).toHaveLength(4)
    expect(before.map(row => row.getAttribute('data-host-disclosure'))).toEqual(['closed', 'closed', 'closed', 'closed'])
    for (const index of [0, 1, 3]) await toggle(before[index]!)
    await poll()
    expect(calls).toBe(2)
    expect(executionGroups()[0]).toBe(execution)
    expect(execution.open).toBe(true)
    const after = disclosureRows()
    expect(after).toHaveLength(4)
    for (let index = 0; index < before.length; index += 1) expect(after[index]).toBe(before[index])
    expect(after.map(row => row.getAttribute('data-host-disclosure'))).toEqual(['open', 'open', 'closed', 'open'])
    expect(answerBodies()).toEqual(expected)
    expect(processRows()).toHaveLength(processes)
    expect(processRows().every(row => row.closest('[data-execution-process]') === execution)).toBe(true)
  })

  it('keeps an expanded thinking node when adjacent public summary frames arrive', async () => {
    let calls = 0
    routes(() => {
      calls += 1
      return { summary: { ...summary, phase: calls === 1 ? 'running' : 'done' }, nextCursor: calls + 10,
        events: [event(calls + 9, calls === 1 ? '公开摘要一' : '公开摘要二', 'thinking')] }
    })
    await mount()
    await expandExecutionGroup()
    const before = disclosureRows()[0]!
    await toggle(before)
    await poll()
    expect(disclosureRows()[0]).toBe(before)
    expect(before.getAttribute('data-host-disclosure')).toBe('open')
    expect(before.querySelector('[data-host-markdown="compact"]')?.textContent).toBe('公开摘要一\n\n公开摘要二')
  })

  it('isolates disclosure state between reply turns that reuse the same event sequence', async () => {
    const reply = { ...summary, id: 'qa-task-reply', replyTo: summary.id, startedAt: 2 }
    routes(url => ({ summary: url.searchParams.get('id') === reply.id ? reply : summary,
      events: [event(1, '相同的公开摘要', 'thinking')], nextCursor: 2 }), [summary, reply])
    await mount()
    expect(executionGroups().every(group => !group.open)).toBe(true)
    for (const group of executionGroups()) await expandExecutionGroup(group)
    const rows = disclosureRows()
    expect(rows).toHaveLength(2)
    await toggle(rows[0]!)
    expect(rows.map(row => row.getAttribute('data-host-disclosure'))).toEqual(['open', 'closed'])
    await toggle(rows[1]!)
    await toggle(rows[0]!)
    expect(rows.map(row => row.getAttribute('data-host-disclosure'))).toEqual(['closed', 'open'])
  })

  it('starts collapsed after changing tasks even when the new task reuses the same seq and summary', async () => {
    const other = { ...summary, id: 'qa-task-b', title: 'Different synthetic task' }
    routes(url => ({ summary: url.searchParams.get('id') === other.id ? other : summary,
      events: [event(1, '相同的公开摘要', 'thinking')], nextCursor: 2 }), [summary, other])
    await mount()
    await expandExecutionGroup()
    const before = disclosureRows()[0]!
    await toggle(before)
    expect(before.getAttribute('data-host-disclosure')).toBe('open')
    const originalGroup = executionGroups()[0]!
    await mount(other.id)
    expect(executionGroups()[0]).not.toBe(originalGroup)
    expect(executionGroups()[0]?.open).toBe(false)
    await expandExecutionGroup()
    const after = disclosureRows()[0]!
    expect(after).not.toBe(before)
    expect(after.getAttribute('data-host-disclosure')).toBe('closed')
    expect(container.querySelector('.dms-bubble-user')?.textContent).toBe(other.title)
  })
})
