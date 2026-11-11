import { createServer, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { BODY_LIMIT, BodyTooLargeError, readJsonBody, sendBodyFailure } from '../src/request-body.js'

/**
 * 真实 `http.Server`：这里要测的是**客户端到底拿到什么**（状态码与文案，还是连接重置）。
 * 用假的 req/res 替身只会把 bug 一起测掉——旧实现正是「往已销毁的 socket 写响应」。
 *
 * 服务端接线与 `src/index.ts` 的 route 完全一致：`readJsonBody` 成功就回 200，
 * 失败一律交给 `sendBodyFailure`。
 */
interface Harness { server: Server; url: string; close: () => Promise<void> }

const harnesses: Harness[] = []

async function startHarness(): Promise<Harness> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readJsonBody(req)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ received: body }))
      } catch (error) {
        sendBodyFailure(req, res, error)
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  const harness: Harness = {
    server,
    url: `http://127.0.0.1:${port}/save`,
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())) },
  }
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.close()
})

function post(url: string, body: string | Buffer): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
    const request = fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })
    request.then(async response => resolve({ status: response.status, text: await response.text() }), reject)
  })
}

describe('request body limit', () => {
  it('answers 413 with a readable message instead of resetting the connection', async () => {
    const harness = await startHarness()
    const oversized = Buffer.from(JSON.stringify({ id: 'routingHint', text: 'a'.repeat(BODY_LIMIT + 1024) }), 'utf8')
    expect(oversized.byteLength).toBeGreaterThan(BODY_LIMIT)
    const response = await post(harness.url, oversized)
    // 旧实现：body 超限时先 req.destroy()，客户端拿到 ERR_CONNECTION_RESET，没有状态码。
    expect(response.status).toBe(413)
    expect(response.text).toContain('请求体超过上限')
    expect(response.text).toContain(String(BODY_LIMIT))
  }, 20_000)

  it('still accepts a body under the limit', async () => {
    const harness = await startHarness()
    const response = await post(harness.url, JSON.stringify({ id: 'routingHint', text: 'ok' }))
    expect(response.status).toBe(200)
    expect(JSON.parse(response.text)).toEqual({ received: { id: 'routingHint', text: 'ok' } })
  })

  it('keeps malformed JSON a 400 with the parse reason', async () => {
    const harness = await startHarness()
    const response = await post(harness.url, 'not json')
    expect(response.status).toBe(400)
    expect(response.text).toContain('invalid JSON body')
  })

  it('reads an empty body as {}', async () => {
    const harness = await startHarness()
    const response = await post(harness.url, '')
    expect(response.status).toBe(200)
    expect(JSON.parse(response.text)).toEqual({ received: {} })
  })

  it('answers 413 as soon as the limit is crossed, without waiting for the declared body', async () => {
    const harness = await startHarness()
    const url = new URL(harness.url)
    const socket = connect({ host: '127.0.0.1', port: Number(url.port) })
    const started = Date.now()
    const firstChunk = new Promise<string>((resolve, reject) => {
      let seen = ''
      socket.on('data', chunk => {
        seen += chunk.toString('utf8')
        if (seen.includes('\r\n')) resolve(seen)
      })
      socket.on('error', reject)
      setTimeout(() => reject(new Error(`no response within 1500ms (got ${seen.length} bytes)`)), 1500)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve())
        socket.once('error', reject)
      })
      // 声明 1MB，只发 300KB：旧实现要等满 1MB（或等客户端超时），新实现应在越过 256KB 时就回 413。
      socket.write('POST /save HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\n'
        + `content-length: ${1024 * 1024}\r\n\r\n`)
      socket.write(Buffer.from('a'.repeat(300 * 1024)))
      const response = await firstChunk
      expect(response.startsWith('HTTP/1.1 413')).toBe(true)
      expect(Date.now() - started).toBeLessThan(1500)
    } finally {
      socket.destroy()
    }
  }, 10_000)

  it('names the limit in the error object', () => {
    expect(new BodyTooLargeError().message).toContain(String(BODY_LIMIT))
  })
})
