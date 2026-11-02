/**
 * 配置变更历史：把"配置什么时候被谁改成了什么"变成可读的差异。
 *
 * 本插件不接管配置的写入（那是 DSH 设置页与 `cordis.patch.yml` 的事），所以这里
 * 只做**只读快照 + 差异**：每次读到有效配置就记一条（去抖后），有了两条才有
 * "上次到这次改了什么"。这是 dsh-superagent `src/app/settings-history.ts` 的
 * 简化版——那边要显示 18 种语义化变更码，因为它的面板直接管保存；这里的面板
 * 只解释"为什么行为和昨天不一样"，字段路径足够。
 *
 * 落盘前一律过 `redactEffective`：历史文件里不会出现 token 与 apiKey。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EffectiveConfig } from './config.js'
import { redactEffective } from './config.js'

/** 历史文件格式版本。 */
export const CONFIG_HISTORY_VERSION = 1

/** 保留多少条快照（够看最近几十次改动）。 */
export const CONFIG_HISTORY_KEEP = 50

/** 同配置重复记录的去抖窗口：路由被轮询，不能每个请求都写一条。 */
export const CONFIG_HISTORY_DEBOUNCE_MS = 30_000

/** 一条快照。 */
export interface ConfigSnapshot {
  readonly at: number
  readonly effective: EffectiveConfig
}

/** 变更码：够表达"开关被打开/关闭"和"某个字段的值变了"。 */
export type ConfigChangeCode =
  | 'enabledOn'
  | 'enabledOff'
  | 'cliEnabled'
  | 'cliDisabled'
  | 'fieldChanged'

/** 一条差异。`field` 是点路径（`claude.minTaskDifficulty`），值已压成字符串。 */
export interface ConfigChange {
  readonly code: ConfigChangeCode
  readonly field: string
  readonly before: string
  readonly after: string
}

interface ConfigHistoryFile {
  version: number
  entries: ConfigSnapshot[]
}

export interface ConfigHistoryOptions {
  readonly file?: string | undefined
  readonly now?: (() => number) | undefined
  readonly keep?: number | undefined
  readonly debounceMs?: number | undefined
  readonly onWarn?: ((message: string) => void) | undefined
}

/** 把有效配置压成 `路径 → 字符串` 的扁平表（数组按 JSON 比较）。 */
export function flattenEffective(effective: EffectiveConfig): Record<string, string> {
  const flat: Record<string, string> = {}
  const walk = (value: unknown, prefix: string): void => {
    if (Array.isArray(value)) {
      flat[prefix] = JSON.stringify(value)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) walk(child, prefix === '' ? key : `${prefix}.${key}`)
      return
    }
    flat[prefix] = String(value)
  }
  walk(redactEffective(effective), '')
  return flat
}

/** 两份配置的差异，按字段路径稳定排序。 */
export function diffEffective(before: EffectiveConfig, after: EffectiveConfig): ConfigChange[] {
  const left = flattenEffective(before)
  const right = flattenEffective(after)
  const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
  const changes: ConfigChange[] = []
  for (const field of fields) {
    const was = left[field] ?? ''
    const now = right[field] ?? ''
    if (was === now) continue
    changes.push({ code: codeOf(field, now), field, before: was, after: now })
  }
  return changes
}

function codeOf(field: string, after: string): ConfigChangeCode {
  if (field === 'enabled') return after === 'true' ? 'enabledOn' : 'enabledOff'
  if (field === 'claude.enabled' || field === 'codex.enabled') return after === 'true' ? 'cliEnabled' : 'cliDisabled'
  return 'fieldChanged'
}

/**
 * 配置历史。`record()` 由 overview 路由驱动（那里本来就每次读配置），所以不需要
 * 额外的定时器；去抖让它变成"配置真的变了才写"。
 */
export class ConfigHistory {
  private entries: ConfigSnapshot[] = []
  private lastSignature: string | undefined
  private lastRecordedAt = 0
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly options: ConfigHistoryOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** 读回历史（坏文件按空历史处理；历史是诊断用的，不该挡住启动）。 */
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
      this.options.onWarn?.(`配置历史文件无法解析，按空历史启动：${file}`)
      return
    }
    const version = (parsed as { version?: unknown } | null)?.version
    if (typeof version === 'number' && version > CONFIG_HISTORY_VERSION) return
    const entries = (parsed as { entries?: unknown } | null)?.entries
    if (!Array.isArray(entries)) return
    this.entries = entries.flatMap(raw => {
      const snapshot = snapshotOf(raw)
      return snapshot === undefined ? [] : [snapshot]
    })
    if (this.entries.length > 0) {
      const last = this.entries[this.entries.length - 1]!
      this.lastSignature = signatureOf(last.effective)
      this.lastRecordedAt = last.at
    }
  }

  /** 记录当前配置；返回这次新产生的差异（没有变化 = 空数组）。 */
  async record(effective: EffectiveConfig): Promise<ConfigChange[]> {
    const signature = signatureOf(effective)
    const at = this.now()
    if (signature === this.lastSignature && at - this.lastRecordedAt < (this.options.debounceMs ?? CONFIG_HISTORY_DEBOUNCE_MS)) {
      return []
    }
    if (signature === this.lastSignature) {
      // 内容没变、只是过了窗口：不追加快照，只推进时间戳，避免历史被"轮询"填满。
      this.lastRecordedAt = at
      return []
    }
    const previous = this.entries[this.entries.length - 1]
    const changes = previous === undefined ? [] : diffEffective(previous.effective, effective)
    this.entries.push({ at, effective: redactEffective(effective) })
    // 截断放在内存里做，而不是只在写盘路径上：没有配置文件时历史同样要有界。
    const keep = Math.max(2, this.options.keep ?? CONFIG_HISTORY_KEEP)
    if (this.entries.length > keep) this.entries = this.entries.slice(this.entries.length - keep)
    this.lastSignature = signature
    this.lastRecordedAt = at
    await this.flush()
    return changes
  }

  /** 最新快照。 */
  last(): ConfigSnapshot | undefined {
    return this.entries[this.entries.length - 1]
  }

  /** 全部快照（旧的在前）。 */
  entriesOf(): readonly ConfigSnapshot[] {
    return this.entries
  }

  /** 最近一次变更（无前一条快照 = 空）。 */
  latestChanges(): readonly ConfigChange[] {
    const last = this.entries[this.entries.length - 1]
    const previous = this.entries[this.entries.length - 2]
    if (last === undefined || previous === undefined) return []
    return diffEffective(previous.effective, last.effective)
  }

  private async flush(): Promise<void> {
    const file = this.options.file
    if (file === undefined) return
    const keep = Math.max(2, this.options.keep ?? CONFIG_HISTORY_KEEP)
    if (this.entries.length > keep) this.entries = this.entries.slice(this.entries.length - keep)
    const payload: ConfigHistoryFile = { version: CONFIG_HISTORY_VERSION, entries: this.entries }
    const text = `${JSON.stringify(payload, undefined, 2)}\n`
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true })
        const temp = `${file}.tmp`
        await writeFile(temp, text, { mode: 0o600 })
        await rename(temp, file)
      } catch (error) {
        this.options.onWarn?.(`配置历史落盘失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })
    await this.writing
  }
}

/** 签名只用于判断"是否同一份配置"，不落盘（里面有 token）。 */
function signatureOf(effective: EffectiveConfig): string {
  return JSON.stringify(flattenEffective(effective))
}

function snapshotOf(raw: unknown): ConfigSnapshot | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as { at?: unknown; effective?: unknown }
  if (typeof record.at !== 'number' || !Number.isFinite(record.at)) return undefined
  if (typeof record.effective !== 'object' || record.effective === null) return undefined
  return { at: record.at, effective: record.effective as EffectiveConfig }
}
