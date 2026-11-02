// @vitest-environment jsdom
/** Exercise the real SessionPage and CSS: closed means the whole command list is hidden. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionPage } from '../src/client/board/Session.js'
import type { MaestroTaskDetail, MaestroTaskEvent, MaestroTaskSummary } from '../src/wire.js'

const access = { sessionId: 'process-owner', token: 'd'.repeat(64) }
const summary: MaestroTaskSummary = { id: 'process-task', sessionId: access.sessionId, cli: 'codex', title: 'Synthetic process', phase: 'done', model: 'synthetic', startedAt: 1, sessionRef: 'synthetic-ref' }
const event = (seq: number, text: string, kind: MaestroTaskEvent['kind'] = 'text', detail?: string): MaestroTaskEvent => ({ seq, at: seq, text, kind, ...(detail === undefined ? {} : { detail }) })
const response = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body } as Response)
let root: Root
let container: HTMLDivElement
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => { vi.useFakeTimers(); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function routes(detail: (url: URL) => MaestroTaskDetail, tasks: MaestroTaskSummary[] = [summary]): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { const url = new URL(String(input), 'http://synthetic.invalid'); return response(url.searchParams.has('cursor') ? detail(url) : { tasks }) }))
}
async function mount(taskId = summary.id): Promise<void> { await act(async () => { root.render(<SessionPage taskId={taskId} access={access} sessionIds={[access.sessionId]} place="panel" />) }) }
function group(): HTMLDetailsElement {
  const row = container.querySelector<HTMLDetailsElement>('[data-execution-process]')
  expect(row).not.toBeNull()
  return row!
}
async function toggleGroup(row = group()): Promise<void> { await act(async () => { row.querySelector('summary')?.click() }) }
async function toggleInner(row: Element): Promise<void> { await act(async () => { row.querySelector<HTMLElement>('[data-host-disclosure-title]')?.click() }) }
const innerRows = (row = group()): Element[] => [...row.querySelectorAll('[data-host-disclosure]')]


describe('whole execution process disclosure', () => {
  it('hides dozens of complete command rows, notes and thoughts behind one closed group, not just their bodies', async () => {
    const commands = Array.from({ length: 42 }, (_, index) => event(index + 5, `COMMAND-${index} long command arguments`, 'tool', `arguments\nOUTPUT-${index}`))
    routes(() => ({ summary, finalText: 'VISIBLE FINAL', nextCursor: 50, events: [
      event(1, 'CREATED', 'phase'), event(2, 'BOOTSTRAP', 'note'), event(3, 'THOUGHT HEAD\nTHOUGHT FULL', 'thinking'),
      event(4, 'PROCESS HEAD\nPROCESS FULL'), ...commands, event(47, 'Tool result', 'result', 'RESULT FULL'),
      event(48, 'VISIBLE ERROR', 'error'), event(49, 'VISIBLE FINAL'),
    ] }))
    await mount()
    const process = group()
    expect(container.querySelectorAll('[data-execution-process]')).toHaveLength(1)
    expect(process.open).toBe(false)
    expect(process.querySelector('summary')?.textContent).toContain('思考与执行过程')
    expect(process.querySelector('summary')?.textContent).toContain('47')
    expect(process.querySelector('summary')?.textContent).not.toContain('COMMAND-')
    expect(getComputedStyle(process.querySelector('.dms-execution-body')!).display).toBe('none')
    expect(innerRows()).toHaveLength(44)
    expect(process.textContent).toContain('BOOTSTRAP')
    expect(process.textContent).toContain('COMMAND-41')
    expect(process.textContent).toContain('PROCESS FULL')
    const answer = container.querySelector('.dms-md')!
    const error = container.querySelector('.dms-errline')!
    expect(answer.textContent).toBe('VISIBLE FINAL')
    expect(error.textContent).toContain('VISIBLE ERROR')
    expect(process.contains(answer)).toBe(false)
    expect(process.contains(error)).toBe(false)
    await toggleGroup()
    expect(process.open).toBe(true)
    expect(getComputedStyle(process.querySelector('.dms-execution-body')!).display).toBe('flex')
    const tool = innerRows()[1]!
    await toggleInner(tool)
    expect(tool.querySelector('pre')?.textContent).toBe('arguments\nOUTPUT-0')
  })

  it('preserves the group and inner row instances and open state through close, final reconciliation and reopen', async () => {
    let calls = 0
    const events = [event(1, 'A'), event(2, 'THOUGHT HEAD\nTHOUGHT FULL', 'thinking'), event(3, 'Read', 'tool', 'ARGUMENTS FULL'), event(4, 'B'), event(5, 'SECOND THOUGHT', 'thinking')]
    routes(() => { calls += 1; return { summary: { ...summary, phase: calls === 1 ? 'running' : 'done' }, events: calls === 1 ? events : [], nextCursor: 6, ...(calls === 1 ? {} : { finalText: 'AB+C' }) } }, [{ ...summary, phase: 'running' }])
    await mount()
    const process = group()
    await toggleGroup()
    const before = innerRows()
    await toggleInner(before[0]!)
    await toggleInner(before[1]!)
    expect(before.map(row => row.getAttribute('data-host-disclosure'))).toEqual(['open', 'open', 'closed'])
    await toggleGroup()
    expect(process.open).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(group()).toBe(process)
    expect(process.open).toBe(false)
    const after = innerRows()
    expect(after).toHaveLength(3)
    for (let index = 0; index < before.length; index += 1) expect(after[index]).toBe(before[index])
    expect(after.map(row => row.getAttribute('data-host-disclosure'))).toEqual(['open', 'open', 'closed'])
    const answer = container.querySelector('.dms-md')!
    expect(answer.textContent).toBe('AB+C')
    expect(process.contains(answer)).toBe(false)
    await toggleGroup()
    expect(process.open).toBe(true)
    expect(after[1]?.querySelector('pre')?.textContent).toBe('ARGUMENTS FULL')
  })

  it.each(['failed', 'timeout', 'cancelled', 'interrupted', 'running'] as const)('keeps valid partial replies and error details outside the closed group for %s', async phase => {
    routes(() => ({ summary: { ...summary, phase }, finalText: 'LAST PARTIAL', error: 'Read', nextCursor: 6, events: [
      event(1, 'BOOTSTRAP', 'note'), event(2, 'EARLY PARTIAL'), event(3, 'Read', 'tool', 'COMMAND FULL'),
      event(4, 'Read', 'error', 'ERROR HEAD\nERROR FULL'), event(5, 'LAST PARTIAL'),
    ] }), [{ ...summary, phase }])
    await mount()
    const process = group()
    expect(process.open).toBe(false)
    const answers = [...container.querySelectorAll('.dms-md')]
    expect(answers.map(row => row.textContent)).toEqual(['EARLY PARTIAL', 'LAST PARTIAL'])
    expect(answers.every(row => !process.contains(row))).toBe(true)
    const error = [...container.querySelectorAll('[data-host-disclosure]')].find(row => !process.contains(row))!
    expect(error.textContent).toContain('ERROR HEAD')
    expect(error.closest('[data-execution-process]')).toBeNull()
    await toggleInner(error)
    expect(error.querySelector('pre')?.textContent).toBe('ERROR HEAD\nERROR FULL')
    expect(process.open).toBe(false)
  })

  it('replaces previously injected CSS after a plugin refresh instead of retaining stale collapse rules', async () => {
    const id = 'dsh-maestro-codex-session-styles'
    const existing = document.getElementById(id) ?? document.createElement('style')
    existing.id = id
    existing.textContent = '.dms-execution-body { display: block !important; }'
    if (!existing.parentNode) document.head.appendChild(existing)
    routes(() => ({ summary, events: [event(1, 'Read', 'tool', 'DETAIL')], nextCursor: 2 }))
    await mount()
    expect(document.getElementById(id)).toBe(existing)
    expect(document.querySelectorAll(`#${id}`)).toHaveLength(1)
    expect(existing.textContent).toContain('.dms-execution:not([open])')
    expect(group().open).toBe(false)
    expect(getComputedStyle(group().querySelector('.dms-execution-body')!).display).toBe('none')
  })

  it('does not show an empty group when a turn contains only a final answer', async () => {
    routes(() => ({ summary, events: [], finalText: 'FINAL ONLY', nextCursor: 0 }))
    await mount()
    expect(group().hidden).toBe(true)
    expect(getComputedStyle(group()).display).toBe('none')
    expect(container.querySelector('.dms-md')?.textContent).toBe('FINAL ONLY')
  })

  it('keeps group state local to each reply turn and resets it on a new task', async () => {
    const reply: MaestroTaskSummary = { ...summary, id: 'process-reply', replyTo: summary.id, startedAt: 2 }
    const other: MaestroTaskSummary = { ...summary, id: 'process-other', title: 'Other task', startedAt: 3 }
    routes(url => ({ summary: url.searchParams.get('id') === reply.id ? reply : url.searchParams.get('id') === other.id ? other : summary,
      events: [event(1, 'Read', 'tool', 'SAME DETAIL')], nextCursor: 2 }), [summary, reply, other])
    await mount()
    const groups = [...container.querySelectorAll<HTMLDetailsElement>('[data-execution-process]')]
    expect(groups).toHaveLength(2)
    expect(groups.every(row => !row.open)).toBe(true)
    await toggleGroup(groups[0])
    expect(groups.map(row => row.open)).toEqual([true, false])
    await mount(other.id)
    expect(group()).not.toBe(groups[0])
    expect(group().open).toBe(false)
  })
})
