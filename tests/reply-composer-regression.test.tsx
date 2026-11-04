// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionPage, buildChain } from '../src/client/board/Session.js'
import { CLI_ACCESS_HEADER, type MaestroTaskSummary } from '../src/wire.js'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const original: MaestroTaskSummary = { id: 'ui-original', kind: 'cli', cli: 'claude', sessionId: 'ui-parent', title: 'original', model: 'm', phase: 'done', startedAt: 1, endedAt: 2, sessionRef: 'ui-thread' }
const continued: MaestroTaskSummary = { ...original, id: 'ui-reply', title: 'continued', replyTo: original.id, replySessionIds: ['cli-ui-original'], startedAt: 3, endedAt: 4 }
const access = { sessionId: 'cli-ui-original', token: 'a'.repeat(64) }
const response = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body } as Response)
let root: Root
let container: HTMLDivElement
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
const textarea = () => container.querySelector<HTMLTextAreaElement>('.dms-textarea')!
async function type(text: string) {
 const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
 await act(async () => { setter.call(textarea(), text); textarea().dispatchEvent(new Event('input', { bubbles: true })) })
}

describe('continuation composer remains in the original authenticated child scope', () => {
 it('unlocks after the reply appears in the scoped task list and allows a second send', async () => {
  let sends = 0
  const bodies: Record<string, unknown>[] = []
  const calls: Array<{ url: URL; token: string | null }> = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
   const url = new URL(String(input), 'http://test.invalid')
   calls.push({ url, token: new Headers(init?.headers).get(CLI_ACCESS_HEADER) })
   if (url.pathname.endsWith('/task/reply')) {
    sends++
    bodies.push(JSON.parse(String(init?.body)))
    return response({ id: sends === 1 ? continued.id : 'ui-third', phase: 'queued' })
   }
   const tasks = sends === 0 ? [original] : [original, continued]
   return url.searchParams.has('cursor')
    ? response({ summary: tasks.find(task => task.id === url.searchParams.get('id')) ?? continued, events: [], nextCursor: 0 })
    : response({ tasks })
  })
  vi.stubGlobal('fetch', fetch)
  await act(async () => root.render(<SessionPage taskId={original.id} access={access} sessionIds={[access.sessionId]} place="panel" />))
  await type('first follow-up')
  expect(container.querySelector<HTMLButtonElement>('.dms-send')?.disabled).toBe(false)
  await act(async () => container.querySelector<HTMLButtonElement>('.dms-send')!.click())
  expect(sends).toBe(1)
  expect(textarea().disabled).toBe(true)
  await act(async () => vi.advanceTimersByTimeAsync(2600))
  expect(textarea().disabled).toBe(false)
  expect(container.querySelector('.dms-stop')).toBeNull()
  await type('second follow-up')
  await act(async () => container.querySelector<HTMLButtonElement>('.dms-send')!.click())
  expect(sends).toBe(2)
  expect(bodies[0]?.id).toBe(original.id)
  expect(bodies[1]?.id).toBe(continued.id)
  for (const body of bodies) expect(body.sessions).toEqual([access.sessionId])
  for (const call of calls) expect(call.token).toBe(access.token)
  for (const call of calls.filter(call => call.url.searchParams.has('sessions'))) expect(call.url.searchParams.get('sessions')).toBe(access.sessionId)
 })
 it('uses retained continuation metadata when the originally opened task was pruned', async () => {
  const seen: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
   const url = new URL(String(input), 'http://test.invalid')
   if (url.searchParams.has('cursor')) { seen.push(url.searchParams.get('id') ?? ''); return response({ summary: continued, events: [], nextCursor: 0 }) }
   return response({ tasks: [continued] })
  }))
  await act(async () => root.render(<SessionPage taskId={original.id} access={access} sessionIds={[access.sessionId]} place="panel" />))
  expect(textarea().disabled).toBe(false)
  expect(seen).toContain(continued.id)
  expect(buildChain(original.id, { [continued.id]: continued })).toEqual([continued.id])
 })
 it('does not switch from a pruned selected branch into its sibling', () => {
  const left = { ...continued, id: 'left-last', replyTo: 'left-pruned', replySessionIds: ['cli-ui-original', 'cli-left-pruned'] }
  const right = { ...continued, id: 'right-last', replyTo: 'right-pruned', replySessionIds: ['cli-ui-original', 'cli-right-pruned'], startedAt: 99 }
  expect(buildChain('left-pruned', { [left.id]: left, [right.id]: right })).toEqual([left.id])
 })
})
