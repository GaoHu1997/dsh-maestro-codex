/**
 * Form over the `dsh-maestro-codex` Host entry: staged text edits (model,
 * paths, URLs, timeouts, task-type lists) commit together on save; switches
 * and selects persist immediately. Same snapshot-store discipline as the
 * dsh-git-branch card form — the component reads through a selector while the
 * scope and the local drafts change underneath.
 */

import type { ConfigFormFace, ConfigFormOp } from './types.js'
import { normalizeTaskType, normalizeTaskTypes } from '../wire.js'

/** The fields this card edits (the host Config, resolved view). */
export interface SectionValue {
  enabled?: boolean
  defaultCli?: string
  /** Legacy shared threshold, inherited until a CLI gets its own setting. */
  minTaskDifficulty?: 'low' | 'medium' | 'high' | 'extreme'
  claudeMinTaskDifficulty?: 'low' | 'medium' | 'high' | 'extreme'
  codexMinTaskDifficulty?: 'low' | 'medium' | 'high' | 'extreme'
  claudeEnabled?: boolean
  claudeTaskTypes?: string[]
  claudePermissionMode?: string
  claudeBaseUrl?: string
  claudeAuthToken?: string
  claudeCliPath?: string
  claudeTimeoutMinutes?: number
  codexEnabled?: boolean
  codexTaskTypes?: string[]
  codexSandbox?: string
  codexBaseUrl?: string
  codexApiKey?: string
  codexCliPath?: string
  codexTimeoutMinutes?: number
  codexConfigOverrides?: string[]
  codexDshModel?: string
  claudeDshModel?: string
  /** 内置 dsh 子代理：只有类型与门槛两项可配。 */
  dshMinTaskDifficulty?: 'low' | 'medium' | 'high' | 'extreme'
  dshTaskTypes?: string[]
  /** Thinking level per CLI; '' = the CLI's own default. */
  claudeThinking?: string
  codexThinking?: string
  bridgeMcp?: boolean
  /** Hand dsh's skills to the dispatched CLI runs (catalog + on-demand load). */
  bridgeSkills?: boolean
  /** Host-tool bridging mode: off / auto / custom. */
  bridgeTools?: string
  /** Exact tool names bridged when mode is custom (one per line staged). */
  bridgeToolAllowlist?: string[]
  /** How claude children load dsh skills: bridge / native. */
  claudeSkillsMode?: string
  /** Persist settled dispatch results under $DSH_HOME/maestro/tasks. */
  persistTasks?: boolean
  /** Prepend a read-only git branch/status snapshot to the child's task text. */
  injectGitContext?: boolean
  /** Record each dispatch as a real dsh child session (usage + catalog row). */
  recordChildSessions?: boolean
  /** Automatic re-runs after a plain failure (0–2). */
  failureRetries?: number
  npmRegistry?: string
  maxConcurrentTasks?: number
}

/** Mirror host compatibility inheritance without coupling the two CLI settings. */
export function cliMinTaskDifficulty(values: SectionValue, cli: 'claude' | 'codex'): NonNullable<SectionValue['minTaskDifficulty']> {
  return (cli === 'claude' ? values.claudeMinTaskDifficulty : values.codexMinTaskDifficulty)
    ?? values.minTaskDifficulty ?? 'medium'
}

/** Fields persisted immediately on change. */
export type ImmediateField =
  | 'enabled' | 'claudeEnabled' | 'codexEnabled'
  | 'defaultCli' | 'claudeMinTaskDifficulty' | 'codexMinTaskDifficulty' | 'claudePermissionMode' | 'codexSandbox'
  | 'claudeDshModel' | 'codexDshModel'
  | 'dshMinTaskDifficulty' | 'dshTaskTypes'
  | 'claudeThinking' | 'codexThinking'
  | 'claudeTaskTypes' | 'codexTaskTypes'
  | 'bridgeMcp'
  | 'bridgeSkills'
  | 'bridgeTools'
  | 'claudeSkillsMode'
  | 'persistTasks'
  | 'injectGitContext'
  | 'recordChildSessions'

/** A value an immediate field accepts. */
export type ImmediateValue = string | boolean | readonly string[]

/** The routable owners of task types: the two CLIs plus the built-in dsh fallback. */
export type CliId = 'claude' | 'codex' | 'dsh'

/** The task-type lists are mutually exclusive: a type names the executor that
 * can serve it, so two lists offering the same type would make routing a coin
 * flip. Shared by the toggle below and the card's per-owner hint. */
export const TASK_TYPE_FIELDS: Readonly<Record<CliId, { own: ImmediateField; others: readonly { field: ImmediateField; owner: CliId }[] }>> = {
  claude: { own: 'claudeTaskTypes', others: [{ field: 'codexTaskTypes', owner: 'codex' }, { field: 'dshTaskTypes', owner: 'dsh' }] },
  codex: { own: 'codexTaskTypes', others: [{ field: 'claudeTaskTypes', owner: 'claude' }, { field: 'dshTaskTypes', owner: 'dsh' }] },
  dsh: { own: 'dshTaskTypes', others: [{ field: 'claudeTaskTypes', owner: 'claude' }, { field: 'codexTaskTypes', owner: 'codex' }] },
}

/** Human name per task-type owner, for the "moved off X" note. */
const OWNER_LABELS: Readonly<Record<CliId, string>> = {
  claude: 'claude cli',
  codex: 'codex cli',
  dsh: 'dsh 子代理',
}

/** Human name per immediate field, for the "did not save" note. */
const IMMEDIATE_LABELS: Readonly<Record<ImmediateField, string>> = {
  enabled: '插件总开关',
  claudeEnabled: 'claude CLI 开关',
  codexEnabled: 'codex CLI 开关',
  defaultCli: '默认 CLI',
  claudeMinTaskDifficulty: 'claude 最低任务难度',
  codexMinTaskDifficulty: 'codex 最低任务难度',
  claudePermissionMode: 'claude 权限模式',
  codexSandbox: 'codex 沙箱',
  claudeDshModel: 'claude 模型',
  codexDshModel: 'codex 模型',
  dshMinTaskDifficulty: 'dsh 子代理最低任务难度',
  dshTaskTypes: 'dsh 子代理的任务类型',
  claudeThinking: 'claude 思考等级',
  codexThinking: 'codex 思考等级',
  claudeTaskTypes: 'claude 的任务类型',
  codexTaskTypes: 'codex 的任务类型',
  bridgeMcp: 'MCP 桥接',
  bridgeSkills: '技能桥接',
  bridgeTools: '工具桥接',
  claudeSkillsMode: 'claude 技能加载方式',
  persistTasks: '任务记录持久化',
  injectGitContext: 'Git 上下文注入',
  recordChildSessions: '子会话记录',
}

/** One line of feedback about an immediate write. */
export interface MaestroFormNotice {
  tone: 'info' | 'error'
  text: string
}

/** Fields staged as text and committed on save. */
export type StagedField =
  | 'codexConfigOverrides'
  | 'claudeBaseUrl' | 'claudeAuthToken' | 'claudeCliPath' | 'claudeTimeoutMinutes'
  | 'codexBaseUrl' | 'codexApiKey' | 'codexCliPath' | 'codexTimeoutMinutes'
  | 'npmRegistry' | 'maxConcurrentTasks' | 'failureRetries'
  | 'bridgeToolAllowlist'

/** The multi-line list fields (one entry per line). */
const LIST_FIELDS: readonly StagedField[] = ['codexConfigOverrides', 'bridgeToolAllowlist']

/** Numeric fields: the staged text must parse into range before a save runs. */
const NUMBER_FIELDS: Readonly<Record<string, { min: number; max: number }>> = {
  claudeTimeoutMinutes: { min: 1, max: 240 },
  codexTimeoutMinutes: { min: 1, max: 240 },
  maxConcurrentTasks: { min: 1, max: 8 },
  failureRetries: { min: 0, max: 2 },
}

/** What the card renders. */
export interface MaestroFormState {
  available: boolean
  writable: boolean
  /** Resolved values (user layer over defaults), with drafts and in-flight
   * immediate writes applied — a click stays visible until the host answers. */
  values: SectionValue
  /** Which staged fields hold a draft that differs from the stored value. */
  dirty: StagedField[]
  saving: boolean
  failed: boolean
  /** Feedback about the last immediate write (gone after a few seconds). */
  notice: MaestroFormNotice | undefined
  /** Why a save would fail right now (first offending field). */
  invalid: { field: StagedField; message: string } | undefined
}

/** The form actions the card's slot entry injects. */
export interface MaestroFormActions {
  save: () => Promise<void>
  discard: () => void
  /** `value` may be a function of the CURRENT value: the write is queued, so a
   * click computes its next state when its turn comes, not when it was made. */
  setImmediate: (field: ImmediateField, value: ImmediateValue | ((current: ImmediateValue | undefined) => ImmediateValue)) => void
  /** Flip one task type on a CLI. Adding it takes the type away from the other
   * CLI in the SAME write, so a type never names two CLIs at once. */
  toggleTaskType: (cli: CliId, type: string) => void
  editStaged: (field: StagedField, text: string) => void
}

/**
 * Minimal observable snapshot source: stable reference until the fact moves.
 */
export interface MaestroStore {
  getSnapshot(): MaestroFormState
  subscribe(listener: () => void): () => void
}

export class MaestroForm {
  private snapshotValue: MaestroFormState
  private readonly listeners = new Set<() => void>()
  private readonly drafts = new Map<StagedField, string>()
  /** Values the user just set, kept on screen until the host answers — the
   * stored snapshot only reflects them after the write round-trips. */
  private readonly optimistic = new Map<ImmediateField, ImmediateValue>()
  /** One immediate write at a time: two fast clicks would otherwise race the
   * host revision and the loser's edit would vanish without a trace. */
  private queue: Promise<void> = Promise.resolve()
  private noticeValue: MaestroFormNotice | undefined
  private noticeSeq = 0
  private saving = false
  private failed = false

  constructor(private readonly scope: ConfigFormFace<SectionValue>) {
    this.snapshotValue = this.project()
    scope.subscribe(() => { this.publish() })
  }

  bind(): MaestroStore {
    return {
      getSnapshot: () => this.snapshotValue,
      subscribe: listener => {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
    }
  }

  actions(): MaestroFormActions {
    return {
      save: () => this.save(),
      discard: () => {
        if (this.drafts.size === 0 && !this.failed) return
        this.drafts.clear()
        this.failed = false
        this.publish()
      },
      setImmediate: (field, value) => {
        const next = typeof value === 'function' ? value(this.currentImmediate(field)) : value
        if (this.sameValue(this.currentImmediate(field), next)) return
        this.optimistic.set(field, next)
        this.publish()
        this.enqueue(async () => { await this.commit([[field, next]]) })
      },
      toggleTaskType: (cli, rawType) => {
        const type = normalizeTaskType(rawType)
        const { own, others } = TASK_TYPE_FIELDS[cli]
        const mine = this.stringList(own)
        const adding = !mine.includes(type)
        const nextMine = adding ? [...mine, type] : mine.filter(entry => entry !== type)
        const entries: Array<readonly [ImmediateField, ImmediateValue]> = [[own, nextMine]]
        const movedFrom: string[] = []
        if (adding) {
          // Adding takes the type away from every other owner in the SAME write,
          // so one type never names two executors at once.
          for (const other of others) {
            const theirs = this.stringList(other.field)
            if (!theirs.includes(type)) continue
            entries.push([other.field, theirs.filter(entry => entry !== type)])
            movedFrom.push(OWNER_LABELS[other.owner])
          }
        }
        if (this.sameValue(mine, nextMine) && movedFrom.length === 0) return
        this.optimistic.set(own, nextMine)
        for (const [field, value] of entries.slice(1)) this.optimistic.set(field, value)
        this.publish()
        this.enqueue(async () => {
          const landed = await this.commit(entries)
          if (landed && movedFrom.length > 0) this.flash('info', `「${type}」已从 ${movedFrom.join('、')} 的任务类型里移除：一个任务类型只属于一个执行器。`)
        })
      },
      editStaged: (field, text) => {
        this.drafts.set(field, text)
        this.failed = false
        this.publish()
      },
    }
  }

  /** Queue a write behind the ones already waiting. */
  private enqueue(task: () => Promise<void>): void {
    const run = (): Promise<void> => task().catch(() => { /* reported by the task */ })
    this.queue = this.queue.then(run, run)
  }

  /** What the card shows right now for an immediate field. */
  private currentImmediate(field: ImmediateField): ImmediateValue | undefined {
    const pendingValue = this.optimistic.get(field)
    if (pendingValue !== undefined) return pendingValue
    return this.scope.getSnapshot().value?.[field] as ImmediateValue | undefined
  }

  /** A task-type list that reads the freshly queued value, not a stale render. */
  private stringList(field: ImmediateField): readonly string[] {
    const value = this.currentImmediate(field)
    return Array.isArray(value) ? normalizeTaskTypes(value.filter((entry): entry is string => typeof entry === 'string')) : []
  }

  private sameValue(left: unknown, right: ImmediateValue): boolean {
    if (Array.isArray(left) && Array.isArray(right)) {
      return left.length === right.length && right.every((entry, index) => left[index] === entry)
    }
    return left === right
  }

  /** Write the fields as one host call (a single revision-checked batch when the
   * host offers `mutate`), and report a refusal instead of dropping it. */
  private async commit(entries: ReadonlyArray<readonly [ImmediateField, ImmediateValue]>): Promise<boolean> {
    try {
      const mutate = this.scope.mutate
      if (entries.length > 1 && typeof mutate === 'function') {
        // Two fields, one revision: the type leaves one CLI as it joins the
        // other, and no half-applied state is ever visible.
        const ops: ConfigFormOp[] = entries.map(([field, value]) => ({ op: 'set', path: [field], value }))
        const landed = await mutate.call(this.scope, ops)
        if (landed === false) throw new Error('rejected')
      } else {
        for (const [field, value] of entries) {
          const landed = await this.scope.set(field, value)
          if (landed === false) throw new Error('rejected')
        }
      }
      this.settle(entries)
      this.publish()
      return true
    } catch {
      this.settle(entries)
      this.flash('error', this.describeFailure(entries.map(([field]) => field)))
      return false
    }
  }

  /** Drop the optimistic value a write covered — unless a newer click already
   * took that field over, in which case its own write owns the result. */
  private settle(entries: ReadonlyArray<readonly [ImmediateField, ImmediateValue]>): void {
    for (const [field, value] of entries) {
      const pending = this.optimistic.get(field)
      if (pending !== undefined && !this.sameValue(pending, value)) continue
      this.optimistic.delete(field)
    }
  }

  private describeFailure(fields: readonly ImmediateField[]): string {
    const names = fields.map(field => `「${IMMEDIATE_LABELS[field]}」`).join('、')
    const writable = this.scope.getSnapshot().writable
    return `${names}没有保存成功：${writable ? '宿主拒绝了这次改动' : '当前配置只读'}，已恢复为改动前的值。`
  }

  /** Show one line of feedback and take it down by itself. */
  private flash(tone: MaestroFormNotice['tone'], text: string): void {
    const seq = ++this.noticeSeq
    this.noticeValue = { tone, text }
    this.publish()
    const timer = globalThis.setTimeout(() => {
      if (this.noticeSeq !== seq) return
      this.noticeValue = undefined
      this.publish()
    }, tone === 'error' ? 9000 : 4000)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  /** Parse one staged field's text into the value to write; string = error. */
  private parseStaged(field: StagedField, text: string): string | string[] | number | undefined {
    if (LIST_FIELDS.includes(field)) {
      return text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
    }
    const range = NUMBER_FIELDS[field]
    if (range !== undefined) {
      if (!/^-?\d+$/.test(text.trim())) return undefined
      return Number(text.trim())
    }
    return text
  }

  private validate(): { field: StagedField; message: string } | undefined {
    for (const [field, range] of Object.entries(NUMBER_FIELDS)) {
      const text = this.drafts.get(field as StagedField)
      if (text === undefined) continue
      if (!/^-?\d+$/.test(text.trim()) || Number(text.trim()) < range.min || Number(text.trim()) > range.max) {
        return { field: field as StagedField, message: `${field} 需要一个 ${range.min}–${range.max} 的整数` }
      }
    }
    return undefined
  }

  private async save(): Promise<void> {
    if (this.saving || this.drafts.size === 0) return
    const invalid = this.validate()
    if (invalid !== undefined) {
      this.failed = true
      this.publish()
      return
    }
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    try {
      for (const [field, text] of this.drafts) {
        const parsed = this.parseStaged(field, text)
        if (parsed === undefined) {
          landed = false
          continue
        }
        const accepted = await this.scope.set(field, parsed as never)
        if (accepted === false) landed = false
      }
    } catch {
      landed = false
    }
    if (landed) this.drafts.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  private project(): MaestroFormState {
    const snapshot = this.scope.getSnapshot()
    const stored = snapshot.value ?? {}
    const values: SectionValue = { ...stored }
    // An immediate click shows at once; the snapshot catches up on its own.
    const draftValues = values as unknown as Record<string, ImmediateValue | undefined>
    for (const [field, value] of this.optimistic) draftValues[field] = value
    for (const field of ['claudeTaskTypes', 'codexTaskTypes', 'dshTaskTypes'] as const) {
      const types = values[field]
      if (Array.isArray(types)) values[field] = normalizeTaskTypes(types)
    }
    const dirty: StagedField[] = []
    for (const [field, text] of this.drafts) {
      const parsed = this.parseStaged(field, text)
      if (LIST_FIELDS.includes(field)) {
        ;(values[field] as unknown as string[]) = Array.isArray(parsed) ? parsed : []
      } else if (NUMBER_FIELDS[field] !== undefined) {
        ;(values[field] as unknown as number) = typeof parsed === 'number' ? parsed : (stored[field] as number | undefined) ?? 0
      } else {
        ;(values[field] as unknown as string) = typeof parsed === 'string' ? parsed : ''
      }
      const storedText = LIST_FIELDS.includes(field)
        ? (Array.isArray(stored[field]) ? (stored[field] as string[]).join('\n') : '')
        : String(stored[field] ?? '')
      if (text !== storedText) dirty.push(field)
    }
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      values,
      dirty,
      saving: this.saving,
      failed: this.failed,
      notice: this.noticeValue,
      invalid: this.validate(),
    }
  }

  private publish(): void {
    const next = this.project()
    if (next === this.snapshotValue) return
    this.snapshotValue = next
    for (const listener of this.listeners) listener()
  }
}

/** The text of one field as the user sees it: draft over stored (list = newline-joined). */
export function fieldText(state: MaestroFormState, field: StagedField): string {
  const value = state.values[field]
  if (LIST_FIELDS.includes(field)) return Array.isArray(value) ? value.join('\n') : ''
  return value === undefined ? '' : String(value)
}
