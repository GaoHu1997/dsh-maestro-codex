import { randomBytes } from 'node:crypto'
import { CLI_ACCESS_PROJECTION_KEY, type MaestroSessionAccess } from './wire.js'

export interface AccessSession { readonly id?: string; append(type: string, data: unknown): unknown }
export function sessionAccessOf(value: unknown): MaestroSessionAccess | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  return typeof record['sessionId'] === 'string' && record['sessionId'] !== '' && typeof record['token'] === 'string' && /^[a-f0-9]{64}$/.test(record['token'])
    ? { sessionId: record['sessionId'], token: record['token'] } : undefined
}

interface SessionAccessOwner {
  session: AccessSession | undefined
  readonly access: MaestroSessionAccess
}
type SessionAccessState = { readonly sessionId: string } | null

function isAccessState(value: unknown): value is Exclude<SessionAccessState, null> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 1 && Object.hasOwn(record, 'sessionId')
    && typeof record.sessionId === 'string' && record.sessionId !== ''
}

/** Runtime capabilities never enter a Session log or persisted projection state. */
export class SessionAccessRegistry {
  private readonly byOwner = new Map<string, SessionAccessOwner>()
  private readonly byToken = new Map<string, string>()
  /** Bind a trusted live Session; this does not publish an event or deliver a token. */
  publish(sessionId: string, trustedSession: AccessSession): void {
    if (typeof sessionId !== 'string' || sessionId === '' || trustedSession.id !== sessionId) return
    const previous = this.byOwner.get(sessionId)
    if (previous?.session === trustedSession) return
    // A header-only/cold projection may be read before its first live binding.
    if (previous !== undefined && previous.session === undefined) {
      previous.session = trustedSession
      return
    }
    this.issue(sessionId, trustedSession)
  }
  /** @internal Only the host-authorized projection may deliver this value.
   * A session ID is not an external caller's permission; never expose this as an HTTP lookup.
   */
  accessForProjection(trustedSessionId: string): MaestroSessionAccess | null {
    if (typeof trustedSessionId !== 'string' || trustedSessionId === '') return null
    return (this.byOwner.get(trustedSessionId) ?? this.issue(trustedSessionId, undefined)).access
  }
  private issue(sessionId: string, session: AccessSession | undefined): SessionAccessOwner {
    const access = Object.freeze({ sessionId, token: randomBytes(32).toString('hex') })
    const previous = this.byOwner.get(sessionId)
    if (previous !== undefined) this.byToken.delete(previous.access.token)
    const owner = { session, access }
    this.byOwner.set(sessionId, owner)
    this.byToken.set(access.token, sessionId)
    return owner
  }
  authorize(value: unknown): { readonly sessionId: string } | undefined {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return undefined
    const sessionId = this.byToken.get(value)
    return sessionId === undefined ? undefined : { sessionId }
  }
  clear(): void { this.byOwner.clear(); this.byToken.clear() }
}

/** Wire delivery inherits the host's session-read authorization, never an event's identity. */
export function installSessionAccessProjection(host: unknown, registry = new SessionAccessRegistry()): (() => void) | undefined {
  if (typeof host !== 'object' || host === null) return undefined
  const service = (host as { sessionProjections?: { register(definition: unknown): unknown } }).sessionProjections
  if (service === undefined || service === null || typeof service.register !== 'function') return undefined
  const stateSchema = { parse(value: unknown): SessionAccessState {
    if (value === null) return null
    // Reject token-bearing v1 cache entries so they must be rebuilt from the trusted header.
    if (!isAccessState(value)) throw new TypeError('Invalid maestro session access projection state')
    return { sessionId: value.sessionId }
  } }
  const viewSchema = { parse(value: unknown): MaestroSessionAccess | null {
    if (value === null) return null
    const access = sessionAccessOf(value)
    if (access === undefined) throw new TypeError('Invalid maestro session access projection')
    return access
  } }
  const definition = {
    key: CLI_ACCESS_PROJECTION_KEY, stateVersion: 2, stateSchema,
    init: (header: unknown, _inheritedEventCount: number): SessionAccessState => {
      if (typeof header !== 'object' || header === null || Array.isArray(header)) return null
      // SessionHeader.id is the SDK's durable identity; events cannot supply or override it.
      const id = (header as { id?: unknown }).id
      return typeof id === 'string' && id !== '' ? { sessionId: id } : null
    },
    // Native events prompt fresh wire delivery without importing ANY event data.
    apply: (state: SessionAccessState, _event: unknown): SessionAccessState =>
      state === null ? null : { sessionId: state.sessionId },
    // snapshot invokes view each time, even when its persisted state has not changed.
    wire: { viewSchema, view: (state: unknown): MaestroSessionAccess | null =>
      isAccessState(state) ? registry.accessForProjection(state.sessionId) : null },
  }
  const dispose = service.register(definition)
  return typeof dispose === 'function' ? () => { (dispose as () => void)() } : () => {}
}
