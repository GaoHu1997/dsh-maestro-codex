// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MaestroTaskSummary } from '../src/wire.js'
const spies = vi.hoisted(() => ({ native: vi.fn(), resource: vi.fn(), mode: 'continuable' }))
vi.mock('../src/client/board/data.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/client/board/data.js')>()
  const task: MaestroTaskSummary = { id: 'task-1', sessionId: 's1', cli: 'codex', phase: 'done', model: 'm', title: 'CLI original', startedAt: 1, sessionRef: 'ref' }
  const list = { byId: { s1: { id: 's1', displayTitle: 'Parent' }, local: { id: 'local', displayTitle: 'Local agent' } }, projectionsBySession: { s1: { values: {
    maestroCliAccess: { sessionId: 's1', token: 'a'.repeat(64) },
    subagentCatalog: [
      { id: 'local', mode: 'continuable', createdAt: 1 },
      { id: 'cli-task-1', mode: 'continuable', label: 'Native mirror', createdAt: 2 },
      { id: 'task-1', mode: 'external', label: 'Old mirror', createdAt: 3 },
    ],
  } } } }
  return { ...actual, useSessionList: () => {
    const native = list.projectionsBySession.s1.values.subagentCatalog[0]
    if (native !== undefined) native.mode = spies.mode
    return list
  }, useCliTasks: () => ({ tasks: [task], loading: false, error: undefined, refresh: () => {}, cancel: async () => undefined }), useNow: () => 100 }
})
const { CliCatalogChip, headerTokenText } = await import('../src/client/header/CliCatalogChip.js')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let container: HTMLDivElement | undefined
async function mount(hasRight: boolean, nativeTab = true): Promise<void> {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const host = { get: (key: string) => {
    if (key === 'workspace' || key === 'uiWorkspace') return { openSession: spies.native }
    if (key === 'sessions') return { open: spies.native }
    if (!hasRight) return undefined
    if (key === 'sidebarRightTabs') return { get: (kind: string) => kind === 'maestro-cli-chat' || (nativeTab && kind === 'subagentchat') ? {} : undefined }
    return key === 'sidebarRight' ? { openResource: spies.resource } : undefined
  } }
  await act(async () => root?.render(<CliCatalogChip sessionId="s1" host={host} />))
  await act(async () => container?.querySelector<HTMLButtonElement>('[data-dmc-trigger]')?.click())
}
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; spies.mode = 'continuable'; spies.resource.mockReset(); vi.clearAllMocks(); vi.unstubAllGlobals() })
const nativeButton = () => [...document.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find(button => button.querySelector('[data-cli-executor="DSH"]') !== null)
const cliButton = () => [...document.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find(button => button.textContent?.includes('CLI original'))

describe('header client regressions MA-08', () => {
  it('deduplicates native and external mirrors by CLI task identity', async () => {
    await mount(true)
    expect(container?.textContent).toContain('2 个子智能体')
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(2)
    expect(document.querySelector('.dmch-menu')?.textContent).not.toContain('Native mirror')
    expect(document.querySelectorAll('[data-cli-executor="codex"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-cli-executor="DSH"]')).toHaveLength(1)
    expect(cliButton()?.disabled).toBe(false)
  })
  it.each(['continuable', 'one-shot', 'unknown'])('opens a DSH child in the native right tab with its %s address', async mode => {
    spies.mode = mode
    await mount(true)
    await act(async () => nativeButton()?.click())
    expect(spies.resource).toHaveBeenCalledExactlyOnceWith(`dsh-resource://subagentchat/session/local?parent=s1&mode=${mode}`, { kind: 'subagentchat', preferNewPane: true })
    expect(spies.native).not.toHaveBeenCalled()
    expect(document.querySelector('.dmch-menu')).toBeNull()
  })
  it.each([[true, false], [false, true]])('disables DSH when its right-tab seat is absent (%s, %s)', async (hasRight, nativeTab) => {
    await mount(hasRight, nativeTab)
    expect(nativeButton()?.disabled).toBe(true)
    expect(nativeButton()?.title).toContain('右侧')
    await act(async () => nativeButton()?.click())
    expect(spies.native).not.toHaveBeenCalled()
    expect(spies.resource).not.toHaveBeenCalled()
    expect(document.querySelector('.dmch-menu')).not.toBeNull()
  })
  it('retains the menu and explains a failed native open instead of falling back to the main conversation', async () => {
    spies.resource.mockImplementation(() => { throw new Error('right seat unmounted') })
    await mount(true)
    await act(async () => nativeButton()?.click())
    expect(spies.native).not.toHaveBeenCalled()
    expect(spies.resource).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.dmch-menu [role="alert"]')?.textContent).toContain('无法打开')
    expect(document.querySelector('.dmch-menu')).not.toBeNull()
  })
  it('opens the exact CLI resource, never the native mirror reply target', async () => {
    await mount(true)
    await act(async () => cliButton()?.click())
    expect(spies.native).not.toHaveBeenCalled()
    expect(spies.resource).toHaveBeenCalledTimes(1)
    const address = spies.resource.mock.calls[0]?.[0] as string
    expect(address).toContain('/task/task-1')
    expect(address).toContain('cli=codex')
    expect(address).not.toContain('cli-task-1')
    expect(address).not.toContain('a'.repeat(64))
  })
  it('provides a basic CLI transcript and composer overlay when right-column dependency is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => ({ ok: true, status: 200, json: async () => String(input).includes('cursor=') ? { summary: { id: 'task-1', sessionId: 's1', cli: 'codex', phase: 'done', title: 'CLI original', model: 'm', startedAt: 1, sessionRef: 'ref' }, events: [{ seq: 1, at: 1, kind: 'text', text: 'FALLBACK-TRANSCRIPT' }], nextCursor: 2 } : { tasks: [{ id: 'task-1', sessionId: 's1', cli: 'codex', phase: 'done', title: 'CLI original', model: 'm', startedAt: 1, sessionRef: 'ref' }] } } as Response)))
    await mount(false)
    await act(async () => cliButton()?.click())
    expect(spies.native).not.toHaveBeenCalled()
    expect(spies.resource).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('FALLBACK-TRANSCRIPT')
    expect(document.body.querySelector('textarea')?.disabled).toBe(false)
  })
  it('renders nullable token buckets as known subtotal or unknown, never zero consumption', () => {
    expect(headerTokenText({ uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null }, { cli: true, usageMeasured: true })).toContain('部分未知')
    expect(headerTokenText({ uncachedInputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }, { cli: true, usageMeasured: true })).toBe('用量未知')
    expect(headerTokenText({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, { cli: true, usageMeasured: true })).toBe('0 tok')
  })
})
