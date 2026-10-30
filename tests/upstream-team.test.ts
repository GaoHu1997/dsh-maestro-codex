import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamBoard } from '../src/client/board/upstream/client/TeamBoard.tsx'
import { TaskWindow } from '../src/client/board/upstream/client/TaskWindow.tsx'
import { attachLocale } from '../src/client/board/upstream/client/locales.ts'
import { api, teamTaskUrl } from '../src/client/board/upstream/client/api.ts'
import type { SidebarTeamTaskView } from '../src/client/board/upstream/context-types.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (original) => {
  const base = await original<Record<string, unknown>>()
  const { createElement: h } = await import('react')
  return { ...base,
    Pill: ({ active, ...p }: Record<string, unknown>) => h('button', { ...p, 'data-active': active }),
    Input: (p: Record<string, unknown>) => h('input', p),
    Menu: ({ anchor }: { anchor: import('react').ReactNode }) => h('div', null, anchor),
    MarkdownDelegateProvider: ({ children }: { children: import('react').ReactNode }) => children,
    MarkdownText: ({ text }: { text: string }) => h('article', null, text),
    IconCheckOutlineRegular: () => null, IconPlusOutlineRegular: () => null, IconTrashOutlineRegular: () => null,
  }
})
vi.mock('../src/client/board/upstream/client/FloatingWindow.tsx', () => ({
  FloatingWindow: ({ children, footer }: { children: import('react').ReactNode; footer: import('react').ReactNode }) => createElement('section', null, children, footer),
}))
const task: SidebarTeamTaskView = { id: 'task-1', revision: 7, subject: 'Review implementation', description: '**Detailed** task', status: 'pending', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] }
beforeEach(() => attachLocale({ getSnapshot: () => ({ active: 'en' }) }))
afterEach(() => { attachLocale(undefined); vi.unstubAllGlobals() })
describe('original team task surfaces', () => {
  it('renders live task rows and excludes tombstones', () => {
    const html = renderToStaticMarkup(createElement(TeamBoard, { rootId: 'root', members: [], tasks: [task, { ...task, id: 'gone', subject: 'Deleted task', status: 'deleted' }], collapsed: false, onToggleCollapsed() {}, onOpenTask() {} }))
    expect(html).toContain('data-team-board')
    expect(html).toContain('Review implementation')
    expect(html).not.toContain('Deleted task')
    expect(html).toContain('aria-haspopup="menu"')
  })
  it('collapses the original strip without rendering task rows', () => {
    const html = renderToStaticMarkup(createElement(TeamBoard, { rootId: 'root', members: [], tasks: [task], collapsed: true, onToggleCollapsed() {}, onOpenTask() {} }))
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Review implementation')
  })
  it('renders original markdown details and the pending claim state', () => {
    const html = renderToStaticMarkup(createElement(TaskWindow, { rootId: 'root', task, members: [], ctx: {}, onClose() {} }))
    expect(html).toContain('data-task-description')
    expect(html).toContain('**Detailed** task')
    expect(html).toContain('Claim')
    expect(html).not.toContain('Confirm delete')
  })
  it('creates with a multiline editor and a disabled blank-subject save', () => {
    const html = renderToStaticMarkup(createElement(TaskWindow, { rootId: 'root', task: undefined, members: [], ctx: {}, onClose() {} }))
    expect(html).toContain('<textarea')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('data-task-description')
  })
})
describe('narrow original team mutation transport', () => {
  it('preserves proxy and Electron page prefixes', () => {
    expect(teamTaskUrl('teams.taskCreate', 'https://host/prefix?token=1#x').href).toBe('https://host/prefix/sidebar/api/teams.taskCreate')
    expect(teamTaskUrl('teams.taskUpdate', 'dsh-app://app/').href).toBe('dsh-app://app/sidebar/api/teams.taskUpdate')
  })
  it('does not invent a non-DOM host request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    expect(await api.teamsTaskCreate('root', { subject: 'x', description: '' })).toMatchObject({ ok: false, code: 'unavailable' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('sends the original root body and revision, preserving conflicts', async () => {
    vi.stubGlobal('document', { baseURI: 'https://host/proxy/' })
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { code: 'team-conflict', message: 'revision changed' } }), { status: 409 }))
    vi.stubGlobal('fetch', fetcher)
    expect(await api.teamsTaskUpdate('root', { taskId: 'task-1', expectedRevision: 7, action: 'reassign' })).toEqual({ ok: false, code: 'team-conflict', message: 'revision changed' })
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://host/proxy/sidebar/api/teams.taskUpdate')
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toEqual({ rootSessionId: 'root', taskId: 'task-1', expectedRevision: 7, action: 'reassign' })
  })
  it('returns committed task values through the original success envelope', async () => {
    vi.stubGlobal('document', { baseURI: 'https://host/' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, value: task }))))
    expect(await api.teamsTaskCreate('root', { subject: task.subject, description: task.description })).toEqual({ ok: true, value: task })
  })
})
