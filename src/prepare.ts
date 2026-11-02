/**
 * 就绪命令（配置项 `prepareCommand`）：派发前在 cwd 里跑一次，典型用法是
 * `git worktree add`。它只负责把目录准备好，不产出任务结果；失败就是当轮
 * 失败——目录没准备好，跑出来的活也是错的。
 *
 * 与 `spawn.ts` 的关系：这里复用同一个 spawn 接缝与 killTree，所以 Windows
 * 上 `.cmd` shim 的树杀、超时、取消的行为和 CLI 子进程完全一致。
 */

import type { ChildProcess } from 'node:child_process'
import { killTree, systemSpawn, type SpawnFn } from './spawn.js'

/** 输出上限：就绪命令的输出只用来解释失败，不承载结果，保留开头更有用。 */
export const PREPARE_OUTPUT_CAP = 2000

/** 就绪命令默认超时（方案定为 10 分钟：worktree checkout 可能很慢）。 */
export const PREPARE_TIMEOUT_MS = 10 * 60_000

/** `runPrepare` 的输入。`signal` 与 `timeoutMs` 都是可选的。 */
export interface PrepareOptions {
  cwd: string
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
  spawnFn?: SpawnFn | undefined
  platform?: NodeJS.Platform | undefined
}

/** 一次就绪命令的结局。`timedOut` 与 `ok` 互斥。 */
export interface PrepareOutcome {
  ok: boolean
  code: number | null
  timedOut: boolean
  /** stdout + stderr 的开头（已截断，压平成单行由调用方决定）。 */
  output: string
}

/**
 * 命令如何交给系统：Windows 走 `cmd.exe /d /s /c`，其余走 `sh -c`。单独导出
 * 是为了能在测试里断言形态，而不是真的起 shell。
 */
export function prepareInvocation(command: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  return platform === 'win32'
    ? { file: 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { file: 'sh', args: ['-c', command] }
}

/** 追加一段输出，超过上限就丢弃并留一个标记（保留开头）。 */
function appendOutput(current: string, chunk: string): string {
  if (current.length >= PREPARE_OUTPUT_CAP) return current
  const room = PREPARE_OUTPUT_CAP - current.length
  if (chunk.length <= room) return current + chunk
  return `${current}${chunk.slice(0, room)}\n…（输出已截断）`
}

/**
 * 跑一次就绪命令。不抛异常：任何启动失败都折叠成 `ok: false` 的结局，让
 * 调用方用同一条路径报错。
 */
export async function runPrepare(command: string, options: PrepareOptions): Promise<PrepareOutcome> {
  const invocation = prepareInvocation(command, options.platform ?? process.platform)
  const spawnFn = options.spawnFn ?? systemSpawn
  const timeoutMs = options.timeoutMs ?? PREPARE_TIMEOUT_MS
  let child: ChildProcess
  try {
    child = spawnFn(invocation.file, invocation.args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return { ok: false, code: null, timedOut: false, output: error instanceof Error ? error.message : String(error) }
  }
  return await new Promise<PrepareOutcome>(resolve => {
    let settled = false
    let timedOut = false
    let output = ''
    const finish = (outcome: PrepareOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      timedOut = true
      void killTree(child)
    }, timeoutMs)
    const onAbort = (): void => {
      void killTree(child)
    }
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: unknown) => {
      if (typeof chunk === 'string') output = appendOutput(output, chunk)
      else if (chunk instanceof Uint8Array) output = appendOutput(output, Buffer.from(chunk).toString('utf8'))
    })
    child.stderr?.on('data', (chunk: unknown) => {
      if (typeof chunk === 'string') output = appendOutput(output, chunk)
      else if (chunk instanceof Uint8Array) output = appendOutput(output, Buffer.from(chunk).toString('utf8'))
    })
    child.on('error', error => {
      finish({ ok: false, code: null, timedOut: false, output: appendOutput(output, error.message) })
    })
    child.on('close', code => {
      finish({ ok: code === 0 && !timedOut, code, timedOut, output: output.trim() })
    })
  })
}
