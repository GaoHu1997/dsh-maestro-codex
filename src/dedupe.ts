/**
 * 派发幂等：同一个（父会话、CLI、任务名、工作目录）在窗口内只允许派发一次。
 *
 * 主代理重试一轮工具调用、用户手滑回车两次、看板按钮被连点，都会产生"同一件
 * 事派两遍"——两遍会真的跑起来，扣两次钱、动两次工作区。这里挡在 `create()`
 * 之前：窗口内命中就抛 `DuplicateDispatchError`，什么都不启动。
 *
 * 不学习 dsh-superagent 的 `dedupe_key` 落盘（它对一条 trigger 用唯一键去重），
 * 这里的判断是纯内存的短窗口——重启后允许重派是合理的，重启本身已经过了一段
 * 时间。
 */

/** 默认去重窗口：同一件事十分钟内不重复派发。 */
export const DEDUPE_WINDOW_MS = 10 * 60_000

/** 默认容量：窗口内最多记这么多条，超出淘汰最早的。 */
const DEDUPE_CAP = 200

/** 键的原料：能区分"同一件事"的最小集合。 */
export interface DedupeIdentity {
  readonly parentSessionId?: string | undefined
  readonly cli: string
  readonly taskName: string
  readonly cwd: string
}

/**
 * 派生去重键。显式传了 `explicit` 就以它为准（调用方自己保证唯一性）；
 * 否则由身份四元组拼成——用 U+0000 分隔，避免"a|b"式的键碰撞。
 */
export function dedupeKeyOf(identity: DedupeIdentity, explicit?: string | undefined): string {
  const trimmed = explicit?.trim() ?? ''
  if (trimmed !== '') return `explicit:${trimmed}`
  return ['implicit', identity.parentSessionId ?? '', identity.cli, identity.taskName, identity.cwd].join('\u0000')
}

/** 窗口内重复派发：调用方据此返回可读的错误，而不是静默吞掉。 */
export class DuplicateDispatchError extends Error {
  constructor(readonly key: string, readonly remainingMs: number) {
    super(`同一任务在 ${Math.ceil(remainingMs / 1000)} 秒内已经派发过一次，未重复启动`)
    this.name = 'DuplicateDispatchError'
  }
}

export interface DedupeGuardOptions {
  readonly windowMs?: number | undefined
  readonly now?: (() => number) | undefined
  readonly cap?: number | undefined
}

/** 短窗口幂等表。`claim` 成功即占位，任务开始失败时 `release` 让重试能进来。 */
export class DedupeGuard {
  private readonly claimed = new Map<string, number>()

  constructor(private readonly options: DedupeGuardOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private get windowMs(): number {
    return this.options.windowMs ?? DEDUPE_WINDOW_MS
  }

  /** 占位；窗口内已有同键 → 抛 `DuplicateDispatchError`。 */
  claim(key: string): void {
    this.prune()
    const at = this.now()
    const previous = this.claimed.get(key)
    if (previous !== undefined && at - previous < this.windowMs) {
      throw new DuplicateDispatchError(key, this.windowMs - (at - previous))
    }
    this.claimed.set(key, at)
    this.evict()
  }

  /** 释放占位（派发没能开始的时候调用）。 */
  release(key: string): void {
    this.claimed.delete(key)
  }

  /** 键是否仍在窗口内（诊断/测试用）。 */
  has(key: string): boolean {
    const previous = this.claimed.get(key)
    if (previous === undefined) return false
    return this.now() - previous < this.windowMs
  }

  size(): number {
    this.prune()
    return this.claimed.size
  }

  private prune(): void {
    const at = this.now()
    for (const [key, claimedAt] of this.claimed) {
      if (at - claimedAt >= this.windowMs) this.claimed.delete(key)
    }
  }

  private evict(): void {
    const cap = Math.max(1, this.options.cap ?? DEDUPE_CAP)
    while (this.claimed.size > cap) {
      const oldest = this.claimed.keys().next().value
      if (oldest === undefined) return
      this.claimed.delete(oldest)
    }
  }
}
