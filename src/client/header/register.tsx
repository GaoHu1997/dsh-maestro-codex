/** Maestro owns the unified header cell; native strengths are composed, not substituted. */
import { createElement, type ReactNode } from 'react'
import type { ClientContext } from '../types.js'
import type { BoardHost, BoardSessionList } from '../board/data.js'
import { CliCatalogChip } from './CliCatalogChip.js'

export const HEADER_ACTIONS = 'conversation.session.header.actions'
export const HEADER_FOOTER = `${HEADER_ACTIONS}.subagent.footer`
export const OWN_HEADER_FOOTER = `${HEADER_ACTIONS}.maestro.footer`
const NATIVE_ID = 'subagent-catalog'
const OUR_ID = 'maestro-cli-catalog'
const REGISTRANT = 'dsh-maestro-codex: header catalog'

interface HeaderEntry {
  readonly options?: { readonly id?: string; readonly order?: number; readonly priority?: number; readonly label?: unknown }
  readonly id?: string
  readonly registrant?: string
  readonly component?: unknown
  readonly inject?: unknown
  readonly locale?: string
  readonly children?: Readonly<Record<string, unknown>>
  readonly store?: unknown
}
const entryId = (entry: HeaderEntry): string | undefined => entry.options?.id ?? entry.id
interface HeaderSlots {
  inject(name: string, callback: () => unknown): () => void
  register(options: Record<string, unknown>, component: unknown): unknown
  entries?(name: string): readonly HeaderEntry[]
  entriesOfSlot?(name: string): readonly HeaderEntry[]
  spec?(name: string): { readonly kind?: string } | undefined
  subscribe?(name: string, listener: () => void): () => void
}
interface HeaderProps {
  readonly sessionId?: string
  readonly host?: BoardHost
  readonly useSessions?: (selector: (snapshot: BoardSessionList) => BoardSessionList) => BoardSessionList
  readonly useFooterAvailable?: (selector: (available: boolean) => boolean) => boolean
  readonly useSession?: (selector: (snapshot: { subagent?: unknown }) => boolean) => boolean
  /** Public renderer binds child slots to the current real session scope. */
  readonly renderSlot?: (name: string, props: Record<string, unknown>) => ReactNode
}

export function HeaderCatalogAction(props: HeaderProps): ReactNode {
  const addressedChild = props.useSession?.(snapshot => snapshot.subagent != null) ?? false
  const sessionList = props.useSessions?.(snapshot => snapshot)
  const footerAvailable = props.useFooterAvailable?.(value => value) ?? false
  return createElement(CliCatalogChip, {
    sessionId: props.sessionId, host: props.host, addressedChild, sessionList, footerAvailable,
    renderFooter: props.renderSlot === undefined ? undefined : () => props.renderSlot?.(OWN_HEADER_FOOTER, {}),
  })
}

function hasNativeCell(slots: HeaderSlots): boolean {
  try {
    return slots.entries?.(HEADER_ACTIONS).some(entry => entryId(entry) === NATIVE_ID && entry.registrant !== REGISTRANT) === true
  } catch { return false }
}

function mirrorFooter(slots: HeaderSlots): () => void {
  const mirrors = new Map<HeaderEntry, () => void>()
  let stopped = false
  let warned = false
  const sync = (): void => {
    if (stopped) return
    // Only the effective roster excludes shadowed/abdicated contributors.
    // An old host lacking it keeps the catalog rather than guessing ownership.
    const entries = slots.entriesOfSlot?.(HEADER_FOOTER) ?? []
    const leaves = entries.filter(entry => entryId(entry) !== undefined && entry.component !== undefined
      && entry.store === undefined && Object.keys(entry.children ?? {}).length === 0)
    for (const [entry, dispose] of mirrors) {
      if (!leaves.includes(entry)) { dispose(); mirrors.delete(entry) }
    }
    for (const entry of leaves) {
      if (mirrors.has(entry)) continue
      try {
        const dispose = slots.register({
          name: OWN_HEADER_FOOTER, id: `native:${entryId(entry)}`,
          order: entry.options?.order ?? 0, priority: entry.options?.priority ?? 0,
          registrant: `${REGISTRANT}: footer bridge`,
          ...(entry.inject === undefined ? {} : { inject: entry.inject }),
          ...(entry.locale === undefined ? {} : { locale: entry.locale }),
        }, entry.component)
        if (typeof dispose === 'function') mirrors.set(entry, dispose as () => void)
      } catch {
        if (!warned) { warned = true; console.warn('[dsh-maestro-codex] 协作扩展暂不可用，自有子智能体目录仍可使用。') }
      }
    }
  }
  let unsubscribe: (() => void) | undefined
  const dispose = (): void => {
    if (stopped) return
    stopped = true
    unsubscribe?.()
    for (const release of mirrors.values()) release()
    mirrors.clear()
  }
  try { unsubscribe = slots.subscribe?.(HEADER_FOOTER, sync); sync() }
  catch (error) { dispose(); throw error }
  return dispose
}

function mountHeader(ctx: ClientContext): () => void {
  const slots = ctx.slots as HeaderSlots
  const host: BoardHost = { get: name => ctx.get(name) }
  let headerDispose: (() => void) | undefined
  let headerId: string | undefined
  let stopped = false
  const footerSource = {
    getSnapshot: () => {
      try { return (slots.entriesOfSlot?.(OWN_HEADER_FOOTER).length ?? 0) > 0 }
      catch { return false }
    },
    subscribe: (listener: () => void) => slots.subscribe?.(OWN_HEADER_FOOTER, listener) ?? (() => {}),
  }
  const injectDispose = slots.inject(HEADER_ACTIONS, () => {
    let syncing = false
    let pending = false
    const sync = (): void => {
      if (stopped) return
      if (syncing) { pending = true; return }
      syncing = true
      try {
        do {
          pending = false
          // A single list id shadows the native count, while keeping its separate
          // lineage/composer registrations intact. No global DOM or CSS hiding.
          const id = hasNativeCell(slots) ? NATIVE_ID : OUR_ID
          if (headerId === id) continue
          headerDispose?.()
          headerDispose = undefined
          headerId = undefined
          const dispose = slots.register({
            name: HEADER_ACTIONS, id, order: 11, priority: -100, registrant: REGISTRANT,
            inject: () => ({ host, hooks: { footerAvailable: footerSource } }),
            // We retain the public Team/extension seat and render it inside our
            // own menu. We do not add a second CLI catalog into that footer.
            children: { [OWN_HEADER_FOOTER]: { kind: 'list', scope: 'session' } },
          }, HeaderCatalogAction)
          headerDispose = typeof dispose === 'function' ? dispose as () => void : undefined
          headerId = id
        } while (pending && !stopped)
      } finally { syncing = false }
    }
    let unsubscribe: (() => void) | undefined
    const dispose = (): void => {
      unsubscribe?.()
      headerDispose?.()
      headerDispose = undefined
      headerId = undefined
    }
    try {
      unsubscribe = slots.subscribe?.(HEADER_ACTIONS, sync)
      sync()
    } catch (error) { dispose(); throw error }
    return dispose
  })
  let footerDispose: () => void
  try { footerDispose = slots.inject(OWN_HEADER_FOOTER, () => mirrorFooter(slots)) }
  catch (error) { stopped = true; injectDispose(); throw error }
  return () => {
    if (stopped) return
    stopped = true
    footerDispose()
    injectDispose()
  }
}

interface HeaderOwner { readonly ctx: ClientContext }
interface HeaderLease { readonly owners: HeaderOwner[]; active?: HeaderOwner | undefined; dispose?: (() => void) | undefined }
const LEASE_KEY = Symbol.for('dsh-maestro-codex.header.registration.v2')
type SharedRoot = typeof globalThis & { [LEASE_KEY]?: WeakMap<object, HeaderLease> }

/** Duplicate module copies share one app owner; disposal hands off without duplicates. */
export function registerHeaderCatalog(ctx: ClientContext): void {
  ctx.effect(() => {
    const shared = globalThis as SharedRoot
    const leases = shared[LEASE_KEY] ??= new WeakMap<object, HeaderLease>()
    const key = ctx.root ?? ctx.slots
    let lease = leases.get(key)
    if (lease === undefined) { lease = { owners: [] }; leases.set(key, lease) }
    const current = lease
    const owner: HeaderOwner = { ctx }
    current.owners.push(owner)
    const activate = (): void => {
      const next = current.owners[0]
      if (next === undefined) return
      current.dispose = mountHeader(next.ctx)
      current.active = next
    }
    if (current.active === undefined) {
      try { activate() } catch (error) {
        current.owners.pop()
        if (current.owners.length === 0) leases.delete(key)
        throw error
      }
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const index = current.owners.indexOf(owner)
      if (index !== -1) current.owners.splice(index, 1)
      if (current.active === owner) {
        current.dispose?.()
        current.dispose = undefined
        current.active = undefined
        while (current.owners.length > 0 && current.active === undefined) {
          try { activate() } catch {
            current.owners.shift()
            console.warn('[dsh-maestro-codex] 顶部入口移交失败；已清理该注册，可重新加载插件重试。')
          }
        }
      }
      if (current.owners.length === 0 && leases.get(key) === current) leases.delete(key)
    }
  }, 'maestro-codex: single unified header owner')
}
