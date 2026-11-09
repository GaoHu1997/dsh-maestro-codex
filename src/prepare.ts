/**
 * 就绪命令（配置项 `prepareCommand`）：派发前在 cwd 里跑一次，典型用法是
 * `git worktree add`。它只负责把目录准备好，不产出任务结果；失败就是当轮
 * 失败——目录没准备好，跑出来的活也是错的。
 *
 * 与 `spawn.ts` 的关系：这里复用同一个 spawn 接缝与 killTree，所以 Windows
 * 上 `.cmd` shim 的树杀、超时、取消的行为和 CLI 子进程完全一致。
 */

import type { ChildProcess } from 'node:child_process'
import { systemSpawn, watchChildClose, type SpawnFn } from './spawn.js'

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
 *
 * Windows 上命令行必须整行包一对引号并以 verbatim 方式传参：Node 的默认
 * argv 转义会把命令里的引号改写成 `\"`，cmd /s 原样转交后，被启动程序的
 * CRT 再吃一层——`node -e "process.exit(3)"` 这类含引号命令的退出码会静默
 * 变成 0，prepare 失败被吞掉。整行包一对引号后，/s 只剥外壳，命令里的
 * 引号原样到达目标程序（与 `launchPlan` 对 `.cmd` 的包装同一配方，已在
 * 真机验证退出码保真）。
 */
export function prepareInvocation(command: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  return platform === 'win32'
    ? { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true }
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
  if (options.signal?.aborted) return { ok: false, code: null, timedOut: false, output: '就绪命令已取消' }
  const invocation = prepareInvocation(command, options.platform ?? process.platform)
  const spawnFn = options.spawnFn ?? systemSpawn
  const timeoutMs = options.timeoutMs ?? PREPARE_TIMEOUT_MS
  let child: ChildProcess
  try {
    child = spawnFn(invocation.file, invocation.args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(invocation.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.windowsVerbatimArguments }),
    })
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
      closer.dispose()
      child.removeListener('exit', onExit)
      options.signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const closer = watchChildClose(child, (code, _signal, forced) => {
      const diagnostic = forced ? '\n[maestro] 未收到子进程 close；已结束等待，进程终止或输出完整性未确认' : ''
      finish({ ok: code === 0 && !timedOut && !options.signal?.aborted, code, timedOut, output: `${output.trim()}${diagnostic}`.trim() })
    })
    const timer = setTimeout(() => {
      timedOut = true
      closer.stop()
    }, timeoutMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      closer.stop()
    }
    const onExit = (): void => { clearTimeout(timer) }
    child.once('exit', onExit)
    child.stdout?.on('data', (chunk: unknown) => {
      if (settled) return
      if (typeof chunk === 'string') output = appendOutput(output, chunk)
      else if (chunk instanceof Uint8Array) output = appendOutput(output, Buffer.from(chunk).toString('utf8'))
    })
    child.stderr?.on('data', (chunk: unknown) => {
      if (settled) return
      if (typeof chunk === 'string') output = appendOutput(output, chunk)
      else if (chunk instanceof Uint8Array) output = appendOutput(output, Buffer.from(chunk).toString('utf8'))
    })
    child.on('error', error => {
      finish({ ok: false, code: null, timedOut, output: appendOutput(output, error.message) })
    })
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
  })
}
