/**
 * 插件自己的健康看板：谁在坏、坏成什么样，一处登记。
 *
 * 和 `host-capabilities.ts` 的分工：那边报"宿主给我的能力面是否齐全"（启动时
 * 探测一次，静态）；这里报"运行中这条链路现在是否正常工作"（随时写入，
 * 动态）。两者并列出现在 overview 里，不合并——一个缺 capability 的宿主仍然
 * 可以健康，一个能力齐全的宿主也可以正在失败。
 *
 * 单写者规则照抄 dsh-superagent 的 `src/infra/health.ts`：一个名字只能被一处
 * 认领，重复认领直接抛错。这样"谁写的这条状态"永远只有一个答案，不会出现
 * 两个模块互相覆盖同一条健康信息。
 */

/** 健康等级：ok = 正常；degraded = 能用但功能缺失；error = 最近一次尝试失败。 */
export type HealthLevel = 'ok' | 'degraded' | 'error'

/**
 * 登记名（固定的几处）。新增一处就要在 `HEALTH_IMPACTS` 里写清它对用户意味着
 * 什么，否则面板只会显示一个没有解释的红点。
 */
export const HEALTH_NAMES = [
  'dispatch',
  'spawn',
  'effects',
  'persist',
  'bridge',
  'native-mirror',
  'preflight',
] as const

export type HealthName = typeof HEALTH_NAMES[number]

/** 每个名字坏掉时用户实际失去什么。 */
export const HEALTH_IMPACTS: Readonly<Record<HealthName, string>> = {
  dispatch: '派发失败：失败的任务需要人看日志后决定重试或换 CLI',
  spawn: '子进程无法正常启动或杀掉：可能出现残留进程',
  effects: '副作用队列写不进磁盘：重启后无法知道哪些派发没走完',
  persist: '历史结果存不下来：重启后看板上没有旧任务',
  bridge: '宿主工具/技能桥不可用：CLI 子代理拿不到 dsh 的工具与技能',
  'native-mirror': '原生子会话镜像与真实记录不一致：用量与看板可能缺条目',
  preflight: '模型预检不可用：派发可能带着不可用的模型名启动',
}

export interface HealthEntry {
  readonly name: HealthName
  readonly level: HealthLevel
  /** 人读的一句话；`ok` 时通常缺省。 */
  readonly message?: string | undefined
  /** 最后一次写入的时刻。 */
  readonly at: number
  /** 该条目坏掉的影响（来自 `HEALTH_IMPACTS`，方便 UI 直接渲染）。 */
  readonly impact: string
}

/** 一个已认领的写入口。 */
export interface HealthReporter {
  set(level: HealthLevel, message?: string): void
  /** 回到 `ok`（消息清空）。 */
  clear(): void
}

export interface HealthBoardOptions {
  readonly now?: (() => number) | undefined
}

/**
 * 看板本体。未认领的名字不出现在 `all()` 里——"没上报"和"健康"是两件事，
 * 面板不该为每个存在的模块编一条绿色的 `ok`。
 */
export class HealthBoard {
  private readonly entries = new Map<HealthName, HealthEntry>()
  private readonly owners = new Set<HealthName>()

  constructor(private readonly options: HealthBoardOptions = {}) {}

  /** 认领一个名字；同一名字被认领两次是编程错误，直接抛。 */
  claim(name: HealthName): HealthReporter {
    if (this.owners.has(name)) throw new Error(`健康条目 ${name} 已被另一处认领`)
    this.owners.add(name)
    const write = (level: HealthLevel, message?: string): void => {
      this.entries.set(name, {
        name,
        level,
        ...(message === undefined || message === '' ? {} : { message }),
        at: this.options.now?.() ?? Date.now(),
        impact: HEALTH_IMPACTS[name],
      })
    }
    return {
      set: write,
      clear: () => write('ok'),
    }
  }

  /**
   * 只读快照：严格按 `HEALTH_NAMES` 的声明顺序。
   *
   * 不按时间排——同一块面板刷新两次条目位置不该跳动；名字顺序在代码里固定，
   * 人看几次就记住了哪个在哪。
   */
  all(): HealthEntry[] {
    const entries: HealthEntry[] = []
    for (const name of HEALTH_NAMES) {
      const entry = this.entries.get(name)
      if (entry !== undefined) entries.push(entry)
    }
    return entries
  }

  /** 最坏等级；没有任何条目 = `ok`。 */
  worst(): HealthLevel {
    const levels = this.all().map(entry => entry.level)
    if (levels.includes('error')) return 'error'
    if (levels.includes('degraded')) return 'degraded'
    return 'ok'
  }

  /** 正在报错/降级的条目（面板只展示这些，健康的不占空间）。 */
  problems(): HealthEntry[] {
    return this.all().filter(entry => entry.level !== 'ok')
  }
}
