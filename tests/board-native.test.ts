import { afterEach, describe, expect, it, vi } from 'vitest'
import { boardNativeUrl, readBoardNative, startBoardNativePoll } from '../src/client/board/native.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('native sidebar transport', () => {
  it('retains the page proxy prefix and drops launch query/hash', () => {
    expect(boardNativeUrl('subagents.live', 'https://host/proxy/3080?token=secret#chat'))
      .toBe('https://host/proxy/3080/sidebar/api/subagents.live')
  })
  it('uses the same-origin Electron forwarding scheme', () => {
    expect(boardNativeUrl('workflows.list', 'dsh-app://app/'))
      .toBe('dsh-app://app/sidebar/api/workflows.list')
  })
  it('does no network work during SSR', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await readBoardNative('subagents.live', 'root', new AbortController().signal)).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['subagents.live', 'workflows.list'] as const)('reads the original %s envelope and root payload', async method => {
    vi.stubGlobal('document', { baseURI: 'https://host/prefix/' })
    const value = method === 'subagents.live' ? { root: { text: 'working', running: true } } : []
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, value: { [method === 'subagents.live' ? 'live' : 'runs']: value },
    })))
    vi.stubGlobal('fetch', fetch)
    const signal = new AbortController().signal
    expect(await readBoardNative(method, 'root', signal)).toEqual(value)
    expect(fetch).toHaveBeenCalledWith(`https://host/prefix/sidebar/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootSessionId: 'root' }), signal,
    })
  })
  it.each([404, 405, 501])('safely degrades when the existing route returns %i', async status => {
    vi.stubGlobal('document', { baseURI: 'https://host/' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })))
    expect(await readBoardNative('workflows.list', 'root', new AbortController().signal)).toBeUndefined()
  })
  it('rejects non-envelope responses instead of publishing them', async () => {
    vi.stubGlobal('document', { baseURI: 'https://host/' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ runs: [] }))))
    await expect(readBoardNative('workflows.list', 'root', new AbortController().signal)).rejects.toThrow('Native sidebar API')
  })
})

describe('native poll lifecycle', () => {
  it('self-schedules only after the prior request settles', async () => {
    vi.useFakeTimers()
    const pending = deferred<void>()
    const task = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined)
    const poll = startBoardNativePoll(task, 3000)
    expect(task).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15000)
    expect(task).toHaveBeenCalledTimes(1)
    pending.resolve()
    await vi.advanceTimersByTimeAsync(2999)
    expect(task).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(task).toHaveBeenCalledTimes(2)
    poll.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('coalesces manual refreshes without overlapping requests', async () => {
    vi.useFakeTimers()
    const pending = deferred<void>()
    const task = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined)
    const poll = startBoardNativePoll(task, 5000)
    poll.refresh(); poll.refresh(); poll.refresh()
    expect(task).toHaveBeenCalledTimes(1)
    pending.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    poll.dispose()
  })
  it('aborts hidden/unmounted work and cannot publish or rearm after late settlement', async () => {
    vi.useFakeTimers()
    const pending = deferred<void>()
    const published = vi.fn()
    let signal: AbortSignal | undefined
    const poll = startBoardNativePoll(async current => {
      signal = current
      await pending.promise
      if (!current.aborted) published()
    }, 3000)
    poll.refresh()
    poll.dispose()
    expect(signal?.aborted).toBe(true)
    pending.resolve()
    await vi.advanceTimersByTimeAsync(10000)
    expect(published).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('retries transient failures but stops unsupported feeds until manual refresh', async () => {
    vi.useFakeTimers()
    const task = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(false)
    const poll = startBoardNativePoll(task, 5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(task).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    poll.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(3)
    poll.dispose()
  })
})
