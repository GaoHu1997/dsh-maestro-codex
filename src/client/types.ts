/**
 * Client-side context/service faces, typed structurally where the shell's
 * merges are not importable as values from this bundle. Keep these narrow —
 * the real declarations come from the type-only imports of the dsh client
 * packages in index.ts.
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * The client context face this plugin uses: the slot ledger (`ctx.slots`) and
 * the config forms service (`ctx.configForms`) provided by the shell.
 */
export type ClientContext = Context & {
  slots: {
    inject(name: string, register: () => unknown): () => void
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  configForms: {
    get<T>(entryId: string): ConfigFormFace<T>
    describe(): {
      getSnapshot(): { status: string; view?: { namespaces?: ReadonlyArray<{ ns: string }> } | undefined }
      subscribe(listener: () => void): () => void
      ensure(): Promise<unknown> | void
    }
  }
  locale?: {
    register(ns: string, dictionaries: Record<string, unknown>): unknown
  }
  /** The workspace registry face (for the cwd auto-fill in the dispatch form). */
  workspaces?: {
    list: {
      getSnapshot(): { items?: ReadonlyArray<{ path?: string }> }
    }
  }
}

/** One field edit inside a batch write: the op shape the host's
 * `configForms` controller understands (`{ op: 'set', path: [field], value }`). */
export interface ConfigFormOp {
  op: 'set'
  path: string[]
  value: unknown
}

/** The host-projected config form for this plugin's entry. */
export interface ConfigFormFace<T> {
  getSnapshot(): {
    status: string
    writable: boolean
    value?: T | undefined
    user?: Record<string, unknown> | undefined
  }
  /** Write one field; resolves `false` when the host refused it (stale revision). */
  set(field: string, value: unknown): Promise<boolean | void>
  /** Apply several field edits as ONE revision-checked write. Optional: older
   * hosts only expose `set`, and the form then falls back to sequential writes. */
  mutate?(ops: readonly ConfigFormOp[], expectedRevision?: number): Promise<boolean | void>
  subscribe(listener: () => void): () => void
}
