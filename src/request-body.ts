/**
 * HTTP 请求体的读取与拒绝：上限、拒绝语义，以及拒绝时回给客户端什么。
 *
 * 单独成模块的理由是它必须能被真实 `http.Server` 测到：这是「客户端拿到的到底是
 * 一个 4xx 还是一段连接重置」的行为，只用假的 req/res 测不出来。
 *
 * 旧实现超限时先 `req.destroy()` 再 reject，catch 里再往已经销毁的 socket 写响应——
 * 客户端看到的是 `Recv failure: Connection was reset`，既没有状态码也没有文案。
 * 现在的契约：**超限一定回 413 + 可读文案 + `connection: close`**，把剩余上传丢弃
 * 由连接关闭完成，不再冒充 400 参数错误。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Largest accepted request body (bytes) — dispatch payloads are task text. */
export const BODY_LIMIT = 256 * 1024

/** 超限的请求体：不是参数问题，客户端应当看到 413 与可读文案。 */
export class BodyTooLargeError extends Error {
  constructor(readonly limit: number = BODY_LIMIT) {
    super(`请求体超过上限：最多 ${limit} 字节`)
    this.name = 'BodyTooLargeError'
  }
}

/**
 * 读一份 JSON 请求体。空体读作 `{}`（GET/HEAD 与无体 POST 都合法）。
 *
 * 超限时**不销毁请求流**：已经读到的分片丢弃，随后 `req.resume()` 排空剩余上传，
 * 由调用方回 413 并在响应结束后关闭连接。这样超限与「参数非法」是两条不同的路径。
 */
export function readJsonBody(req: IncomingMessage, limit: number = BODY_LIMIT): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = []
    let size = 0
    let overflow = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (overflow || size > limit) {
        // 超限之后不再保留数据，只排空：响应还要写到这个 socket 上。
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (overflow) {
        rejectPromise(new BodyTooLargeError(limit))
        return
      }
      if (chunks.length === 0) {
        resolvePromise({})
        return
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        rejectPromise(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
    req.on('error', rejectPromise)
    req.on('close', () => {
      // 客户端半途断开：没有完整的体就不算读成功。
      if (!req.complete) rejectPromise(new Error('请求体未读完：连接已关闭'))
    })
  })
}

/**
 * 把读体失败翻成 HTTP 响应。超限 = 413 + `connection: close`；其它 = 400 + 原因。
 *
 * 响应结束后才销毁请求流：`connection: close` 让 Node 在写完响应后关闭 socket，
 * 剩余上传由关闭丢弃；先销毁会丢掉刚写出的响应（就是被修掉的那个 bug）。
 */
export function sendBodyFailure(req: IncomingMessage, res: ServerResponse, error: unknown): void {
  const tooLarge = error instanceof BodyTooLargeError
  const message = error instanceof Error ? error.message : String(error)
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }
  if (tooLarge) headers['connection'] = 'close'
  res.writeHead(tooLarge ? 413 : 400, headers)
  res.end(JSON.stringify({ error: message }))
  if (tooLarge) res.once('finish', () => req.destroy())
}
