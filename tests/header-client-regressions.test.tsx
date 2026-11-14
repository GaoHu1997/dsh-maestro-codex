// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MaestroTaskSummary } from '../src/wire.js'
import { EXECUTOR_BRANDS } from '../src/client/board/accent.js'

const spies = vi.hoisted(() => ({
  native: vi.fn(), resource: vi.fn(), mode: 'continuable', cli: true, catalog: true,
  feed: true, duplicate: false, rootExists: true, live: false, loading: false,
  token: 'a'.repeat(64), error: undefined as string | undefined,
  catalogState: undefined as 'idle' | 'loading' | 'ready' | 'error' | undefined, missingProjection: false,
  customTasks: undefined as MaestroTaskSummary[] | undefined,
  customCatalog: undefined as Array<{ id: string; mode: string; label?: string; createdAt: number }> | undefined,
  team: undefined as { enabled: boolean; tasks: Array<{ status: string }>; failure?: string } | undefined,
  poll: vi.fn(), clock: vi.fn(),
}))
vi.mock('../src/client/board/data.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/client/board/data.js')>()
  const task: MaestroTaskSummary = { id: 'task-1', sessionId: 's1', cli: 'codex', phase: 'done', model: 'm', title: 'CLI original', startedAt: 1, sessionRef: 'ref' }
  const catalogRows = [
    { id: 'local', mode: 'continuable', createdAt: 1 },
    { id: 'cli-task-1', mode: 'continuable', label: 'Native mirror', createdAt: 2 },
    { id: 'task-1', mode: 'external', label: 'Old mirror', createdAt: 3 },
  ]
  const values = { maestroCliAccess: { sessionId: 's1', token: 'a'.repeat(64) }, subagentCatalog: catalogRows }
  const byId = { s1: { id: 's1', displayTitle: 'Parent' }, local: { id: 'local', displayTitle: 'Local agent' } }
  return { ...actual, useSessionList: () => {
    catalogRows[0]!.mode = spies.mode
    const selected = spies.customCatalog ?? (spies.catalog ? spies.cli ? catalogRows : catalogRows.slice(0, 1) : [])
    values.maestroCliAccess.token = spies.token
    return { byId: spies.rootExists ? byId : {}, projectionsBySession: { s1: spies.missingProjection ? undefined : { state: spies.catalogState, values: { ...values, subagentCatalog: selected, agentTeam: spies.team } } } }
  }, useCliTasks: (active: boolean, sessionIds?: readonly string[], access?: unknown) => {
    spies.poll(active, sessionIds, access)
    const current = { ...task, phase: spies.live ? 'running' as const : 'done' as const }
    return { tasks: spies.customTasks ?? (spies.cli && spies.feed ? spies.duplicate ? [current, current, { ...current, id: 'other-task', sessionId: 'other-parent' }] : [current] : []), loading: spies.loading, error: spies.error, refresh: () => {}, cancel: async () => undefined }
  }, useNow: (active: boolean) => { spies.clock(active); return actual.useNow(active) } }
})
const { CliCatalogChip, headerTokenText, ExecutorIcon } = await import('../src/client/header/CliCatalogChip.js')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let container: HTMLDivElement | undefined
async function mount(hasRight: boolean, nativeTab = true, presentation: Partial<ComponentProps<typeof CliCatalogChip>> = {}): Promise<void> {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const host = { get: (key: string) => {
    if (key === 'workspace' || key === 'uiWorkspace') return { openSession: spies.native }
    if (key === 'sessions') return { open: spies.native }
    if (!hasRight) return undefined
    if (key === 'sidebarRightTabs') return { get: (kind: string) => kind === 'maestro-cli-chat' || (nativeTab && kind === 'subagentchat') ? {} : undefined }
    return key === 'sidebarRight' ? { openResource: spies.resource } : undefined
  } }
  await act(async () => root?.render(<CliCatalogChip sessionId="s1" host={host} {...presentation} />))
  await act(async () => container?.querySelector<HTMLButtonElement>('[data-dmc-trigger]')?.click())
}
afterEach(() => {
  act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined
  spies.mode = 'continuable'; spies.cli = true; spies.catalog = true; spies.feed = true
  spies.duplicate = false; spies.rootExists = true; spies.live = false; spies.loading = false
  spies.customTasks = undefined; spies.customCatalog = undefined; spies.team = undefined
  spies.catalogState = undefined; spies.missingProjection = false
  spies.token = 'a'.repeat(64); spies.error = undefined; spies.resource.mockReset()
  vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
const nativeButton = () => [...document.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find(button => button.querySelector('[data-cli-executor="DSH"]') !== null)
const cliButton = () => [...document.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find(button => button.textContent?.includes('CLI original'))
const trigger = () => container?.querySelector<HTMLButtonElement>('[data-dmc-trigger]')
const menu = () => document.querySelector<HTMLElement>('.dmch-menu')
const task = (cli: MaestroTaskSummary['cli'], id: string, phase: MaestroTaskSummary['phase'] = 'done'): MaestroTaskSummary => ({
  id, sessionId: 's1', cli, phase, model: `${cli}-model`, title: `${cli} scoped task`, startedAt: 1,
  endedAt: phase === 'done' ? 2 : undefined, sessionRef: `${cli}-resume`,
  usage: { uncachedInputTokens: 12, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 1 },
})
function fallbackFetch() {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => ({ ok: true, status: 200, json: async () => init?.method === 'POST'
    ? { id: 'task-reply-1' }
    : String(input).includes('cursor=')
      ? { summary: { id: 'task-1', sessionId: 's1', cli: 'codex', phase: 'done', title: 'CLI original', model: 'm', startedAt: 1, sessionRef: 'ref' }, events: [{ seq: 1, at: 1, kind: 'text', text: 'STABLE-FALLBACK-TRANSCRIPT' }], nextCursor: 2 }
      : { tasks: [{ id: 'task-1', sessionId: 's1', cli: 'codex', phase: 'done', title: 'CLI original', model: 'm', startedAt: 1, sessionRef: 'ref' }] } } as Response))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
async function typeDraft(text: string) {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea')
  if (textarea === null) throw new Error('CLI composer is unavailable')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return textarea
}

describe('header client regressions MA-08', () => {
  it('deduplicates native and external mirrors by CLI task identity', async () => {
    await mount(true)
    expect(container?.textContent).toContain('2 个子智能体')
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(2)
    expect(menu()?.textContent).not.toContain('Native mirror')
    expect(document.querySelectorAll('[data-cli-executor="codex"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-cli-executor="DSH"]')).toHaveLength(1)
    expect(cliButton()?.disabled).toBe(false)
  })
  it('uses the plugin chip and menu for DSH-only child sessions', async () => {
    spies.cli = false
    await mount(true)
    expect(trigger()?.textContent).toContain('1 个子智能体')
    expect(menu()).not.toBeNull()
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(1)
    expect(menu()?.textContent).toContain('Local agent')
    expect(menu()?.textContent).not.toContain('CLI original')
  })
  it.each(['continuable', 'one-shot', 'unknown'])('opens a DSH child in the native right tab with its %s address', async mode => {
    spies.mode = mode
    await mount(true)
    await act(async () => nativeButton()?.click())
    expect(spies.resource).toHaveBeenCalledExactlyOnceWith(`dsh-resource://subagentchat/session/local?parent=s1&mode=${mode}`, { kind: 'subagentchat', preferNewPane: true })
    expect(spies.native).not.toHaveBeenCalled()
    expect(menu()).toBeNull()
  })
  it.each([[true, false], [false, true]])('disables DSH when its right-tab seat is absent (%s, %s)', async (hasRight, nativeTab) => {
    await mount(hasRight, nativeTab)
    expect(nativeButton()?.disabled).toBe(true)
    expect(nativeButton()?.title).toContain('右侧')
    await act(async () => nativeButton()?.click())
    expect(spies.native).not.toHaveBeenCalled()
    expect(spies.resource).not.toHaveBeenCalled()
    expect(menu()).not.toBeNull()
  })
  it('retains the menu and explains a failed native open instead of falling back to the main conversation', async () => {
    spies.resource.mockImplementation(() => { throw new Error('right seat unmounted') })
    await mount(true)
    await act(async () => nativeButton()?.click())
    expect(spies.native).not.toHaveBeenCalled()
    expect(spies.resource).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.dmch-menu [role="alert"]')?.textContent).toContain('无法打开')
    expect(menu()).not.toBeNull()
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
    fallbackFetch()
    await mount(false)
    await act(async () => cliButton()?.click())
    expect(spies.native).not.toHaveBeenCalled()
    expect(spies.resource).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('STABLE-FALLBACK-TRANSCRIPT')
    expect(document.body.querySelector('textarea')?.disabled).toBe(false)
  })
  it('renders nullable token buckets as known subtotal or unknown, never zero consumption', () => {
    expect(headerTokenText({ uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null }, { cli: true, usageMeasured: true })).toContain('部分未知')
    expect(headerTokenText({ uncachedInputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }, { cli: true, usageMeasured: true })).toBe('用量未知')
    expect(headerTokenText({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, { cli: true, usageMeasured: true })).toBe('0 tok')
  })
})

describe('Maestro-owned unified catalog on modern hosts', () => {
  it.each([false, true])('keeps the same mixed owned count, querying and active clock despite legacy nativeCatalog=%s', async nativeCatalog => {
    vi.useFakeTimers(); spies.live = true
    await mount(true, true, { nativeCatalog })
    expect(container?.querySelectorAll('[data-dmc-trigger]')).toHaveLength(1)
    expect(trigger()?.textContent).toContain('2 个子智能体')
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(2)
    expect(spies.poll.mock.calls.at(-1)).toMatchObject([true, ['s1'], { sessionId: 's1', token: spies.token }])
    expect(spies.clock).toHaveBeenLastCalledWith(true)
    expect(vi.getTimerCount()).toBe(1)
    expect(document.body.hasAttribute('data-maestro-cli-header')).toBe(false)
    expect(document.querySelector('[data-maestro-core-chip]')).toBeNull()
  })
  it('keeps DSH-only navigation and the DSH icon inside the same owned entry', async () => {
    spies.cli = false
    await mount(true, true, { nativeCatalog: true })
    expect(trigger()?.textContent).toContain('1 个子智能体')
    expect(trigger()?.querySelector('[data-cli-summary="DSH"] [data-cli-icon="DSH"]')).not.toBeNull()
    expect(nativeButton()?.querySelector('[data-cli-icon="DSH"]')).not.toBeNull()
    await act(async () => nativeButton()?.click())
    expect(spies.resource.mock.calls[0]?.[0]).toContain('/session/local?parent=s1')
  })
  it('keeps a CLI-only task in the same n-child entry instead of degrading to a native footer/fallback label', async () => {
    spies.catalog = false
    await mount(true, true, { nativeCatalog: true })
    expect(trigger()?.textContent).toContain('1 个子智能体')
    expect(trigger()?.getAttribute('aria-label')).toContain('Codex 1 个')
    expect(trigger()?.textContent).not.toContain('CLI 任务 (1)')
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(1)
    await act(async () => cliButton()?.click())
    expect(spies.resource.mock.calls[0]?.[0]).toContain('/task/task-1')
  })
  it('renders all Claude/Codex/Grok/DSH explicit icons in the trigger and rows with status, model and measured usage', async () => {
    spies.customTasks = [task('claude', 'task-claude', 'running'), task('codex', 'task-codex'), task('grok', 'task-grok', 'timeout')]
    spies.customCatalog = [{ id: 'local', mode: 'continuable', label: 'DSH scoped task', createdAt: 1 }]
    await mount(true, true, { nativeCatalog: true })
    expect(trigger()?.textContent).toContain('4 个子智能体')
    for (const executor of ['claude', 'codex', 'grok', 'DSH']) {
      const top = trigger()?.querySelector<HTMLElement>(`[data-cli-summary="${executor}"] [data-cli-icon="${executor}"]`)
      const row = menu()?.querySelector<HTMLElement>(`[data-cli-executor="${executor}"] [data-cli-icon="${executor}"]`)
      expect(top).not.toBeNull(); expect(row).not.toBeNull()
      expect(top?.getAttribute('style')).toContain(EXECUTOR_BRANDS[executor]!.mask)
      expect(row?.getAttribute('style')).toContain(EXECUTOR_BRANDS[executor]!.mask)
      expect(row?.getAttribute('role')).toBe('img')
    }
    expect(menu()?.textContent).toContain('运行中')
    expect(menu()?.textContent).toContain('超时')
    expect(menu()?.textContent).toContain('codex-model')
    expect(menu()?.textContent).toContain('20 tok')
    expect(trigger()?.querySelectorAll('[data-cli-summary]')).toHaveLength(4)
  })
  it('uses one owned count for all three CLI executors even without any DSH catalog row', async () => {
    spies.catalog = false
    spies.customTasks = [task('claude', 'task-claude'), task('codex', 'task-codex'), task('grok', 'task-grok')]
    await mount(true, true, { nativeCatalog: true })
    expect(container?.querySelectorAll('[data-dmc-trigger]')).toHaveLength(1)
    expect(trigger()?.textContent).toContain('3 个子智能体')
    expect(menu()?.querySelectorAll('[role="treeitem"]')).toHaveLength(3)
    for (const executor of ['claude', 'codex', 'grok']) {
      expect(trigger()?.querySelector(`[data-cli-summary="${executor}"] [data-cli-icon="${executor}"]`)).not.toBeNull()
      expect(menu()?.querySelector(`[data-cli-executor="${executor}"] [data-cli-icon="${executor}"]`)).not.toBeNull()
    }
    expect(trigger()?.querySelector('[data-cli-summary="DSH"]')).toBeNull()
  })

  it.each(['claude', 'codex', 'grok'] as const)('opens the original %s task resource with its executor identity and no mirror/session token URL', async executor => {
    spies.catalog = false
    spies.customTasks = [task(executor, `task-${executor}`)]
    await mount(true, true, { nativeCatalog: true })
    const row = menu()?.querySelector(`[data-cli-executor="${executor}"]`)?.closest<HTMLButtonElement>('button')
    expect(row?.disabled).toBe(false)
    await act(async () => row?.click())
    expect(spies.native).not.toHaveBeenCalled()
    expect(spies.resource).toHaveBeenCalledTimes(1)
    const address = String(spies.resource.mock.calls[0]?.[0])
    expect(address).toContain(`/task/task-${executor}`)
    expect(address).toContain(`cli=${executor}`)
    expect(address).not.toContain(`cli-task-${executor}`)
    expect(address).not.toContain(spies.token)
  })

  it('deduplicates repeated task/native/external mirrors without admitting a different owner', async () => {
    spies.duplicate = true
    spies.customCatalog = [
      { id: 'local', mode: 'continuable', createdAt: 1 }, { id: 'local', mode: 'continuable', createdAt: 1 },
      { id: 'cli-task-1', mode: 'one-shot', label: 'Native mirror', createdAt: 2 },
      { id: 'task-1', mode: 'external', label: 'Old mirror', createdAt: 3 },
      { id: 'cli-task-1', mode: 'external', label: 'Duplicate mirror', createdAt: 4 },
    ]
    await mount(true, true, { nativeCatalog: true })
    expect(trigger()?.textContent).toContain('2 个子智能体')
    expect(menu()?.querySelectorAll('[role="treeitem"]')).toHaveLength(2)
    for (const text of ['Native mirror', 'Old mirror', 'Duplicate mirror', 'other-task']) expect(menu()?.textContent).not.toContain(text)
  })
  it('preserves a deduplicated orphan CLI mirror without falsely assigning a known brand', async () => {
    spies.feed = false
    await mount(true, true, { nativeCatalog: true })
    expect(trigger()?.textContent).toContain('2 个子智能体')
    expect(menu()?.querySelectorAll('[role="treeitem"]')).toHaveLength(2)
    const orphan = menu()?.querySelector('[data-cli-executor="CLI"]')
    expect(orphan).not.toBeNull()
    expect(orphan?.querySelector('[data-cli-icon]')).toBeNull()
    expect(menu()?.textContent).not.toContain('Old mirror')
    expect(trigger()?.querySelector('[data-cli-summary="codex"]')).toBeNull()
  })
  it('does not fabricate known branding for an unknown executor', async () => {
    spies.catalog = false
    spies.customTasks = [{ ...task('codex', 'task-unknown'), cli: 'future-cli' as MaestroTaskSummary['cli'] }]
    await mount(true)
    expect(trigger()?.textContent).toContain('1 个子智能体')
    expect(menu()?.querySelector('[data-cli-executor="future-cli"]')?.textContent).toContain('future-cli')
    expect(document.querySelectorAll('[data-cli-icon]')).toHaveLength(0)
    expect(trigger()?.querySelectorAll('[data-cli-summary]')).toHaveLength(0)
  })
  it('does not let a direct unknown ExecutorIcon manufacture an image', async () => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root?.render(<ExecutorIcon executor="unknown-brand" />))
    expect(container?.querySelector('[data-cli-icon]')).toBeNull()
    expect(container?.textContent).toBe('')
  })
  it('retains unknown external leaves without counting duplicate IDs twice or inventing an executor', async () => {
    spies.catalog = false; spies.cli = false
    spies.customCatalog = [{ id: 'external-one', mode: 'external', label: 'Other external work', createdAt: 1 }, { id: 'external-one', mode: 'external', label: 'Other external work', createdAt: 1 }]
    await mount(true)
    expect(trigger()?.textContent).toContain('1 个子智能体')
    expect(menu()?.querySelectorAll('[role="treeitem"]')).toHaveLength(1)
    expect(menu()?.querySelector('[role="treeitem"]')?.hasAttribute('disabled')).toBe(true)
    expect(menu()?.querySelector('[data-cli-executor]')).toBeNull()
  })
  it('does not treat missing root list membership as missing authorized CLI tasks', async () => {
    spies.rootExists = false; spies.catalog = false
    await mount(true, true, { nativeCatalog: true })
    expect(trigger()?.textContent).toContain('1 个子智能体')
    expect(menu()?.querySelectorAll('[role="treeitem"]')).toHaveLength(1)
    await act(async () => cliButton()?.click())
    expect(spies.resource).toHaveBeenCalledTimes(1)
  })
  it('reports unavailable authorization instead of claiming zero tasks', async () => {
    spies.catalog = false; spies.feed = false; spies.error = '当前父会话访问权限不可用'
    await mount(true, true, { nativeCatalog: true })
    expect(trigger()?.getAttribute('aria-label')).toBe('子智能体 / 协作')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('访问权限不可用')
    expect(menu()?.textContent).toContain('列表不可用')
    expect(menu()?.textContent).not.toContain('0 个子智能体')
  })
  it('shows loading feedback in the owned trigger and menu without requiring an inline footer', async () => {
    spies.catalog = false; spies.feed = false; spies.loading = true
    await mount(true, true, { nativeCatalog: true })
    expect(trigger()).not.toBeNull()
    expect(trigger()?.textContent).not.toContain('0 个子智能体')
    expect(menu()?.querySelector('[role="status"]')?.textContent).toContain('正在读取')
  })

  it('shows loading feedback in the compatibility inline presentation without filtering out the unified rows', async () => {
    spies.catalog = false; spies.feed = false; spies.loading = true
    await mount(true, true, { inline: true, nativeCatalog: true })
    expect(container?.querySelector('[data-dmc-trigger]')).toBeNull()
    expect(container?.querySelector('[role="status"]')?.textContent).toContain('正在读取')
    expect(container?.textContent).not.toContain('0 个子智能体')
  })
  it('keeps the owned entry visible when DSH catalog fails and the CLI feed is empty', async () => {
    spies.catalog = false; spies.feed = false; spies.catalogState = 'error'
    await mount(true)
    expect(trigger()).not.toBeNull()
    expect(trigger()?.textContent).not.toContain('0 个')
    expect(menu()?.querySelector('[role="alert"]')?.textContent).toContain('DSH 子智能体目录读取失败')
  })
  it('labels mixed rows as known instead of claiming a complete count on catalog failure', async () => {
    spies.catalogState = 'error'
    await mount(true)
    expect(trigger()?.textContent).toContain('2 个已知子智能体')
    expect(menu()?.textContent).toContain('这里只显示已知条目')
    expect(menu()?.querySelector('[data-cli-executor="codex"]')).not.toBeNull()
  })
  it.each(['loading', 'idle', 'missing'] as const)('keeps the owned entry discoverable while the DSH catalog is %s', async state => {
    spies.catalog = false; spies.feed = false
    if (state === 'missing') spies.missingProjection = true
    else spies.catalogState = state
    await mount(true)
    expect(trigger()).not.toBeNull()
    expect(trigger()?.textContent).not.toContain('0 个')
    expect(menu()?.querySelector('[role="status"]')?.textContent).toContain('DSH 子智能体目录')
  })
  it('places Team collaboration content in the owned menu without adding it to the child count', async () => {
    spies.team = { enabled: true, tasks: [{ status: 'active' }, { status: 'deleted' }] }
    const renderFooter = vi.fn(() => <section data-team-footer>TEAM-COLLABORATION</section>)
    await mount(true, true, { footerAvailable: true, renderFooter })
    expect(trigger()?.textContent).toContain('2 个子智能体')
    expect(menu()?.querySelector('[data-team-footer]')?.textContent).toBe('TEAM-COLLABORATION')
    expect(menu()?.querySelectorAll('[role="treeitem"]')).toHaveLength(2)
    const scroll = menu()?.querySelector('.dmch-menu-scroll')
    expect(menu()?.querySelector('[data-team-footer]')?.closest('.dmch-menu-scroll')).toBe(scroll)
    expect(menu()?.querySelector('[role="treeitem"]')?.closest('.dmch-menu-scroll')).toBe(scroll)
    expect(renderFooter).toHaveBeenCalled()
  })
  it('keeps a Team-only menu discoverable without pretending Team tasks are child agents', async () => {
    spies.catalog = false; spies.cli = false
    spies.team = { enabled: true, tasks: [{ status: 'active' }] }
    await mount(true, true, { footerAvailable: true, renderFooter: () => <section data-team-footer>TEAM-ONLY</section> })
    expect(trigger()?.textContent).toContain('子智能体 / 协作')
    expect(trigger()?.textContent).not.toMatch(/[0-9]+ 个子智能体/)
    expect(menu()?.querySelectorAll('[role="treeitem"]')).toHaveLength(0)
    expect(menu()?.textContent).toContain('TEAM-ONLY')
  })
  it('keeps fallback input and transcript after menu close and a new native mirror arrives', async () => {
    fallbackFetch(); spies.catalog = false
    await mount(false, true, { nativeCatalog: true })
    await act(async () => cliButton()?.click())
    const textarea = await typeDraft('retain my pending continuation')
    expect(menu()).toBeNull()
    expect(document.body.textContent).toContain('STABLE-FALLBACK-TRANSCRIPT')
    spies.catalog = true
    await act(async () => root?.render(<CliCatalogChip sessionId="s1" host={{ get: () => undefined }} nativeCatalog />))
    expect(trigger()?.textContent).toContain('2 个子智能体')
    expect(document.body.textContent).toContain('STABLE-FALLBACK-TRANSCRIPT')
    expect(document.querySelector('textarea')).toBe(textarea)
    expect(textarea.value).toBe('retain my pending continuation')
    await act(async () => trigger()?.click())
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(menu()).toBeNull()
    expect(document.querySelector('textarea')).toBe(textarea)
    expect(textarea.value).toBe('retain my pending continuation')
  })
  it.each(['session', 'token'] as const)('clears a fallback transcript and draft when its %s ownership changes', async change => {
    fallbackFetch(); await mount(false)
    await act(async () => cliButton()?.click())
    await typeDraft('must not cross owner')
    if (change === 'token') spies.token = 'b'.repeat(64)
    await act(async () => root?.render(<CliCatalogChip sessionId={change === 'session' ? 's2' : 's1'} host={{ get: () => undefined }} />))
    expect(document.body.textContent).not.toContain('STABLE-FALLBACK-TRANSCRIPT')
    expect(document.querySelector('textarea')).toBeNull()
  })
  it('submits a real CLI continuation request from the retained fallback composer with parent authorization', async () => {
    const fetch = fallbackFetch(); await mount(false)
    await act(async () => cliButton()?.click())
    await typeDraft('continue the original CLI thread')
    const send = document.querySelector<HTMLButtonElement>('[aria-label="发送"]')
    expect(send?.disabled).toBe(false)
    await act(async () => send?.click())
    const request = fetch.mock.calls.find(([input, init]) => String(input).endsWith('/task/reply') && init?.method === 'POST')
    expect(request).toBeDefined()
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ id: 'task-1', text: 'continue the original CLI thread', sessions: ['s1'] })
    expect(new Headers(request?.[1]?.headers).get('x-maestro-session-access')).toBe(spies.token)
  })
  it('has no idle clock and reclaims its active clock across unmount/remount', async () => {
    vi.useFakeTimers()
    await mount(true, true, { nativeCatalog: true })
    expect(spies.clock).toHaveBeenLastCalledWith(false)
    expect(vi.getTimerCount()).toBe(0)
    spies.live = true
    await act(async () => root?.render(<CliCatalogChip sessionId="s1" nativeCatalog />))
    expect(spies.clock).toHaveBeenLastCalledWith(true)
    expect(vi.getTimerCount()).toBe(1)
    act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined
    expect(vi.getTimerCount()).toBe(0)
    await mount(true, true, { nativeCatalog: true })
    expect(vi.getTimerCount()).toBe(1)
    spies.live = false
    await act(async () => root?.render(<CliCatalogChip sessionId="s1" nativeCatalog />))
    expect(trigger()).not.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not mount the owned catalog, poll or start a clock for an addressed child', async () => {
    vi.useFakeTimers(); spies.live = true
    await mount(true, true, { addressedChild: true, nativeCatalog: true })
    expect(trigger()).toBeNull()
    expect(menu()).toBeNull()
    expect(spies.poll.mock.calls.at(-1)?.[0]).toBe(false)
    expect(spies.clock).toHaveBeenLastCalledWith(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
