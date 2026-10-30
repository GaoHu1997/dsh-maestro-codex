/**
 * 派发上下文注入：CLI 子代理看不到主会话，但它往往只缺一块「现在在哪个分
 * 支、工作区有什么未提交改动」的只读快照。这里在派发前对 cwd 跑一次
 * `git status --porcelain -b`（best effort），把结果折成一小段前缀拼进任务
 * 文本——主代理少写一段，子代理少猜一轮。
 *
 * 解析很保守：只有首行匹配 `## `（porcelain 分支行）才认为输出可信，其他情
 * 况（git 缺失、非仓库、假 spawn 返回垃圾）一律返回 undefined，任务原文照传。
 */

import { runProcess } from './spawn.js'
import type { SpawnFn } from './spawn.js'

/** 上下文块的体积上限（porcelain 行数任意多，这里只看前 40 行）。 */
const MAX_LINES = 40
const MAX_CHARS = 2_000
const GIT_TIMEOUT_MS = 5_000

/** 从 porcelain 输出折出可注入的上下文块；不可信/无内容返回 undefined。 */
export function gitContextBlockOf(statusText: string, cwd: string): string | undefined {
  const lines = statusText.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line !== '')
  // porcelain 的首行必是 `## <branch>`（-b）；不匹配说明这不是我们想要的输出。
  if (!/^## /.test(lines[0] ?? '')) return undefined
  const branch = (lines[0] ?? '').slice(3).trim()
  if (branch === '') return undefined
  const changes = lines.slice(1, 1 + MAX_LINES)
  const body = [
    `分支：${branch}`,
    ...(changes.length === 0 ? ['工作区：干净'] : ['工作区改动：', ...changes]),
  ].join('\n')
  const clipped = body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}…` : body
  return [
    '[CLI 子代理上下文（dsh 自动注入，只读快照）]',
    `工作目录：${cwd}`,
    clipped,
    '[任务描述如下]',
  ].join('\n')
}

/** 一次性跑出上下文块（runProcess 的行回调版，供 runDispatch 直接用）。 */
export async function gitContextFor(cwd: string, spawnFn?: SpawnFn, signal?: AbortSignal): Promise<string | undefined> {
  const chunks: string[] = []
  try {
    const { outcome } = runProcess({
      ...(spawnFn === undefined ? {} : { spawnFn }),
      file: 'git',
      args: ['-C', cwd, 'status', '--porcelain', '-b'],
      timeoutMs: GIT_TIMEOUT_MS,
      signal: signal ?? AbortSignal.timeout(GIT_TIMEOUT_MS + 2_000),
      onStdoutLine: line => { chunks.push(line) },
    })
    const ended = await outcome
    if (ended.timedOut || ended.code !== 0) return undefined
  } catch {
    return undefined
  }
  return gitContextBlockOf(chunks.join('\n'), cwd)
}
