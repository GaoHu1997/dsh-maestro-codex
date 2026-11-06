/**
 * 持久化副作用队列：每条记录是一件"启动它的进程死了也必须留下痕迹"的外部工作。
 *
 * 本插件的 dispatch 是同步的：宿主进程被杀、机器重启，正在跑的 CLI 任务就只剩
 * 一个空壳——内存里的 registry 没了，磁盘上也没有"它还没结算"的凭据。这里的
 * 队列补上那一格：派发开始时落一行，结算时删一行；启动时残留的行就是"上次没走
 * 完"的证据，转成人能处理的 `interrupted` 任务（见 `scripts` 之外的 recovery）。
 *
 * 与 dsh-superagent 的 `src/app/effects.ts` 同构的部分：行按 (kind, key) 唯一、
 * 失败计数与指数退避、连续失败到阈值才升级成健康错误、关闭时保留未完成的行。
 * 不同的部分：那边是 SQLite 表 + 异步 drain，这里是单个 JSON 文件 + 显式 API，
 * 因为本插件的行数只有"并发派发数"那么多，一条 rename 就能原子落盘。
 *
 * 队列不管"谁来做"：`pending()` 只回答"现在允许做哪些"，消费者（恢复逻辑或将来
 * 的投递逻辑）做完调 `settle()`/`fail()`。没有消费者时它仍然是一本可靠的账。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 队列文件的格式版本；只增不减，读到更高版本的文件按空队列处理并告警。 */
export const EFFECTS_VERSION = 1

/** 连续失败到这一次数才升级为健康错误（单次失败只是噪音）。 */
export const FAILURES_BEFORE_ERROR = 3

/**
 * 被"现在没有位置"拒绝时抛出的信号：不是错误，是稍后再来。
 *
 * 与普通 `Error` 分开，是为了让调用方不必解析文案——`Later` 不写健康错误，
 * 不计失败次数。
 */
export class Later extends Error {
  constructor(message = '稍后再试：当前没有可用位置') {
    super(message)
    this.name = 'Later'
  }
}

export type EffectKind = 'launch'

export interface EffectSpec {
  /** 同一 kind 同时允许在途的行数。 */
  readonly limit: number
  /** 退避区间（毫秒）：`[首次延迟, 上限]`。 */
  readonly retry: readonly [number, number]
  /** 有序 kind 一次只放一条，后面的行必须等前面的结算。 */
  readonly ordered: boolean
}

/**
 * 各 kind 的调度参数。`launch` 是"启动一次 CLI 派发"：重启后恢复它是危险的
 * 外部动作，所以既限制在途数，也用长退避把反复失败压成低频重试。
 */
export const EFFECT_SPECS: Record<EffectKind, EffectSpec> = {
  launch: { limit: 4, retry: [5_000, 300_000], ordered: false },
}

/**
 * 指数退避：第 1 次失败后等 `first`，之后每次翻倍，封顶 `max`。
 *
 * `attempts` 是已经失败的次数（≥1）；指数减去 1 才是"首次按初始间隔等"。
 */
export function backoffOf(spec: EffectSpec, attempts: number): number {
  const exponent = Math.min(Math.max(0, Math.trunc(attempts) - 1), 16)
  return Math.min(spec.retry[1], spec.retry[0] * 2 ** exponent)
}

/** 一行副作用。`value` 是 kind 自己的数据（launch 存的是派发参数）。 */
export interface EffectRow {
  readonly kind: EffectKind
  readonly key: string
  value: Record<string, unknown>
  /** 入队序号：有序 kind 按它判断谁在前面。 */
  seq: number
  /** 每次重新入队 +1；结算时带 generation，防止旧的在途回调删掉新行。 */
  generation: number
  attempts: number
  /** 下次允许尝试的时刻。 */
  due: number
  /** 首次入队时刻。 */
  since: number
  error?: string | undefined
}

interface EffectsFile {
  version: number
  rows: EffectRow[]
}

export interface EffectQueueOptions {
  /** 队列文件路径；省略 = 纯内存（测试与未配置持久化的宿主）。 */
  readonly file?: string | undefined
  readonly now?: (() => number) | undefined
  /** 某行连续失败到阈值时调用（接健康面板）。 */
  readonly onGiveUp?: ((row: EffectRow) => void) | undefined
  readonly onWarn?: ((message: string) => void) | undefined
}

/**
 * 副作用队列。所有写操作都是"先改内存再落盘"，落盘失败只告警不抛：
 * 队列丢一行比让派发失败更糟，但同样不该让进程倒下。
 */
export class EffectQueue {
  private readonly rows = new Map<string, EffectRow>()
  private seq = 0
  private writing: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly options: EffectQueueOptions = {}) {}

  /** 读回磁盘上的行；文件缺失/损坏都按空队列处理（历史是尽力而为）。 */
  async load(): Promise<void> {
    const file = this.options.file
    if (file === undefined) return
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.options.onWarn?.(`副作用队列文件无法解析，按空队列启动：${file}`)
      return
    }
    const version = (parsed as { version?: unknown } | null)?.version
    if (typeof version === 'number' && version > EFFECTS_VERSION) {
      this.options.onWarn?.(`副作用队列格式版本 ${version} 高于本插件支持的 ${EFFECTS_VERSION}，按空队列启动`)
      return
    }
    const rows = (parsed as { rows?: unknown } | null)?.rows
    if (!Array.isArray(rows)) return
    for (const raw of rows) {
      const row = rowOf(raw)
      if (row === undefined) continue
      this.rows.set(cacheKey(row.kind, row.key), row)
      if (row.seq > this.seq) this.seq = row.seq
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** 入队（同 kind+key 覆盖旧行并递增 generation）。 */
  async enqueue(kind: EffectKind, key: string, value: Record<string, unknown>): Promise<EffectRow> {
    if (this.closed) throw new Error('副作用队列已关闭，拒绝入队')
    const id = cacheKey(kind, key)
    const previous = this.rows.get(id)
    const at = this.now()
    this.seq += 1
    const row: EffectRow = {
      kind,
      key,
      value,
      seq: this.seq,
      generation: (previous?.generation ?? 0) + 1,
      attempts: 0,
      due: at,
      since: at,
    }
    this.rows.set(id, row)
    await this.flush()
    return row
  }

  /** `kind` 为 undefined 时返回全部行（测试与诊断用）。 */
  entries(kind?: EffectKind | undefined): readonly EffectRow[] {
    const all = [...this.rows.values()].sort((a, b) => a.seq - b.seq)
    return kind === undefined ? all : all.filter(row => row.kind === kind)
  }

  size(): number {
    return this.rows.size
  }

  /**
   * 现在允许尝试的行：已到期、未到失败阈值、且该 kind 未超在途上限；
   * 有序 kind 只放 seq 最小的一条。
   */
  pending(kind?: EffectKind | undefined): EffectRow[] {
    const at = this.now()
    const kinds = kind === undefined ? (Object.keys(EFFECT_SPECS) as EffectKind[]) : [kind]
    const picked: EffectRow[] = []
    for (const current of kinds) {
      const spec = EFFECT_SPECS[current]
      const alive = this.entries(current)
        .filter(row => row.attempts < FAILURES_BEFORE_ERROR && row.due <= at)
      const visible = spec.ordered ? alive.slice(0, 1) : alive.slice(0, Math.max(1, spec.limit))
      picked.push(...visible)
    }
    return picked.sort((a, b) => a.seq - b.seq)
  }

  /** 连续失败到阈值、已停止调度的行（诊断用；它们要人处理或随任务结算清掉）。 */
  dead(kind?: EffectKind | undefined): readonly EffectRow[] {
    return this.entries(kind).filter(row => row.attempts >= FAILURES_BEFORE_ERROR)
  }

  /** 结算并删除一行；generation 不再匹配说明行已被重新入队，忽略。 */
  async settle(kind: EffectKind, key: string, generation?: number | undefined): Promise<boolean> {
    const id = cacheKey(kind, key)
    const row = this.rows.get(id)
    if (row === undefined) return false
    if (generation !== undefined && row.generation !== generation) return false
    this.rows.delete(id)
    await this.flush()
    return true
  }

  /** 记一次失败：attempts+1、按退避推迟，到阈值时上报健康错误。 */
  async fail(kind: EffectKind, key: string, error: string, generation?: number | undefined): Promise<EffectRow | undefined> {
    const id = cacheKey(kind, key)
    const row = this.rows.get(id)
    if (row === undefined) return undefined
    if (generation !== undefined && row.generation !== generation) return undefined
    row.attempts += 1
    row.error = error
    row.due = this.now() + backoffOf(EFFECT_SPECS[kind], row.attempts)
    await this.flush()
    if (row.attempts >= FAILURES_BEFORE_ERROR) this.options.onGiveUp?.({ ...row })
    return { ...row }
  }

  /**
   * 关闭队列：停止接受新行，并把当前内存状态落盘。
   *
   * 未完成的行**保留**——它们的意义就是活过这次关闭；下一次 `load()` 会把它们
   * 还给恢复逻辑。
   */
  async drain(): Promise<void> {
    this.closed = true
    await this.flush()
  }

  private async flush(): Promise<void> {
    const file = this.options.file
    if (file === undefined) return
    const payload: EffectsFile = { version: EFFECTS_VERSION, rows: [...this.entries()] }
    const text = `${JSON.stringify(payload, undefined, 2)}\n`
    // 串行化写入：临时文件 + rename，避免崩溃留下半截 JSON。
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true })
        const temp = `${file}.tmp`
        await writeFile(temp, text, { mode: 0o600 })
        await rename(temp, file)
      } catch (error) {
        this.options.onWarn?.(`副作用队列落盘失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })
    await this.writing
  }
}

function cacheKey(kind: EffectKind, key: string): string {
  return `${kind}\u0000${key}`
}

/** 校验磁盘上的一行；坏行丢弃（与 persist.ts 同一策略）。 */
function rowOf(raw: unknown): EffectRow | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Partial<EffectRow>
  if (row.kind !== 'launch') return undefined
  if (typeof row.key !== 'string' || row.key === '') return undefined
  if (typeof row.value !== 'object' || row.value === null) return undefined
  for (const field of ['seq', 'generation', 'attempts', 'due', 'since'] as const) {
    const value = row[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  }
  return {
    kind: row.kind,
    key: row.key,
    value: { ...(row.value as Record<string, unknown>) },
    seq: Math.max(0, Math.trunc(row.seq as number)),
    generation: Math.max(0, Math.trunc(row.generation as number)),
    attempts: Math.max(0, Math.trunc(row.attempts as number)),
    due: row.due as number,
    since: row.since as number,
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
  }
}
