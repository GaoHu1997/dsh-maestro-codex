import { describe, expect, it, vi } from 'vitest'
import {
  installCliRecordGuard, isReservedCliRecordSession,
  type CliRecordPreStepDecision, type CliRecordPreStepListener, type CliRecordPreStepPayload,
} from '../src/record-guard.js'

/** Synthetic public event fixture ONLY; no SDK replacement or real agent resume. */
function publicEvents() {
  let listener: CliRecordPreStepListener | undefined
  const dispose = vi.fn(() => { listener = undefined; return true })
  const host = {
    on: vi.fn(function (this: unknown, name: 'agent/pre-step', fn: CliRecordPreStepListener, options?: { prepend?: boolean; global?: boolean }) {
      expect(this).toBe(host)
      expect(name).toBe('agent/pre-step')
      expect(options).toEqual({ prepend: true, global: true })
      listener = fn
      return dispose
    }),
  }
  return {
    host, dispose,
    emit(payload: CliRecordPreStepPayload, next: () => Promise<CliRecordPreStepDecision>) {
      return listener === undefined ? next() : listener.call({ syntheticScope: true }, payload, next)
    },
  }
}
function session(id: string, origin?: 'subagent') {
  return Object.freeze({ id, header: Object.freeze({ id, parentSession: 'owner-A', ...(origin === undefined ? {} : { origin }) }) })
}
function payload(value: unknown): CliRecordPreStepPayload {
  return { agent: { session: value }, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
}
const enter = () => vi.fn(async (): Promise<CliRecordPreStepDecision> => ({ kind: 'enter', messages: [] }))

describe('plugin CLI record public pre-step guard (synthetic contract boundary)', () => {
  it('registers only the documented public middleware, rejects the reserved CLI record, and never enters the model continuation', async () => {
    const events = publicEvents()
    const cleanup = installCliRecordGuard(events.host)
    const next = enter()
    const result = await events.emit(payload(session('cli-task-deadbeef', 'subagent')), next)
    expect(result).toEqual({ kind: 'reject' })
    expect(Object.keys(result)).toEqual(['kind'])
    expect(next).not.toHaveBeenCalled()
    expect(events.host.on).toHaveBeenCalledOnce()
    cleanup?.()
  })

  it.each([
    { id: 'owner-A', origin: undefined },
    { id: 'ordinary-session', origin: 'subagent' as const },
    { id: 'cli-ordinary', origin: undefined },
    { id: 'cli-ordinary', origin: 'subagent' as const },
    { id: 'cli-task-deadbeef', origin: undefined },
    { id: 'cli-task-DEADBEEF', origin: 'subagent' as const },
    { id: 'cli-task-deadbee', origin: 'subagent' as const },
    { id: 'cli-task-deadbeef0', origin: 'subagent' as const },
    { id: 'cli-task-deadbeeg', origin: 'subagent' as const },
  ])('allows the real parent/ordinary identity $id with origin $origin', async ({ id, origin }) => {
    const events = publicEvents()
    installCliRecordGuard(events.host)
    const next = enter()
    const actual = session(id, origin)
    expect(isReservedCliRecordSession(actual)).toBe(false)
    expect(await events.emit(payload(actual), next)).toEqual({ kind: 'enter', messages: [] })
    expect(next).toHaveBeenCalledOnce()
  })

  it('uses the actual Session, not agent.id or forged wire/register-context identity fields', async () => {
    const events = publicEvents()
    const registerContext = Object.assign(events.host, { session: session('cli-task-deadbeef', 'subagent'), sessionId: 'cli-task-deadbeef' })
    installCliRecordGuard(registerContext)
    const actual = session('owner-A')
    const request = {
      ...payload(actual),
      agent: { id: 'cli-task-deadbeef', session: actual },
      sessionId: 'cli-task-deadbeef', session: session('cli-task-deadbeef', 'subagent'),
      origin: 'subagent', header: { origin: 'subagent' },
      executionAgent: { session: session('cli-task-deadbeef', 'subagent') },
      executionContext: { agent: { session: session('cli-task-deadbeef', 'subagent') } },
      body: { agent: { session: session('cli-task-deadbeef', 'subagent') } },
    }
    const next = enter()
    expect(await events.emit(request, next)).toEqual({ kind: 'enter', messages: [] })
    expect(next).toHaveBeenCalledOnce()
  })

  it('wire fields cannot hide the actual CLI record behind a parent identity', async () => {
    const events = publicEvents()
    installCliRecordGuard(events.host)
    const request = {
      ...payload(session('cli-task-deadbeef', 'subagent')),
      agent: { id: 'owner-A', session: session('cli-task-deadbeef', 'subagent') },
      sessionId: 'owner-A', session: session('owner-A'), body: { agent: { session: session('owner-A') } },
    }
    const next = enter()
    expect(await events.emit(request, next)).toEqual({ kind: 'reject' })
    expect(next).not.toHaveBeenCalled()
  })

  it('supplements reserved classification with the exact trusted Session predicate reference', async () => {
    const events = publicEvents()
    const historical = session('legacy-cli-record', 'subagent')
    const owns = vi.fn((value: unknown) => value === historical)
    installCliRecordGuard(events.host, owns)
    const next = enter()
    expect(await events.emit(payload(historical), next)).toEqual({ kind: 'reject' })
    expect(owns).toHaveBeenCalledExactlyOnceWith(historical)
    expect(owns.mock.calls[0]?.[0]).toBe(historical)
    expect(next).not.toHaveBeenCalled()
  })

  it('a false custom predicate cannot weaken the default reserved namespace veto', async () => {
    const events = publicEvents()
    const owns = vi.fn(() => false)
    installCliRecordGuard(events.host, owns)
    const next = enter()
    expect(await events.emit(payload(session('cli-task-deadbeef', 'subagent')), next)).toEqual({ kind: 'reject' })
    expect(owns).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('a predicate error fails closed without calling next', async () => {
    const events = publicEvents()
    installCliRecordGuard(events.host, () => { throw new Error('synthetic ownership lookup failed') })
    const next = enter()
    expect(await events.emit(payload(session('legacy-cli-record', 'subagent')), next)).toEqual({ kind: 'reject' })
    expect(next).not.toHaveBeenCalled()
  })

  it('a false ownership result forwards the exact continuation decision unchanged', async () => {
    const events = publicEvents()
    installCliRecordGuard(events.host, () => false)
    const decision: CliRecordPreStepDecision = { kind: 'enter', messages: [], startsRequestSeries: true }
    const next = vi.fn(async () => decision)
    expect(await events.emit(payload(session('owner-A')), next)).toBe(decision)
    expect(next).toHaveBeenCalledOnce()
  })

  it('allows an explicit fork with a new ordinary Session id, even if marker-like history was inherited', async () => {
    const events = publicEvents()
    installCliRecordGuard(events.host)
    const inherited = {
      ...session('session-new-fork'),
      header: { id: 'session-new-fork', parentSession: 'cli-task-deadbeef', isSeeded: true },
      ownEvents: vi.fn(() => { throw new Error('deprecated scan must never run') }),
      snapshotEvents: vi.fn(() => { throw new Error('deprecated scan must never run') }),
      marker: { childSessionId: 'cli-task-deadbeef', executor: 'external-cli' },
    }
    const next = enter()
    expect(await events.emit(payload(inherited), next)).toEqual({ kind: 'enter', messages: [] })
    expect(inherited.ownEvents).not.toHaveBeenCalled()
    expect(inherited.snapshotEvents).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
  })

  it('cleanup uses the public disposer once and leaves subsequent ordinary event processing intact', async () => {
    const events = publicEvents()
    const cleanup = installCliRecordGuard(events.host)
    cleanup?.()
    cleanup?.()
    expect(events.dispose).toHaveBeenCalledOnce()
    const next = enter()
    expect(await events.emit(payload(session('cli-task-deadbeef', 'subagent')), next)).toEqual({ kind: 'enter', messages: [] })
    expect(next).toHaveBeenCalledOnce()
  })

  it.each([null, undefined, {}, { on: undefined }, { on: 'not-a-function' }])('reports absent public ctx.on as unavailable: %j', ctx => {
    expect(installCliRecordGuard(ctx)).toBeUndefined()
  })

  it('rejects an invalid trusted payload without taking a Session from its wire body', async () => {
    const events = publicEvents()
    installCliRecordGuard(events.host)
    const malformed = { ...payload(undefined), body: { agent: { session: session('owner-A') } } }
    const next = enter()
    expect(await events.emit(malformed, next)).toEqual({ kind: 'reject' })
    expect(next).not.toHaveBeenCalled()
  })
})
