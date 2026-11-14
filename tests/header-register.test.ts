import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '../src/client/types.js'
vi.mock('../src/client/header/CliCatalogChip.js', () => ({ CliCatalogChip: () => null }))
const { registerHeaderCatalog, HeaderCatalogAction, HEADER_ACTIONS, HEADER_FOOTER, OWN_HEADER_FOOTER } = await import('../src/client/header/register.js')

type Entry = {
  name: string; options: { id: string; order?: number; priority?: number }; component: unknown;
  registrant?: string; inject?: unknown; locale?: string; children?: Record<string, unknown>; store?: unknown;
}
function ledger(options: { native?: boolean; footer?: boolean } = {}) {
  const declared = new Set([HEADER_ACTIONS, ...(options.footer ? [HEADER_FOOTER] : [])])
  const native: Entry = { name: HEADER_ACTIONS, options: { id: 'subagent-catalog' }, component: () => null, registrant: 'ui-subagent' }
  const entries: Entry[] = options.native ? [native] : []
  const subscriptions = new Map<string, Set<() => void>>()
  const controllers = new Set<{ name: string; setup: () => unknown; cleanup?: (() => void) | undefined }>()
  let notifications = 0
  let failSubscribe = false
  const notify = (name: string) => {
    if (++notifications > 120) throw new Error('unbounded synchronous registration')
    for (const listener of [...subscriptions.get(name) ?? []]) listener()
  }
  function declaration(name: string, available: boolean) {
    if (available) declared.add(name); else declared.delete(name)
    for (const controller of [...controllers]) {
      if (controller.name !== name) continue
      if (available && controller.cleanup === undefined) {
        const cleanup = controller.setup(); if (typeof cleanup === 'function') controller.cleanup = cleanup as () => void
      } else if (!available) { controller.cleanup?.(); controller.cleanup = undefined }
    }
    notify(name)
  }
  const slots = {
    entries: (name: string) => entries.filter(entry => entry.name === name),
    entriesOfSlot(name: string) {
      const cells = new Map<string, Entry>()
      for (const entry of entries.filter(entry => entry.name === name).sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))) {
        if (!cells.has(entry.options.id)) cells.set(entry.options.id, entry)
      }
      return [...cells.values()]
    },
    spec: (name: string) => declared.has(name) ? { kind: 'list' } : undefined,
    subscribe(name: string, listener: () => void) {
      if (failSubscribe && name === HEADER_ACTIONS) throw new Error('subscribe unavailable')
      const listeners = subscriptions.get(name) ?? new Set<() => void>()
      subscriptions.set(name, listeners); listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    register(value: Record<string, unknown>, component: unknown) {
      const name = value.name as string
      if (!declared.has(name)) throw new Error('undeclared slot')
      const children = value.children as Record<string, unknown> | undefined
      for (const child of Object.keys(children ?? {})) if (declared.has(child)) throw new Error('already declared')
      const { id, priority, order, ...stored } = value
      const entry = { ...stored, name, component, options: { id: id as string, priority: priority as number | undefined, order: order as number | undefined } } as Entry
      entries.push(entry)
      for (const child of Object.keys(children ?? {})) declaration(child, true)
      notify(name)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        const index = entries.indexOf(entry)
        if (index !== -1) entries.splice(index, 1)
        for (const child of Object.keys(children ?? {})) declaration(child, false)
        notify(name)
      }
    },
    inject(name: string, setup: () => unknown) {
      const controller = { name, setup, cleanup: undefined as (() => void) | undefined }
      controllers.add(controller)
      if (declared.has(name)) {
        try { const cleanup = setup(); if (typeof cleanup === 'function') controller.cleanup = cleanup as () => void }
        catch (error) { controllers.delete(controller); throw error }
      }
      return () => { if (controllers.delete(controller)) controller.cleanup?.() }
    },
  }
  return {
    slots, entries, native, declaration,
    failSubscribe(value: boolean) { failSubscribe = value },
    get subscriptions() { return [...subscriptions.values()].reduce((sum, set) => sum + set.size, 0) },
    get controllers() { return controllers.size },
    get header() { return entries.find(entry => entry.name === HEADER_ACTIONS && entry.registrant === 'dsh-maestro-codex: header catalog') },
    get winners() { return slots.entriesOfSlot(HEADER_ACTIONS) },
    get footer() { return slots.entriesOfSlot(OWN_HEADER_FOOTER) },
  }
}
function owner(store: ReturnType<typeof ledger>, root: object = {}) {
  const effects: Array<() => void> = []
  const ctx = { root, slots: store.slots, get: () => undefined, effect(setup: () => unknown) {
    const cleanup = setup(); if (typeof cleanup === 'function') effects.push(cleanup as () => void)
  } } as unknown as ClientContext
  return { ctx, dispose() { for (const cleanup of effects.splice(0).reverse()) cleanup() } }
}

describe('Maestro-owned unified header', () => {
  it.each([false, true])('owns the single native cell with executor-aware UI (footer=%s)', footer => {
    const store = ledger({ native: true, footer }); const scope = owner(store)
    registerHeaderCatalog(scope.ctx)
    expect(store.header?.options.id).toBe('subagent-catalog')
    expect(store.header).not.toHaveProperty('id')
    expect(store.header?.options.priority).toBe(-100)
    expect(store.winners).toEqual([store.header])
    expect(store.entries).toContain(store.native)
    expect(store.header?.children).toEqual({ [OWN_HEADER_FOOTER]: { kind: 'list', scope: 'session' } })
    expect(store.header?.children).not.toHaveProperty(HEADER_FOOTER)
    scope.dispose(); expect(store.entries).toEqual([store.native]); expect(store.controllers).toBe(0)
    expect(store.subscriptions).toBe(0)
  })
  it('keeps its own standalone cell when no native header exists', () => {
    const store = ledger(); const scope = owner(store)
    registerHeaderCatalog(scope.ctx)
    expect(store.header?.options.id).toBe('maestro-cli-catalog')
    scope.dispose(); expect(store.entries).toHaveLength(0)
  })
  it('preserves a late native footer without surrendering the unified count', () => {
    const store = ledger({ native: true }); const scope = owner(store)
    registerHeaderCatalog(scope.ctx)
    const header = store.header
    store.declaration(HEADER_FOOTER, true)
    expect(store.header).toBe(header)
    expect(store.winners).toEqual([header])
    scope.dispose()
  })
  it('mirrors a real leaf contributor through normal registration and disposes it with its source', () => {
    const store = ledger({ native: true, footer: true }); const scope = owner(store)
    const component = vi.fn(() => null), inject = vi.fn(() => ({ business: 'test' }))
    const release = store.slots.register({ name: HEADER_FOOTER, id: 'agent-team', locale: 'agent-team', inject }, component)
    registerHeaderCatalog(scope.ctx)
    expect(store.footer).toHaveLength(1)
    expect(store.footer[0]).toMatchObject({ component, locale: 'agent-team', inject, options: { id: 'native:agent-team' } })
    expect(component).not.toHaveBeenCalled(); expect(inject).not.toHaveBeenCalled()
    release(); expect(store.footer).toHaveLength(0)
    scope.dispose()
  })
  it('uses effective winners instead of resurrecting a shadowed footer', () => {
    const store = ledger({ native: true, footer: true }); const scope = owner(store)
    const loser = () => null, winner = () => null
    store.slots.register({ name: HEADER_FOOTER, id: 'agent-team', priority: 0 }, loser)
    store.slots.register({ name: HEADER_FOOTER, id: 'agent-team', priority: -1 }, winner)
    registerHeaderCatalog(scope.ctx)
    expect(store.footer.map(entry => entry.component)).toEqual([winner])
    scope.dispose()
  })
  it('does not mirror complex child/store owners or replace native registrations', () => {
    const store = ledger({ native: true, footer: true }); const scope = owner(store)
    store.slots.register({ name: HEADER_FOOTER, id: 'complex', children: { 'foreign.child': { kind: 'list' } } }, () => null)
    store.slots.register({ name: HEADER_FOOTER, id: 'store', store: {} }, () => null)
    registerHeaderCatalog(scope.ctx)
    expect(store.footer).toHaveLength(0)
    expect(store.slots.entries(HEADER_FOOTER)).toHaveLength(2)
    scope.dispose()
  })
  it.each(['passive', 'active'] as const)('hands off the %s duplicate without double registration or deleting native ownership', unloading => {
    const store = ledger({ native: true, footer: true }); const root = {}
    const first = owner(store, root), second = owner(store, root)
    registerHeaderCatalog(first.ctx); registerHeaderCatalog(second.ctx)
    expect(store.winners).toHaveLength(1); expect(store.entries).toHaveLength(2)
    ;(unloading === 'passive' ? second : first).dispose()
    expect(store.winners).toHaveLength(1); expect(store.entries).toHaveLength(2)
    ;(unloading === 'passive' ? first : second).dispose()
    expect(store.entries).toEqual([store.native]); expect(store.subscriptions).toBe(0)
  })
  it('shares registration across independent module copies', async () => {
    const store = ledger({ native: true, footer: true }); const root = {}
    const first = owner(store, root), second = owner(store, root)
    registerHeaderCatalog(first.ctx); vi.resetModules()
    const other = await import('../src/client/header/register.js')
    other.registerHeaderCatalog(second.ctx)
    expect(store.winners).toHaveLength(1); expect(store.entries).toHaveLength(2)
    first.dispose(); expect(store.entries).toHaveLength(2)
    second.dispose(); expect(store.entries).toHaveLength(1)
  })
  it('cleans partial subscription failure and supports a fresh activation', () => {
    const store = ledger({ native: true, footer: true }); const root = {}; store.failSubscribe(true)
    expect(() => registerHeaderCatalog(owner(store, root).ctx)).toThrow('subscribe unavailable')
    expect(store.entries).toEqual([store.native]); expect(store.controllers).toBe(0)
    store.failSubscribe(false)
    const scope = owner(store, root); registerHeaderCatalog(scope.ctx); scope.dispose()
    expect(store.entries).toEqual([store.native]); expect(store.subscriptions).toBe(0)
  })
  it('renders footer through its own renderer-bound declaration, not native owner props', () => {
    const renderSlot = vi.fn(() => 'scoped team')
    const element = HeaderCatalogAction({ sessionId: 's1', renderSlot, useFooterAvailable: selector => selector(true) }) as { props: { renderFooter(): unknown } }
    expect(element.props.renderFooter()).toBe('scoped team')
    expect(renderSlot).toHaveBeenCalledExactlyOnceWith(OWN_HEADER_FOOTER, {})
  })
  it('remounts without stale declarations and keeps separate roots independent', () => {
    const store = ledger({ native: true, footer: true }); const root = {}
    for (let i = 0; i < 3; i++) { const scope = owner(store, root); registerHeaderCatalog(scope.ctx); scope.dispose(); scope.dispose() }
    expect(store.entries).toEqual([store.native]); expect(store.subscriptions).toBe(0); expect(store.controllers).toBe(0)
    const other = ledger(); const scope = owner(other); registerHeaderCatalog(scope.ctx)
    expect(other.header).toBeDefined(); scope.dispose()
  })
})
