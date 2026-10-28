/**
 * Form over the `dsh-maestro-codex` Host entry: staged text edits (model,
 * paths, URLs, timeouts, task-type lists) commit together on save; switches
 * and selects persist immediately. Same snapshot-store discipline as the
 * dsh-git-branch card form — the component reads through a selector while the
 * scope and the local drafts change underneath.
 */

import type { ConfigFormFace } from './types.js'

/** The fields this card edits (the host Config, resolved view). */
export interface SectionValue {
  enabled?: boolean
  defaultCli?: string
  claudeEnabled?: boolean
  claudeTaskTypes?: string[]
  claudeModel?: string
  claudePermissionMode?: string
  claudeBaseUrl?: string
  claudeAuthToken?: string
  claudeCliPath?: string
  claudeTimeoutMinutes?: number
  codexEnabled?: boolean
  codexTaskTypes?: string[]
  codexModel?: string
  codexSandbox?: string
  codexBaseUrl?: string
  codexApiKey?: string
  codexCliPath?: string
  codexTimeoutMinutes?: number
  codexConfigOverrides?: string[]
  codexDshModel?: string
  claudeDshModel?: string
  npmRegistry?: string
  maxConcurrentTasks?: number
}

/** Fields persisted immediately on change. */
export type ImmediateField =
  | 'enabled' | 'claudeEnabled' | 'codexEnabled'
  | 'defaultCli' | 'claudePermissionMode' | 'codexSandbox'
  | 'claudeDshModel' | 'codexDshModel'

/** Fields staged as text and committed on save. */
export type StagedField =
  | 'claudeTaskTypes' | 'codexTaskTypes' | 'codexConfigOverrides'
  | 'claudeModel' | 'claudeBaseUrl' | 'claudeAuthToken' | 'claudeCliPath' | 'claudeTimeoutMinutes'
  | 'codexModel' | 'codexBaseUrl' | 'codexApiKey' | 'codexCliPath' | 'codexTimeoutMinutes'
  | 'npmRegistry' | 'maxConcurrentTasks'

/** The multi-line list fields (one entry per line). */
const LIST_FIELDS: readonly StagedField[] = ['claudeTaskTypes', 'codexTaskTypes', 'codexConfigOverrides']

/** Numeric fields: the staged text must parse into range before a save runs. */
const NUMBER_FIELDS: Readonly<Record<string, { min: number; max: number }>> = {
  claudeTimeoutMinutes: { min: 1, max: 240 },
  codexTimeoutMinutes: { min: 1, max: 240 },
  maxConcurrentTasks: { min: 1, max: 8 },
}

/** What the card renders. */
export interface MaestroFormState {
  available: boolean
  writable: boolean
  /** Resolved values (user layer over defaults), with drafts applied. */
  values: SectionValue
  /** Which staged fields hold a draft that differs from the stored value. */
  dirty: StagedField[]
  saving: boolean
  failed: boolean
  /** Why a save would fail right now (first offending field). */
  invalid: { field: StagedField; message: string } | undefined
}

/** The form actions the card's slot entry injects. */
export interface MaestroFormActions {
  save: () => Promise<void>
  discard: () => void
  setImmediate: (field: ImmediateField, value: string | boolean) => void
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
      setImmediate: (field, value) => { void this.setImmediateField(field, value) },
      editStaged: (field, text) => {
        this.drafts.set(field, text)
        this.failed = false
        this.publish()
      },
    }
  }

  private async setImmediateField(field: ImmediateField, value: string | boolean): Promise<void> {
    const current = this.scope.getSnapshot().value?.[field]
    if (value === current) return
    try {
      await this.scope.set(field, value as never)
      this.failed = false
    } catch {
      this.failed = true
    }
    this.publish()
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
        await this.scope.set(field, parsed as never)
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
