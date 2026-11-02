import { describe, expect, it, vi } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { SessionAccessRegistry, installSessionAccessProjection, sessionAccessOf } from '../src/session-access.js'
import { CLI_ACCESS_EVENT, CLI_ACCESS_PROJECTION_KEY, type MaestroSessionAccess } from '../src/wire.js'

type AccessState = { readonly sessionId: string } | null
interface Definition {
  readonly key: string
  readonly stateVersion: number
  readonly stateSchema: { parse(value: unknown): AccessState }
  init(header: unknown, inheritedEventCount: number): AccessState
  apply(state: AccessState, event: unknown): AccessState
  readonly wire: {
    readonly viewSchema: { parse(value: unknown): MaestroSessionAccess | null }
    view(state: unknown): MaestroSessionAccess | null
  }
}

/** Simulate delivery AFTER host session-read authorization, not an HTTP ID lookup. */
function authorizedProjection(registry?: SessionAccessRegistry) {
  let definition: Definition | undefined
  const dispose = vi.fn()
  const unregister = installSessionAccessProjection({ sessionProjections: {
    register(value: unknown) { definition = value as Definition; return dispose },
  } }, registry)
  if (definition === undefined) throw new Error('test access projection was not registered')
  const unit = definition
  const snapshot = (state: AccessState): MaestroSessionAccess => {
    const value = unit.wire.viewSchema.parse(unit.wire.view(state))
    if (value === null) throw new Error('test authorized projection did not deliver a capability')
    return value
  }
  return { definition: unit, dispose, unregister, snapshot,
    forHeader: (id: string) => snapshot(unit.init({ id }, 0)) }
}
function trustedSession(id: string) {
  return { id, append: vi.fn(() => { throw new Error('authorization must never append an event') }) }
}

describe('trusted Session capability registry positive security regressions', () => {
  it('delivers independent unpredictable 256-bit tokens only through the authorized projection', () => {
    const registry = new SessionAccessRegistry(), projection = authorizedProjection(registry)
    const a = trustedSession('owner-A'), b = trustedSession('owner-B')
    expect(registry.publish(a.id, a)).toBeUndefined()
    registry.publish(b.id, b)
    const accessA = projection.forHeader(a.id), accessB = projection.forHeader(b.id)
    expect(accessA.token).toMatch(/^[a-f0-9]{64}$/)
    expect(accessB.token).toMatch(/^[a-f0-9]{64}$/)
    expect(accessA.token).not.toBe(accessB.token)
    expect(registry.authorize(accessA.token)).toEqual({ sessionId: a.id })
    expect(registry.authorize(accessB.token)).toEqual({ sessionId: b.id })
    expect(registry.authorize(a.id)).toBeUndefined()
    expect(registry.authorize(accessA)).toBeUndefined()
    expect(a.append).not.toHaveBeenCalled()
    expect(b.append).not.toHaveBeenCalled()
  })
  it('rejects missing, empty and mismatched trusted Session ids without binding or rotating', () => {
    const registry = new SessionAccessRegistry(), projection = authorizedProjection(registry)
    const before = projection.forHeader('owner-A')
    const wrong = trustedSession('owner-B'), empty = trustedSession(''), missing = { append: vi.fn() }
    registry.publish('owner-A', wrong)
    registry.publish('owner-A', missing)
    registry.publish('', empty)
    expect(projection.forHeader('owner-A')).toEqual(before)
    // Invalid attempts must not consume the first valid live bind of a cold capability.
    registry.publish('owner-A', trustedSession('owner-A'))
    expect(projection.forHeader('owner-A')).toEqual(before)
    expect(registry.authorize(before.token)).toEqual({ sessionId: 'owner-A' })
    expect(wrong.append).not.toHaveBeenCalled()
    expect(missing.append).not.toHaveBeenCalled()
    expect(empty.append).not.toHaveBeenCalled()
  })
  it('is idempotent for one Session and immediately revokes on a real replacement', () => {
    const registry = new SessionAccessRegistry(), projection = authorizedProjection(registry)
    const first = trustedSession('owner-A'), replacement = trustedSession('owner-A')
    registry.publish(first.id, first)
    const previous = projection.forHeader(first.id), other = projection.forHeader('owner-B')
    registry.publish(first.id, first)
    expect(projection.forHeader(first.id)).toEqual(previous)
    registry.publish(replacement.id, replacement)
    expect(registry.authorize(previous.token)).toBeUndefined()
    const current = projection.forHeader(replacement.id)
    expect(current.token).not.toBe(previous.token)
    expect(registry.authorize(current.token)).toEqual({ sessionId: first.id })
    expect(projection.forHeader('owner-B')).toEqual(other)
    expect(registry.authorize(other.token)).toEqual({ sessionId: 'owner-B' })
    registry.publish(replacement.id, replacement)
    expect(projection.forHeader(replacement.id)).toEqual(current)
    expect(first.append).not.toHaveBeenCalled()
    expect(replacement.append).not.toHaveBeenCalled()
  })
  it('preserves a cold header credential on first live bind but rotates on later replacement', () => {
    const registry = new SessionAccessRegistry(), projection = authorizedProjection(registry)
    const state = projection.definition.init({ id: 'cold-owner' }, 0)
    const cold = projection.snapshot(state), first = trustedSession('cold-owner')
    registry.publish(first.id, first)
    expect(projection.snapshot(state)).toEqual(cold)
    registry.publish(first.id, first)
    expect(projection.snapshot(state)).toEqual(cold)
    registry.publish(first.id, trustedSession(first.id))
    const replacement = projection.snapshot(state)
    expect(replacement.token).not.toBe(cold.token)
    expect(registry.authorize(cold.token)).toBeUndefined()
    expect(registry.authorize(replacement.token)).toEqual({ sessionId: first.id })
  })
  it('clear revokes every token and unchanged projection state yields only fresh credentials', () => {
    const registry = new SessionAccessRegistry(), projection = authorizedProjection(registry)
    const session = trustedSession('owner-A'), state = projection.definition.init({ id: session.id }, 0)
    registry.publish(session.id, session)
    const a = projection.snapshot(state), b = projection.forHeader('owner-B')
    registry.clear()
    expect(registry.authorize(a.token)).toBeUndefined()
    expect(registry.authorize(b.token)).toBeUndefined()
    const fresh = projection.snapshot(state)
    expect(fresh.token).not.toBe(a.token)
    expect(registry.authorize(fresh.token)).toEqual({ sessionId: session.id })
    registry.publish(session.id, session)
    expect(projection.snapshot(state)).toEqual(fresh)
    expect(registry.authorize(a.token)).toBeUndefined()
    expect(registry.authorize(b.token)).toBeUndefined()
  })
  it.each([undefined, null, {}, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), '0'.repeat(64)])('rejects malformed or unissued bearer %s', token => {
    expect(new SessionAccessRegistry().authorize(token)).toBeUndefined()
  })
  it('restoring token-free state into a restarted registry never admits the old runtime token', () => {
    const old = new SessionAccessRegistry(), before = authorizedProjection(old)
    const state = before.definition.init({ id: 'owner-A' }, 0)
    const previous = before.snapshot(state)
    const checkpoint = JSON.stringify({ stateVersion: before.definition.stateVersion, state })
    expect(checkpoint).not.toContain('token')
    expect(checkpoint).not.toContain(previous.token)
    const restarted = new SessionAccessRegistry(), after = authorizedProjection(restarted)
    const restored = after.definition.stateSchema.parse(JSON.parse(checkpoint).state)
    expect(restarted.authorize(previous.token)).toBeUndefined()
    const current = after.snapshot(restored)
    expect(current.sessionId).toBe(previous.sessionId)
    expect(current.token).not.toBe(previous.token)
    expect(restarted.authorize(current.token)).toEqual({ sessionId: 'owner-A' })
    expect(restarted.authorize(previous.token)).toBeUndefined()
  })
})

describe('wire-only authorization never changes the real Session log or model surface', () => {
  it.each([false, true])('does not add ANY event to a real Session (existing conversation: %s)', withConversation => {
    const real = Session.create('real-cap-owner')
    if (withConversation) real.append('user/message', {
      role: 'user', content: [{ type: 'text', text: 'keep this conversation unchanged' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    const surfaceSnapshot = () => ({ nodes: [...real.surface.nodes], replaceGeneration: real.surface.replaceGeneration, contentGeneration: real.surface.contentGeneration })
    const before = { seq: real.seq, events: real.snapshotEvents(), surface: surfaceSnapshot(), messages: real.deriveMessages() }
    const registry = new SessionAccessRegistry(), projection = authorizedProjection(registry)
    registry.publish(real.id, real)
    registry.publish(real.id, real)
    const state = projection.definition.init(real.header, real.inheritedEventCount)
    const access = projection.snapshot(state)
    expect(registry.authorize(access.token)).toEqual({ sessionId: real.id })
    expect(real.seq).toBe(before.seq)
    expect(real.snapshotEvents()).toEqual(before.events)
    expect(real.snapshotEvents().some(event => event.type === CLI_ACCESS_EVENT)).toBe(false)
    expect(surfaceSnapshot()).toEqual(before.surface)
    expect(real.deriveMessages()).toEqual(before.messages)
    expect(JSON.stringify({ header: real.header, events: real.snapshotEvents(), surface: surfaceSnapshot(), messages: real.deriveMessages() })).not.toContain(access.token)
    const metadata = { stateVersion: projection.definition.stateVersion, state: projection.definition.stateSchema.parse(state) }
    expect(metadata).toEqual({ stateVersion: 2, state: { sessionId: real.id } })
    expect(JSON.stringify(metadata)).not.toContain('token')
    expect(JSON.stringify(metadata)).not.toContain(access.token)
  })
  it('uses only trusted header identity, ignoring all legacy access events including fork inheritance', () => {
    const registry = new SessionAccessRegistry(), projection = authorizedProjection(registry)
    const parent = projection.forHeader('owner-parent')
    const state = projection.definition.init({ id: 'owner-child', parentSession: 'owner-parent' }, 3)
    const child = projection.snapshot(state)
    for (const event of [
      { seq: 0, type: CLI_ACCESS_EVENT, data: parent },
      { seq: 4, type: CLI_ACCESS_EVENT, data: { sessionId: 'forged-owner', token: 'a'.repeat(64) } },
      { seq: 5, type: CLI_ACCESS_EVENT, data: { sessionId: 'owner-child', token: 'b'.repeat(64) } },
      { seq: 6, type: CLI_ACCESS_EVENT, data: { sessionId: 'owner-child', token: 'invalid' } },
      { seq: 7, type: 'user/message', data: parent },
    ]) {
      const applied = projection.definition.apply(state, event)
      expect(applied).toEqual(state)
      expect(applied).not.toBe(state)
      expect(projection.definition.apply(null, event)).toBeNull()
      expect(projection.snapshot(applied)).toEqual(child)
    }
    expect(child.sessionId).toBe('owner-child')
    expect(child.token).not.toBe(parent.token)
    expect(registry.authorize(parent.token)).toEqual({ sessionId: 'owner-parent' })
    expect(registry.authorize(child.token)).toEqual({ sessionId: 'owner-child' })
    expect(registry.authorize('a'.repeat(64))).toBeUndefined()
    expect(registry.authorize('b'.repeat(64))).toBeUndefined()
  })
  it('allows a native event to refresh wire delivery after a replacement without trusting its payload', () => {
    const registry = new SessionAccessRegistry(), projection = authorizedProjection(registry)
    const first = trustedSession('owner-A')
    registry.publish(first.id, first)
    const state = projection.definition.init({ id: first.id }, 0), old = projection.snapshot(state)
    registry.publish(first.id, trustedSession(first.id))
    const next = projection.definition.apply(state, { type: 'user/message', data: { sessionId: 'owner-B', token: old.token } })
    expect(next).not.toBe(state)
    expect(next).toEqual({ sessionId: first.id })
    const current = projection.snapshot(next)
    expect(current.token).not.toBe(old.token)
    expect(registry.authorize(current.token)).toEqual({ sessionId: first.id })
    expect(registry.authorize(old.token)).toBeUndefined()
    expect(JSON.stringify(next)).not.toContain('token')
  })
  it('invalidates old token-bearing checkpoints instead of importing their identity or token', () => {
    const registry = new SessionAccessRegistry(), projection = authorizedProjection(registry)
    const legacy = { sessionId: 'event-forged-owner', token: 'c'.repeat(64) }
    const cache = { stateVersion: 1, state: legacy }
    expect(projection.definition.stateVersion).toBe(2)
    expect(projection.definition.stateVersion).not.toBe(cache.stateVersion)
    expect(() => projection.definition.stateSchema.parse(cache.state)).toThrow('Invalid maestro session access projection state')
    expect(projection.definition.wire.view(cache.state)).toBeNull()
    // Model the host discarding the mismatching cache and replaying from its trusted header.
    const initial = projection.definition.init({ id: 'trusted-owner' }, 0)
    const rebuilt = projection.definition.apply(initial, { type: CLI_ACCESS_EVENT, data: legacy })
    const current = projection.snapshot(rebuilt)
    expect(rebuilt).toEqual({ sessionId: 'trusted-owner' })
    expect(current.sessionId).toBe('trusted-owner')
    expect(current.token).not.toBe(legacy.token)
    expect(registry.authorize(legacy.token)).toBeUndefined()
  })
  it.each([undefined, null, {}, [], { id: '' }, { id: 1 }, { sessionId: 'event-owner', token: 'd'.repeat(64) }])('does not infer a trusted header identity from %j', header => {
    const projection = authorizedProjection()
    const state = projection.definition.init(header, 0)
    expect(state).toBeNull()
    expect(projection.definition.wire.view(state)).toBeNull()
  })
  it.each([undefined, {}, [], '', { sessionId: '' }, { sessionId: 42 }, { sessionId: 'owner', token: 'e'.repeat(64) }])('rejects invalid or credential-bearing persisted state %j', state => {
    const projection = authorizedProjection()
    expect(() => projection.definition.stateSchema.parse(state)).toThrow('Invalid maestro session access projection state')
    expect(projection.definition.wire.view(state)).toBeNull()
  })
  it('separates state/view schemas and exposes no message projection or surface operation', () => {
    const projection = authorizedProjection(), definition = projection.definition
    expect(definition.key).toBe(CLI_ACCESS_PROJECTION_KEY)
    expect(definition).not.toHaveProperty('messageProjection')
    expect(definition).not.toHaveProperty('surfaceOp')
    expect(definition.stateSchema.parse(null)).toBeNull()
    expect(definition.wire.viewSchema.parse(null)).toBeNull()
    const access = projection.forHeader('owner-A')
    expect(sessionAccessOf(access)).toEqual(access)
    expect(() => definition.wire.viewSchema.parse({ sessionId: 'owner-A', token: 'bad' })).toThrow('Invalid maestro session access projection')
    expect(() => definition.stateSchema.parse(access)).toThrow('Invalid maestro session access projection state')
    projection.unregister?.()
    expect(projection.dispose).toHaveBeenCalledOnce()
  })
  it('does not let a consumer mutate the current registry credential through a view reference', () => {
    const registry = new SessionAccessRegistry(), projection = authorizedProjection(registry)
    const state = projection.definition.init({ id: 'owner-A' }, 0)
    const view = projection.definition.wire.view(state)!
    expect(Object.isFrozen(view)).toBe(true)
    expect(Reflect.set(view, 'token', 'f'.repeat(64))).toBe(false)
    expect(registry.authorize(view.token)).toEqual({ sessionId: 'owner-A' })
    registry.publish('owner-A', trustedSession('owner-A'))
    registry.publish('owner-A', trustedSession('owner-A'))
    expect(registry.authorize(view.token)).toBeUndefined()
  })
  it.each([undefined, null, {}, { sessionProjections: null }, { sessionProjections: {} }])('fails closed without a public projection registration service (%j)', host => {
    expect(installSessionAccessProjection(host)).toBeUndefined()
  })
})
