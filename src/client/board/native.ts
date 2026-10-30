/** Native process previews/workflow runs through the installed sidebar's read API. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardHost } from './data.js'
import type { SidebarChildLiveView, WorkflowRunView } from './upstream/index.js'

export type BoardNativeLive = Readonly<Record<string, SidebarChildLiveView>>
export interface BoardNativeState {
  readonly live: BoardNativeLive
  readonly runs: readonly WorkflowRunView[]
  readonly refresh: () => void
}
const NO_LIVE: BoardNativeLive = {}
const NO_RUNS: readonly WorkflowRunView[] = []
const LIVE_MS = 3000
const RUNS_MS = 5000

type NativeMethod = 'subagents.live' | 'workflows.list'
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Match original hostRouteUrl: page HTTP base, not the cross-origin stream base. */
export function boardNativeUrl(method: NativeMethod, base: string): string {
  const url = new URL(base)
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return new URL(`sidebar/api/${method}`, url).href
}

/** Missing routes safely disable that poller; transient failures preserve the last view. */
export async function readBoardNative(
  method: NativeMethod, rootSessionId: string, signal: AbortSignal,
): Promise<unknown | undefined> {
  if (typeof document === 'undefined') return undefined
  const response = await fetch(boardNativeUrl(method, document.baseURI), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rootSessionId }), signal,
  })
  if (response.status === 404 || response.status === 405 || response.status === 501) return undefined
  const envelope: unknown = await response.json()
  if (!response.ok || !record(envelope) || envelope['ok'] !== true || !record(envelope['value'])) {
    throw new Error(`Native sidebar API: HTTP ${response.status}`)
  }
  const value = envelope['value'][method === 'subagents.live' ? 'live' : 'runs']
  if (method === 'subagents.live' ? !record(value) : !Array.isArray(value)) {
    throw new Error('Native sidebar API: invalid response')
  }
  return value
}

/** Structural equality keeps freshly serialized, unchanged answers out of React. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
  }
  if (!record(left) || !record(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
}

export interface BoardNativePoll {
  refresh(): void
  dispose(): void
}
/** One in-flight request per feed, including manual refresh; abort on teardown. */
export function startBoardNativePoll(
  task: (signal: AbortSignal) => Promise<boolean | void>, intervalMs: number,
): BoardNativePoll {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let requested = false
  const tick = async (): Promise<void> => {
    if (controller.signal.aborted) return
    if (inFlight) { requested = true; return }
    inFlight = true
    let available: boolean | void = true
    try { available = await task(controller.signal) } catch { /* Retry transient errors silently. */ }
    inFlight = false
    if (controller.signal.aborted) return
    if (requested) { requested = false; void tick() }
    else if (available !== false) timer = setTimeout(() => { timer = undefined; void tick() }, intervalMs)
  }
  void tick()
  return {
    refresh() {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      void tick()
    },
    dispose() {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
      requested = false
    },
  }
}

/**
 * Root-scoped native inputs. No host route or subagent dispatch logic is added.
 * The original sidebar owns these endpoints; absent deployments render nothing.
 * `active` must be the containing tab's visibility. Hidden/unmounted polls abort.
 */
export function useBoardNative(ctx: BoardHost, rootId: string | undefined, active: boolean): BoardNativeState {
  const [snapshot, setSnapshot] = useState<{
    ctx: BoardHost; rootId: string | undefined; live: BoardNativeLive; runs: readonly WorkflowRunView[]
  }>({ ctx, rootId, live: NO_LIVE, runs: NO_RUNS })
  const currentSnapshot = useRef(snapshot)
  currentSnapshot.current = snapshot
  const refreshers = useRef<readonly BoardNativePoll[]>([])
  const refresh = useCallback(() => { for (const poll of refreshers.current) poll.refresh() }, [])
  useEffect(() => {
    const current = currentSnapshot.current
    const published = current.ctx === ctx && current.rootId === rootId
      ? { live: current.live, runs: current.runs } : { live: NO_LIVE, runs: NO_RUNS }
    setSnapshot(current => current.ctx === ctx && current.rootId === rootId
      ? current : { ctx, rootId, ...published })
    if (!active || rootId === undefined || rootId === '') return
    const livePoll = startBoardNativePoll(async signal => {
      const result = await readBoardNative('subagents.live', rootId, signal)
      if (signal.aborted) return false
      if (result === undefined) return false
      const live = result as BoardNativeLive
      if (!sameValue(published.live, live)) {
        published.live = live
        setSnapshot(current => ({ ...current, ctx, rootId, live }))
      }
    }, LIVE_MS)
    const runsPoll = startBoardNativePoll(async signal => {
      const result = await readBoardNative('workflows.list', rootId, signal)
      if (signal.aborted) return false
      if (result === undefined) return false
      const runs = result as readonly WorkflowRunView[]
      if (!sameValue(published.runs, runs)) {
        published.runs = runs
        setSnapshot(current => ({ ...current, ctx, rootId, runs }))
      }
    }, RUNS_MS)
    refreshers.current = [livePoll, runsPoll]
    return () => {
      livePoll.dispose()
      runsPoll.dispose()
      refreshers.current = []
    }
  }, [ctx, rootId, active])
  // Never show the previous root's previews even for the render before effect cleanup.
  const scoped = snapshot.ctx === ctx && snapshot.rootId === rootId
  return { live: scoped ? snapshot.live : NO_LIVE, runs: scoped ? snapshot.runs : NO_RUNS, refresh }
}
