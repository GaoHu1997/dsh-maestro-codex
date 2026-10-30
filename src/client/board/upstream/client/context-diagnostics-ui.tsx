/** Original diagnostics provider, button and alert. Host slot registration stays with the caller. */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import { Button, IconCloseOutlineRegular, IconContextInjectionOutlineRegular, IconWarningTriangleOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarSubagentAddress } from '../context-types.ts'
import type { ContextDiagnosticError, ContextDiagnosticTarget, ContextDiagnostics, ContextDiagnosticsSnapshot } from './context-diagnostics.ts'
import { t, type CopyKey } from './locales.ts'
import css from './context-diagnostics.module.css'

/** The three entry points, as the e2e lane tells them apart. */
export type DiagnosticsEntryKind = 'session' | 'agent' | 'job'

/** Testid of an entry point's control; ABSENT while the control is not offered. */
export const DIAGNOSTICS_ENTRY_ATTR = 'data-dsh-ctx-entry'

/** Testid of the frame-wide alert. */
export const DIAGNOSTICS_ALERT_ATTR = 'data-dsh-ctx-alert'

/** The controller's carrier; `undefined` = this tree has no diagnostics. */
const DiagnosticsStoreContext = createContext<ContextDiagnostics | undefined>(undefined)

/** Thread one activation's controller into a subtree (shell, native tab body). */
export function ContextDiagnosticsHost(props: {
  controller?: ContextDiagnostics
  children?: ReactNode
}): ReactNode {
  return (
    <DiagnosticsStoreContext.Provider value={props.controller}>
      {props.children}
    </DiagnosticsStoreContext.Provider>
  )
}

/** The controller in scope for this tree (undefined = no entry point renders). */
function useDiagnosticsStore(): ContextDiagnostics | undefined {
  return useContext(DiagnosticsStoreContext)
}

function useDiagnosticsSnapshot(store: ContextDiagnostics | undefined): ContextDiagnosticsSnapshot | undefined {
  return useSyncExternalStore(
    store?.subscribe ?? NO_SUBSCRIBE,
    store?.getSnapshot ?? NO_SNAPSHOT,
    store?.getSnapshot ?? NO_SNAPSHOT,
  )
}

const NO_SUBSCRIBE = (): (() => void) => () => {}

const NO_SNAPSHOT = (): undefined => undefined

/**
 * One entry point's control, shared so the three surfaces cannot drift apart:
 * the gate (capability available AND a resolved target), the single-open
 * disable, and the e2e handle.
 */
export function ContextDiagnosticsButton(props: {
  kind: DiagnosticsEntryKind
  /** `undefined` = this surface has nothing addressable to offer. */
  target: ContextDiagnosticTarget | undefined
  /** The host glyph's size (the header uses 14, the floating window 12). */
  iconSize: number
  /** The caller's box class, when the glyph must not take row width. */
  className?: string
  /** Dismiss source UI after dispatch; the controller owns the pending request. */
  onNavigate?(): void
}): ReactNode {
  const { kind, target, iconSize, className } = props
  const store = useDiagnosticsStore()
  const snapshot = useDiagnosticsSnapshot(store)
  if (store === undefined || target === undefined || snapshot?.available !== true) return null
  const busy = snapshot.busy === true
  return (
    <Button
      variant="ghost"
      size="sm"
      {...(className === undefined ? {} : { className })}
      {...{ [DIAGNOSTICS_ENTRY_ATTR]: kind }}
      // Busy is announced as well as enforced: one open at a time disables
      // every entry point while it runs.
      aria-busy={busy ? 'true' : undefined}
      icon={<IconContextInjectionOutlineRegular size={iconSize} />}
      aria-label={t('contextDiagnostics')}
      title={t('contextDiagnostics')}
      disabled={busy}
      onClick={() => {
        store.open(target)
        props.onNavigate?.()
      }}
    />
  )
}

/** The copy key of one failure reason. */
function reasonKey(reason: ContextDiagnosticError['reason']): CopyKey {
  switch (reason) {
    case 'navigation': return 'contextDiagnosticsNavigation'
    case 'timeout': return 'contextDiagnosticsTimeout'
    case 'open': return 'contextDiagnosticsOpenFailed'
    case 'unavailable': return 'contextDiagnosticsUnavailable'
  }
}

/**
 * The ONE error alert (`shell.overlay`), dismissed by the controller's own
 * `dismissError()` — never a timer. Gated on the ERROR only, not on
 * `available`: an open already in flight when the capability went away must
 * still report why it failed.
 */
export function ContextDiagnosticsAlert(props: { controller: ContextDiagnostics }): ReactNode {
  const { controller } = props
  const snapshot = useDiagnosticsSnapshot(controller)
  const error = snapshot?.error
  if (error === undefined) return null
  return (
    <div className={css.alertLayer} {...{ [DIAGNOSTICS_ALERT_ATTR]: '' }}>
      <div className={css.alert} role="alert">
        <span className={css.alertIcon} aria-hidden="true">
          <IconWarningTriangleOutlineRegular size={14} />
        </span>
        <span className={css.alertText}>
          <span className={css.alertTitle}>
            {t('contextDiagnosticsFailed', { label: error.targetLabel })}
          </span>
          <span className={css.alertReason}>{t(reasonKey(error.reason))}</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className={css.alertClose}
          icon={<IconCloseOutlineRegular size={12} />}
          aria-label={t('contextDiagnosticsDismiss')}
          title={t('contextDiagnosticsDismiss')}
          onClick={() => { controller.dismissError() }}
        />
      </div>
    </div>
  )
}

/** A tree node's navigable address, when the tree really has one: the ROOT node
 *  carries none (it IS the main session) and is addressed by its own id, and an
 *  incomplete pair (a stale parent, a synthesized member) yields no control. */
export function diagnosticAddressOf(
  nodeId: string,
  address: SidebarSubagentAddress | undefined,
): SidebarSubagentAddress | undefined {
  return address !== undefined && address.parentSessionId !== '' && address.childSessionId === nodeId
    ? address
    : undefined
}
