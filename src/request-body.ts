/**
 * HTTP 请求体的读取与拒绝：上限、拒绝语义，以及拒绝时回给客户端什么。
 *
 * 单独成模块的理由是它必须能被真实 `http.Server` 测到：这是「客户端拿到的到底是
 * 一个 4xx 还是一段连接重置」的行为，只用假的 req/res 测不出来。
 *
 * 旧实现超限时先 `req.destroy()` 再 reject，catch 里再往已经销毁的 socket 写响应——
 * 客户端看到的是 `Recv failure: Connection was reset`，既没有状态码也没有文案。
 * 现在的契约：**首次越过上限就回 413 + 可读文案 + `connection: close`**，不等剩余
 * 上传结束（一个声明 1MB、实际只发 300KB 的请求在 150ms 内就能拿到响应）；剩余上传
 * 由关闭连接丢弃，不冒充 400 参数错误。
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
 * 超限时**立刻**以 `BodyTooLargeError` 失败，不销毁请求流也不等 `end`：调用方回
 * 413 后由 `connection: close` 关闭连接，未读完的上传随关闭丢弃。若在超限之后仍
 * 有数据到达，只丢弃不累积（`on('data')` 保留，避免 socket 背压把进程挂住）。
 */
export function readJsonBody(req: IncomingMessage, limit: number = BODY_LIMIT): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      finish()
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (settled) return
      if (size > limit) {
        chunks.length = 0
        settle(() => rejectPromise(new BodyTooLargeError(limit)))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      settle(() => {
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
    })
    req.on('error', error => settle(() => rejectPromise(error)))
    req.on('close', () => {
      // 客户端把连接关了而体没读完：不留下悬挂的 promise。
      if (!req.complete) settle(() => rejectPromise(new Error('请求体未读完：连接已关闭')))
    })
  })
}

/**
 * 把读体失败翻成 HTTP 响应。超限 = 413 + `connection: close`；其它 = 400 + 原因。
 *
 * 超限时请求体通常还没读完：响应 `finish` 之后才销毁请求流，剩余上传由关闭丢弃。
 * 提前销毁会连刚写出的响应一起丢掉（就是被修掉的那个 bug）。
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
  if (tooLarge) {
    // 响应写完再断请求：否则 RST 会抢在响应前面（真实 curl 已验证：先断则客户端拿不到状态码）。
    if (res.writableFinished) req.destroy()
    else res.once('finish', () => req.destroy())
  }
}
