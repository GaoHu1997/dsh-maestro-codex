import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { DeadlineError } from '../src/deadline.js'
import { fetchCatalog, runShimLoop, type FetchLike, type ShimWritable } from '../src/bridge-shim.js'

const state = { baseUrl: 'http://127.0.0.1:9/plugin/dsh-maestro-codex', token: 'test-token' }

/** A fetch whose promise never settles — the stalled-host shape. */
const neverFetch: FetchLike = () => new Promise<Response>(() => { /* never settles */ })

const okCatalog: FetchLike = async () => new Response(JSON.stringify({
  skills: [],
  tools: [{ name: 'probe', description: '探针', parameters: { type: 'object', properties: {} } }],
}), { status: 200, headers: { 'content-type': 'application/json' } })

describe('bridge shim request budgets', () => {
  it('gives up when the fetch never returns', async () => {
    await expect(fetchCatalog(state, undefined, neverFetch, { timeoutMs: 30 })).rejects.toBeInstanceOf(DeadlineError)
  })

  it('gives up when response headers arrived but the body never finishes', async () => {
    const stuckBody: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: () => new Promise<never>(() => { /* body never finishes */ }),
    }) as unknown as Response
    const error = await fetchCatalog(state, undefined, stuckBody, { timeoutMs: 40 }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(DeadlineError)
    expect((error as Error).message).toContain('dsh_bridge')
  })

  it('rejects with the caller reason when cancelled mid-request', async () => {
    const controller = new AbortController()
    const pending = fetchCatalog(state, undefined, neverFetch, { signal: controller.signal, timeoutMs: 60_000 })
    controller.abort(new Error('派发已取消'))
    await expect(pending).rejects.toThrow('派发已取消')
  })

  it('still treats a malformed JSON body as an empty catalog, not a hang', async () => {
    const badJson: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token') },
    }) as unknown as Response
    await expect(fetchCatalog(state, undefined, badJson, { timeoutMs: 1_000 })).resolves.toEqual({ skills: [], tools: [] })
  })
})

describe('runShimLoop', () => {
  it('answers a request and exits promptly on stdin EOF', async () => {
    const input = new PassThrough()
    const writes: string[] = []
    const output: ShimWritable = { write(chunk: string) { writes.push(chunk); return true } }
    const loop = runShimLoop(state, { input, output, cwd: 'C:/work', fetchImpl: okCatalog })
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
    await vi.waitFor(() => { expect(writes).toHaveLength(1) })
    const started = Date.now()
    input.end()
    await loop
    expect(Date.now() - started).toBeLessThan(500)
    const reply = JSON.parse(writes[0] ?? '{}') as { result?: { tools?: Array<{ name: string }> } }
    expect(reply.result?.tools?.[0]?.name).toBe('probe')
  })

  it('aborts an in-flight request on stdin EOF and returns without waiting for it', async () => {
    const input = new PassThrough()
    const writes: string[] = []
    const output: ShimWritable = { write(chunk: string) { writes.push(chunk); return true } }
    const loop = runShimLoop(state, { input, output, cwd: 'C:/work', fetchImpl: neverFetch })
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
    await new Promise<void>(resolve => { setTimeout(resolve, 50) })
    const started = Date.now()
    input.end()
    await loop
    // The shim's own deadline wrapper honours the EOF abort even though the
    // injected fetch ignores its signal, so shutdown is immediate.
    expect(Date.now() - started).toBeLessThan(500)
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0] ?? '{}')).toMatchObject({ id: 1 })
  })

  it('aborts an in-flight call on notifications/cancelled', async () => {
    const input = new PassThrough()
    const writes: string[] = []
    const output: ShimWritable = { write(chunk: string) { writes.push(chunk); return true } }
    const abortAware: FetchLike = (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
    })
    const loop = runShimLoop(state, { input, output, cwd: 'C:/work', fetchImpl: abortAware })
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'probe', arguments: {} } })}\n`)
    await new Promise<void>(resolve => { setTimeout(resolve, 20) })
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } })}\n`)
    await vi.waitFor(() => { expect(writes).toHaveLength(1) })
    const started = Date.now()
    input.end()
    await loop
    expect(Date.now() - started).toBeLessThan(500)
    const reply = JSON.parse(writes[0] ?? '{}') as { id?: number; result?: { isError?: boolean } }
    expect(reply.id).toBe(7)
    expect(reply.result?.isError).toBe(true)
  })
})
