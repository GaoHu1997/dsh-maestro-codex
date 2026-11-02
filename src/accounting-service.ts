import type { Context } from '@deepseek-ai/cordis'
import type { CliUsageRecord, CliUsageState } from './usage.js'
import type { UsageJournal } from './usage-journal.js'
import { sessionAccessOf, type SessionAccessRegistry } from './session-access.js'

export const ACCOUNTING_SERVICE = 'maestroCliAccounting'
export interface NativeRecoveryDiagnostics {
  readonly source: 'sdk-count-observation-recovery'
  readonly observedRecords: number
  readonly ownedWriterBarriers: number
  readonly skippedRecords: number
  readonly failedRecords: number
  readonly pendingRecords: number
  readonly standardProjectionVerification: 'not-performed'
  readonly reasons: readonly string[]
}
export interface AccountingSnapshot {
  readonly schemaVersion: 1
  readonly sessionId: string
  readonly usage: CliUsageState
  /** Recovery observations are separate from canonical completeness and SDK statistical acceptance. */
  readonly nativeRecovery?: NativeRecoveryDiagnostics
  readonly semantics: {
    readonly requests: 'settled-cli-tasks'
    readonly tokenSource: 'reported-cli-counters'
    readonly unknownCounters: 'null'
    readonly nativeMirrors: 'same-spend-not-additive'
  }
  readonly health: {
    readonly complete: boolean
    readonly journalComplete: boolean
    readonly countersComplete: boolean
    readonly incompleteSettlements: number
    readonly corruptEntriesPresent: boolean
    readonly source: 'plugin-canonical-journal'
  }
}
/** Public plugin interface, not a private variable or replacement host service.
 * Consumers obtain the capability through the HOST-authorized session feed.
 * Knowing a session ID alone never authorizes a read; no global fallback exists.
 * Plugins with unrestricted host/global/file access remain management principals.
 */
export interface MaestroCliAccountingService {
  read(access: unknown): Promise<AccountingSnapshot>
  /** Full immutable settlement history for attribution and mirror deduplication. */
  settlements(access: unknown): Promise<readonly CliUsageRecord[]>
}
declare module '@deepseek-ai/cordis' {
  interface Context { maestroCliAccounting: MaestroCliAccountingService }
}
export function createAccountingService(journal: UsageJournal, registry: SessionAccessRegistry, recovery?: (sessionId: string) => NativeRecoveryDiagnostics): MaestroCliAccountingService {
  return Object.freeze({
    async settlements(access: unknown): Promise<readonly CliUsageRecord[]> {
      const supplied = sessionAccessOf(access)
      const principal = supplied === undefined ? undefined : registry.authorize(supplied.token)
      if (supplied === undefined || principal === undefined || principal.sessionId !== supplied.sessionId) throw new Error('未获得该父会话的用量读取授权')
      await journal.refresh()
      if (registry.authorize(supplied.token)?.sessionId !== principal.sessionId) throw new Error('父会话读取授权已撤销')
      return journal.recordsFor(principal.sessionId)
    },
    async read(access: unknown): Promise<AccountingSnapshot> {
      const supplied = sessionAccessOf(access)
      const principal = supplied === undefined ? undefined : registry.authorize(supplied.token)
      if (supplied === undefined || principal === undefined || principal.sessionId !== supplied.sessionId) throw new Error('未获得该父会话的用量读取授权')
      await journal.refresh()
      if (registry.authorize(supplied.token)?.sessionId !== principal.sessionId) throw new Error('父会话读取授权已撤销')
      const incompleteSettlements = journal.incompleteFor(principal.sessionId)
      const corruptEntriesPresent = journal.status().corrupt !== 0
      const usage = structuredClone(journal.snapshot(principal.sessionId))
      const journalComplete = incompleteSettlements === 0 && !corruptEntriesPresent
      const countersComplete = [usage.totals.inputTokens, usage.totals.outputTokens, usage.totals.cachedInputTokens, usage.totals.cacheWriteTokens].every(value => value !== null)
      return {
        schemaVersion: 1, sessionId: principal.sessionId, usage,
        ...(recovery === undefined ? {} : { nativeRecovery: structuredClone(recovery(principal.sessionId)) }),
        semantics: { requests: 'settled-cli-tasks', tokenSource: 'reported-cli-counters', unknownCounters: 'null', nativeMirrors: 'same-spend-not-additive' },
        health: { complete: journalComplete && countersComplete, journalComplete, countersComplete, incompleteSettlements, corruptEntriesPresent, source: 'plugin-canonical-journal' },
      }
    },
  })
}
/** Uses Cordis's public provide/get extension contract; never overwrites SDK code. */
export function installAccountingService(ctx: Context, journal: UsageJournal, registry: SessionAccessRegistry, recovery?: (sessionId: string) => NativeRecoveryDiagnostics): (() => void) | undefined {
  if (typeof ctx.provide !== 'function') return undefined
  try {
    return ctx.provide(ACCOUNTING_SERVICE, createAccountingService(journal, registry, recovery))
  } catch {
    // Cordis keys the service store per isolation scope across fibers, so when a
    // reload re-applies this plugin before the previous fiber unregistered, the
    // second provide() throws "has been registered" and would take the whole
    // plugin down. Registering again is pointless then: the live implementation
    // stays reachable through the shared store. Fail open and let the plugin body load.
    return undefined
  }
}
