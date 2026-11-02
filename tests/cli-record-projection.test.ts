import { describe, expect, it } from 'vitest'
import { applyCliRecordEvent, cliRecordProjectionDefinition, cliRecordStateOf, initCliRecordState, installCliRecordProjection, ownsCliRecordSession, type CliRecordState } from '../src/cli-record-projection.js'

const HEADER = { id: 'cli-task-1', parentSession: 'parent-A', origin: 'subagent' }
const MARKER = { version: 1, kind: 'cli-record', taskId: 'task-1', childSessionId: 'cli-task-1', parentSessionId: 'parent-A', executor: 'external-cli', usageId: 'usage-1', source: 'cli:codex', nativeInputSemantics: 'uncached', nativeUsageAvailable: true }
const USAGE = { inputTokens: 10, outputTokens: 3, cacheReadTokens: 2 }
function event(state: CliRecordState, seq: number, type: string, data: unknown): CliRecordState { return applyCliRecordEvent(state, { seq, type, data }) }
function ready(): CliRecordState {
  let state = initCliRecordState(HEADER, 0)
  state = event(state, 0, 'request/context', { provider: 'p', model: 'm' })
  return event(state, 1, 'maestro/cli-child', MARKER)
}
const chunk = (usage: unknown) => ({ type: 'chunk', chunk: { type: 'usage', usage } })

describe('M: host-only CLI identity projection (not deployed host acceptance)', () => {
  it('contributes a host-only unit and makes no wire or deprecated scan calls', () => {
    const unit = cliRecordProjectionDefinition()
    expect(unit.key).toBe('maestroCliRecord'); expect(unit).not.toHaveProperty('wire')
    expect(unit.stateSchema.parse(unit.init(HEADER, 0))).toEqual(initCliRecordState(HEADER, 0))
  })
  it('classifies the own marker using actual header and cut, not token availability', () => {
    const state = ready()
    expect(state.marker?.taskId).toBe('task-1'); expect(state.usageObserved).toBe(false)
    expect(state.acceptedUsages).toHaveLength(0)
  })
  it.each(['version', 'kind', 'executor', 'childSessionId', 'parentSessionId', 'taskId', 'usageId', 'source'])('rejects mismatching/empty %s', key => {
    const bad = { ...MARKER, [key]: key === 'version' ? 0 : '' }
    expect(event(initCliRecordState(HEADER, 0), 1, 'maestro/cli-child', bad).marker).toBeNull()
  })
  it('ignores an inherited CLI marker and usage even when prefix identity resembles a record', () => {
    let state = initCliRecordState(HEADER, 5)
    state = event(state, 1, 'maestro/cli-child', MARKER)
    state = event(state, 2, 'assistant/attempt', { stream: [chunk(USAGE)] })
    expect(state.marker).toBeNull(); expect(state.usageObserved).toBe(false)
    expect(event(state, 5, 'maestro/cli-child', MARKER).marker?.usageId).toBe('usage-1')
  })
  it('does not let a new ordinary fork acquire identity from source CLI marker', () => {
    const header = { id: 'session-fork', parentSession: 'cli-task-1', origin: undefined }
    const state = event(initCliRecordState(header, 2), 2, 'maestro/cli-child', MARKER)
    expect(state.headerValid).toBe(false); expect(state.marker).toBeNull()
  })
  it('requires a valid own seq, not missing/negative/fractional input', () => {
    for (const seq of [NaN, -1, 0.5]) expect(event(initCliRecordState(HEADER, 0), seq, 'maestro/cli-child', MARKER).marker).toBeNull()
  })
  it('tracks a real assistant/attempt usage and last cumulative chunk, not the declaration', () => {
    const state = event(ready(), 2, 'assistant/attempt', { stream: [chunk({ inputTokens: 8, outputTokens: 1 }), chunk(USAGE)] })
    expect(state.acceptedUsages).toEqual([{ ...USAGE, usageId: 'usage-1', source: 'cli:codex', provider: 'p', model: 'm' }])
  })
  it('tracks message top-level usage once, not a second stream sample', () => {
    const state = event(ready(), 2, 'assistant/message', { message: { source: { kind: 'model', provider: 'p', model: 'm' } }, usage: USAGE, stream: [chunk(USAGE)] })
    expect(state.acceptedUsages).toHaveLength(1)
  })
  it.each([null, { inputTokens: null, outputTokens: 1 }, { inputTokens: -1, outputTokens: 1 }])('marks malformed usage as observed without accepting it (%j)', usage => {
    const state = event(ready(), 2, 'assistant/attempt', { stream: [chunk(usage)] })
    expect(state.usageObserved).toBe(true); expect(state.acceptedUsages).toHaveLength(0)
  })
  it('requires uncached attribution and a provider/model route', () => {
    for (const state of [event(initCliRecordState(HEADER, 0), 1, 'maestro/cli-child', MARKER), event(ready(), 2, 'maestro/cli-child', { ...MARKER, nativeInputSemantics: 'unknown' })]) {
      const next = event(state, 3, 'assistant/attempt', { stream: [chunk(USAGE)] })
      expect(next.usageObserved).toBe(true); expect(next.acceptedUsages).toHaveLength(0)
    }
  })
  it('rejects a message usage attributed to another provider', () => {
    const state = event(ready(), 2, 'assistant/message', { message: { source: { kind: 'model', provider: 'other', model: 'm' } }, usage: USAGE })
    expect(state.acceptedUsages).toHaveLength(0); expect(state.usageObserved).toBe(true)
  })
  it('requires stateOf actual session/header/cut to agree and never grants read capability', () => {
    const session = { id: HEADER.id, header: HEADER, inheritedEventCount: 0 }
    const host = { sessionProjections: { register() {}, stateOf: () => ready() } }
    expect(ownsCliRecordSession(host, session)).toBe(true)
    expect(cliRecordStateOf(host, { ...session, inheritedEventCount: 1 })).toBeUndefined()
    expect(cliRecordStateOf(host, { ...session, id: 'other' })).toBeUndefined()
    expect(ready()).not.toHaveProperty('token')
  })
  it('fails closed on missing, throwing, malformed or conflicting public projection services', () => {
    expect(installCliRecordProjection({})).toBeUndefined()
    expect(installCliRecordProjection({ sessionProjections: { register() { throw new Error('conflict') }, stateOf() {} } })).toBeUndefined()
    expect(cliRecordStateOf({ sessionProjections: { register() {}, stateOf() { throw new Error('stale') } } }, {})).toBeUndefined()
    expect(() => cliRecordProjectionDefinition().stateSchema.parse({})).toThrow()
  })
})
