/**
 * A plugin-owned veto for CLI observation records, not a host/SDK patch.
 *
 * Public contract verified against dsh-agent@0.2.1-rc.5 runtime-types.d.ts:
 * agent/pre-step receives { agent, messages, turn, step, signal } and next;
 * the only rejection decision is { kind: 'reject' }. Agent.session is the
 * executing agent's real Session. This module never resolves wire identities.
 *
 * The installed loop invokes pre-step before preparing/streaming its model
 * request, but after inbox claim and prompt assembly. This is not a zero-event
 * or zero-prompt-assembly guarantee. A fork with a new ordinary Session id is
 * an explicit new DSH executor, not a resume of the original CLI record.
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** Documented public event slice; no dependency install or SDK augmentation. */
export interface CliRecordPreStepPayload {
  readonly agent: { readonly session: unknown }
  readonly messages: UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}
export type CliRecordPreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
export type CliRecordPreStepListener = (
  this: unknown,
  payload: CliRecordPreStepPayload,
  next: () => Promise<CliRecordPreStepDecision>,
) => Promise<CliRecordPreStepDecision>
interface PublicPreStepHost {
  on(
    name: 'agent/pre-step',
    listener: CliRecordPreStepListener,
    options?: { prepend?: boolean; global?: boolean },
  ): () => boolean
}

/**
 * Exact current generated namespace, not every session beginning with cli-:
 * New dispatches use task-${randomUUID()} (legacy short ids remain recognized);
 * the recorder creates cli-${taskId}, with header.origin = 'subagent'. This conservative
 * reserved-name guard also survives task-board pruning and asynchronous reload.
 * It is classification for refusal, NEVER an authorization grant.
 */
export function isReservedCliRecordSession(session: unknown): boolean {
  if (typeof session !== 'object' || session === null) return false
  const value = session as { id?: unknown; header?: unknown }
  if (typeof value.id !== 'string' || !/^cli-task-(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(value.id)) return false
  return typeof value.header === 'object' && value.header !== null
    && (value.header as { origin?: unknown }).origin === 'subagent'
}

/**
 * Register the public pre-step middleware and return an idempotent disposer.
 * Missing public ctx.on is explicit (undefined), so the caller can warn rather
 * than claim that this supplementary execution veto is installed.
 *
 * ownsRecord receives ONLY payload.agent.session. It may supplement the default
 * with trusted registry/journal provenance plus header.parentSession equality;
 * it cannot weaken the reserved namespace veto. Lookup errors reject that step.
 * No marker/log scan, agents.resume patch, cancellation, or created hook occurs.
 */
export function installCliRecordGuard(
  ctx: unknown,
  ownsRecord?: (session: unknown) => boolean,
): (() => void) | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined
  const host = ctx as PublicPreStepHost
  if (typeof host.on !== 'function') return undefined
  const listener: CliRecordPreStepListener = async (payload, next) => {
    // The real public event always has an Agent and Session. A broken trusted
    // event contract must not become permission to execute using a wire field.
    const session = payload?.agent?.session
    if (typeof session !== 'object' || session === null) return { kind: 'reject' }
    if (isReservedCliRecordSession(session)) return { kind: 'reject' }
    try {
      if (ownsRecord?.(session) === true) return { kind: 'reject' }
    } catch {
      return { kind: 'reject' }
    }
    return next()
  }
  const dispose = host.on('agent/pre-step', listener, { prepend: true, global: true })
  let active = true
  return () => {
    if (!active) return
    active = false
    dispose()
  }
}
