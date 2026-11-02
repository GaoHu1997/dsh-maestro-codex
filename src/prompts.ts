/**
 * 可编辑的提示模板：插件注入给子代理的那几句话，允许团队改成自己的说法。
 *
 * 范围刻意很小——只有三处：任务末尾的结果协议、给主代理的路由提示、续接消息的
 * 前缀。改的是"插件说的话"，不是模型的人格，也不是 CLI 自己的 system prompt。
 *
 * 覆盖要能跟着版本走：保存覆盖时记下当时默认文本的指纹（`base`）。插件升级后
 * 默认文本变了，指纹对不上 → 该条目标成 `stale`，面板提示"默认已更新"，由人
 * 决定合并还是重置。这是 dsh-superagent `docs/004` 里 override.base 的同一套
 * 做法：不然默认改好了，用户的旧覆盖会悄悄把改进吃掉。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 模板文件格式版本。 */
export const PROMPTS_VERSION = 1

/** 单条模板的字数上限（够一段说明，不够塞一篇文档）。 */
export const PROMPT_CAP = 1000

export type PromptId = 'resultProtocol' | 'routingHint' | 'replyPrefix'

export interface PromptFragment {
  readonly id: PromptId
  /** 面板上的标题。 */
  readonly title: string
  /** 出厂文本；源码里的单一事实来源就是这里。 */
  readonly defaultText: string
}

/** 出厂模板。改这几句等于改默认行为，所以要连同测试一起改。 */
export const PROMPT_FRAGMENTS: readonly PromptFragment[] = [
  {
    id: 'resultProtocol',
    title: '结果协议行（追加到任务末尾）',
    defaultText: '完成时在回复的最后一行写：MAESTRO_RESULT {"state":"progress|waiting|ready|blocked|failed|dropped","human_action":"只有人能做的下一步","summary":"一句话结论"}',
  },
  {
    // 出厂为空：路由提示本来就由 `routing.ts` 按当前配置生成（含门槛与
    // 候选 CLI），这里只放"团队想补的那一句"，免得两处说同一件事还漂移。
    id: 'routingHint',
    title: '路由提示附加说明（接在系统提示后面）',
    defaultText: '',
  },
  {
    // 同样出厂为空：续接指令本身就是人写的，前缀只在该团队有固定开场白时才设。
    id: 'replyPrefix',
    title: '续接消息前缀',
    defaultText: '',
  },
]

export interface PromptEntry {
  readonly id: PromptId
  readonly title: string
  /** 当前生效文本（覆盖优先）。 */
  readonly text: string
  /** 是否被覆盖过。 */
  readonly edited: boolean
  /** 覆盖时记录默认指纹与现在不一致 = 默认文本升级过。 */
  readonly stale: boolean
}

interface StoredOverride {
  text: string
  /** 覆盖时默认文本的指纹。 */
  base: string
  at: number
}

interface PromptFile {
  version: number
  overrides: Record<string, StoredOverride>
}

export interface PromptBookOptions {
  readonly file?: string | undefined
  readonly now?: (() => number) | undefined
  readonly onWarn?: ((message: string) => void) | undefined
}

/** 默认文本的指纹（sha256 前 16 位，够区分版本，不占空间）。 */
export function baseOfDefault(id: PromptId): string {
  const fragment = PROMPT_FRAGMENTS.find(candidate => candidate.id === id)
  if (fragment === undefined) throw new Error(`未知的提示模板：${id}`)
  return createHash('sha256').update(fragment.defaultText).digest('hex').slice(0, 16)
}

/** 模板簿：读覆盖、算 stale、装配出生效文本。 */
export class PromptBook {
  private readonly overrides = new Map<PromptId, StoredOverride>()
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly options: PromptBookOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

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
      this.options.onWarn?.(`提示模板文件无法解析，按出厂文本启动：${file}`)
      return
    }
    const version = (parsed as { version?: unknown } | null)?.version
    if (typeof version === 'number' && version > PROMPTS_VERSION) return
    const overrides = (parsed as { overrides?: unknown } | null)?.overrides
    if (typeof overrides !== 'object' || overrides === null) return
    for (const [key, raw] of Object.entries(overrides)) {
      if (!isPromptId(key)) continue
      const stored = raw as Partial<StoredOverride>
      if (typeof stored?.text !== 'string' || typeof stored.base !== 'string') continue
      this.overrides.set(key, { text: stored.text, base: stored.base, at: typeof stored.at === 'number' ? stored.at : this.now() })
    }
  }

  /** 全部条目的当前状态（面板据此渲染表单与"默认已更新"标记）。 */
  list(): PromptEntry[] {
    return PROMPT_FRAGMENTS.map(fragment => {
      const override = this.overrides.get(fragment.id)
      return {
        id: fragment.id,
        title: fragment.title,
        text: override?.text ?? fragment.defaultText,
        edited: override !== undefined,
        stale: override !== undefined && override.base !== baseOfDefault(fragment.id),
      }
    })
  }

  /** 生效文本（装配用）。 */
  text(id: PromptId): string {
    const override = this.overrides.get(id)
    if (override !== undefined) return override.text
    const fragment = PROMPT_FRAGMENTS.find(candidate => candidate.id === id)
    if (fragment === undefined) throw new Error(`未知的提示模板：${id}`)
    return fragment.defaultText
  }

  /** 覆盖一条；`base` 记下当前的默认指纹，将来默认改版就能被发现。 */
  async override(id: PromptId, text: string): Promise<void> {
    const trimmed = text.trim()
    if (trimmed === '') {
      await this.reset(id)
      return
    }
    if (trimmed.length > PROMPT_CAP) throw new Error(`提示模板不能超过 ${PROMPT_CAP} 字`)
    this.overrides.set(id, { text: trimmed, base: baseOfDefault(id), at: this.now() })
    await this.flush()
  }

  /** 恢复出厂文本。 */
  async reset(id: PromptId): Promise<void> {
    if (this.overrides.delete(id)) await this.flush()
  }

  private async flush(): Promise<void> {
    const file = this.options.file
    if (file === undefined) return
    const payload: PromptFile = {
      version: PROMPTS_VERSION,
      overrides: Object.fromEntries(this.overrides),
    }
    const text = `${JSON.stringify(payload, undefined, 2)}\n`
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true })
        const temp = `${file}.tmp`
        await writeFile(temp, text, { mode: 0o600 })
        await rename(temp, file)
      } catch (error) {
        this.options.onWarn?.(`提示模板落盘失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })
    await this.writing
  }
}

function isPromptId(value: string): value is PromptId {
  return PROMPT_FRAGMENTS.some(fragment => fragment.id === value)
}
