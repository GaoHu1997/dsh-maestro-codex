import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { CLI_ACCESS_PROJECTION_KEY, type MaestroSessionAccess } from '../wire.js'
import type { BoardSessionList } from './board/data.js'

interface Publisher {
  readonly generation: number
  access: MaestroSessionAccess | undefined
}
interface Selection {
  readonly sessionId: string | undefined
  readonly generation: number
  access: MaestroSessionAccess | undefined
}
let active: MaestroSessionAccess | undefined
let selection: Selection | undefined
let generation = 0
const publishers = new Set<Publisher>()
const listeners = new Set<() => void>()
function sameAccess(left: MaestroSessionAccess | undefined, right: MaestroSessionAccess | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined && left.sessionId === right.sessionId && left.token === right.token)
}
function setActive(access: MaestroSessionAccess | undefined): void {
  // Keep the external-store snapshot stable even when publishers receive equivalent objects.
  if (sameAccess(active, access)) return
  active = access
  for (const listener of listeners) listener()
}
function releasePublisher(publisher: Publisher): void {
  if (!publishers.delete(publisher)) return
  if (selection?.generation === publisher.generation) {
    const current = selection
    const stillOwned = [...publishers].some(other => other.generation === current.generation && sameAccess(other.access, current.access))
    // Never fall back to an older session or a credential superseded by rotation/revocation.
    if (!stillOwned) setActive(undefined)
  }
  // Preserve the selected generation while stale publishers remain mounted,
  // even after its final credential owner disappears.
  if (publishers.size === 0) selection = undefined
}
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const getSnapshot = (): MaestroSessionAccess | undefined => active
const getServerSnapshot = (): undefined => undefined

/** Called only with a session id supplied by a host conversation/header slot, never a resource address. */
export function useCliAccess(list: BoardSessionList, sessionId: string | undefined, publishActive = true): MaestroSessionAccess | undefined {
  const value = sessionId === undefined ? undefined : list.projectionsBySession?.[sessionId]?.values[CLI_ACCESS_PROJECTION_KEY]
  const access = useMemo(() => value != null && value.sessionId === sessionId && typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token) ? value : undefined, [value, sessionId])
  const publisher = useRef<Publisher | undefined>(undefined)
  // Only an explicit host-session/visibility transition creates a new publication.
  // Projection refreshes must not let an old, still-mounted session reclaim selection.
  useLayoutEffect(() => {
    if (!publishActive) return
    if (selection === undefined || selection.sessionId !== sessionId) {
      selection = { sessionId, generation: ++generation, access: undefined }
    }
    const owned: Publisher = { generation: selection.generation, access: undefined }
    publishers.add(owned)
    publisher.current = owned
    return () => {
      if (publisher.current === owned) publisher.current = undefined
      releasePublisher(owned)
    }
  }, [sessionId, publishActive])
  useLayoutEffect(() => {
    const owned = publisher.current
    if (owned === undefined) return
    owned.access = access
    if (selection?.generation !== owned.generation) return
    selection.access = access
    setActive(access)
  }, [access, sessionId, publishActive])
  return access
}
/** Resource tabs borrow the current host-selected parent, not the owner specified in an untrusted URL. */
export function useActiveCliAccess(): MaestroSessionAccess | undefined {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
