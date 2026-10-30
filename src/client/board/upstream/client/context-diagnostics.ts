/** Upstream diagnostics controller contract. The host supplies the controller. */
import type { SidebarSubagentAddress } from '../context-types.ts'

export interface ContextDiagnosticTarget {
  sessionId: string
  label?: string
  address?: SidebarSubagentAddress
}

export interface ContextDiagnosticError {
  reason: 'unavailable' | 'navigation' | 'timeout' | 'open'
  targetLabel: string
}

export interface ContextDiagnosticsSnapshot {
  available: boolean
  busy: boolean
  error?: ContextDiagnosticError
}

export interface ContextDiagnostics {
  getSnapshot(): ContextDiagnosticsSnapshot
  subscribe(listener: () => void): () => void
  open(target: ContextDiagnosticTarget): void
  dismissError(): void
  dispose(): void
}
