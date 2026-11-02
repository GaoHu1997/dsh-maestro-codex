import { describe, expect, it, vi } from 'vitest'
import { createAccountingService } from '../src/accounting-service.js'
import { SessionAccessRegistry, installSessionAccessProjection } from '../src/session-access.js'
import { UsageJournal } from '../src/usage-journal.js'
import { CLI_USAGE_EVENT, EMPTY_CLI_USAGE, applyCliUsage, cliUsageRecordOf } from '../src/usage.js'
import type { MaestroSessionAccess } from '../src/wire.js'

/** Real service and registry; the journal boundary is controlled without filesystem I/O. */
function fixture() {
  const registry = new SessionAccessRegistry()
  type Projection = { init(header: unknown, inheritedEventCount: number): unknown; wire: { view(state: unknown): MaestroSessionAccess | null } }
  let registered: Projection | undefined
  installSessionAccessProjection({ sessionProjections: { register(value: unknown) { registered = value as Projection } } }, registry)
  if (registered === undefined) throw new Error('test access projection was not registered')
  const projection = registered
  const records = ['owner-A', 'owner-B'].map((sessionId, index) => cliUsageRecordOf({
    id: `task-${sessionId}`, cli: 'claude', model: 'test-model', phase: 'done', sessionId,
    startedAt: 1_000 + index, endedAt: 2_000 + index, exitCode: 0, error: undefined,
    stats: { inputTokens: 10 + index, outputTokens: 4, cachedInputTokens: 2, cacheWriteTokens: 1 },
  }))
  const journal = new UsageJournal('test-unused-no-io')
  const refresh = vi.spyOn(journal, 'refresh').mockResolvedValue()
  const settlements = vi.spyOn(journal, 'recordsFor').mockImplementation(owner => structuredClone(records.filter(record => record.sessionId === owner)))
  const snapshot = vi.spyOn(journal, 'snapshot').mockImplementation(owner => records.filter(record => record.sessionId === owner)
    .reduce((state, record) => applyCliUsage(state, { type: CLI_USAGE_EVENT, data: record }), EMPTY_CLI_USAGE))
  const service = createAccountingService(journal, registry)
  // This simulates a host-authorized feed; the public accounting service cannot mint capabilities.
  const delivered = (owner: string) => {
    const value = projection.wire.view(projection.init({ id: owner }, 0))
    if (value === null) throw new Error('test authorized projection did not deliver a capability')
    return value
  }
  return { registry, projection, service, refresh, settlements, snapshot, delivered }
}

describe('accounting reads consume only current host-projected capabilities', () => {
  it('isolates full settlement history and snapshots across authorized sessions', async () => {
    const f = fixture(), a = f.delivered('owner-A'), b = f.delivered('owner-B')
    const [readA, readB, historyA, historyB] = await Promise.all([
      f.service.read(a), f.service.read(b), f.service.settlements(a), f.service.settlements(b),
    ])
    expect(readA.sessionId).toBe('owner-A')
    expect(readB.sessionId).toBe('owner-B')
    expect(readA.usage.totals.inputTokens).toBe(10)
    expect(readB.usage.totals.inputTokens).toBe(11)
    expect(historyA.map(record => record.sessionId)).toEqual(['owner-A'])
    expect(historyB.map(record => record.sessionId)).toEqual(['owner-B'])
  })
  it.each(['read', 'settlements'] as const)('%s rejects raw IDs, fake bearers and another session paired with a valid token', async method => {
    const f = fixture(), a = f.delivered('owner-A')
    for (const supplied of [undefined, 'owner-A', a.token, { sessionId: 'owner-A' },
      { sessionId: 'owner-A', token: 'a'.repeat(64) }, { sessionId: 'owner-B', token: a.token }]) {
      await expect(f.service[method](supplied)).rejects.toThrow('未获得该父会话的用量读取授权')
    }
    expect(f.refresh).not.toHaveBeenCalled()
    expect(f.snapshot).not.toHaveBeenCalled()
    expect(f.settlements).not.toHaveBeenCalled()
  })
  it.each(['read', 'settlements'] as const)('%s revokes old access after live replacement and after clear', async method => {
    const f = fixture(), first = { id: 'owner-A', append: vi.fn() }
    f.registry.publish(first.id, first)
    const previous = f.delivered(first.id)
    await expect(f.service[method](previous)).resolves.toBeDefined()
    f.registry.publish(first.id, { id: first.id, append: vi.fn() })
    await expect(f.service[method](previous)).rejects.toThrow('未获得该父会话的用量读取授权')
    const current = f.delivered(first.id)
    await expect(f.service[method](current)).resolves.toBeDefined()
    f.registry.clear()
    await expect(f.service[method](current)).rejects.toThrow('未获得该父会话的用量读取授权')
    await expect(f.service[method](f.delivered(first.id))).resolves.toBeDefined()
    expect(first.append).not.toHaveBeenCalled()
  })
  it.each(['read', 'settlements'] as const)('%s cannot reuse an old registry token after a restart', async method => {
    const before = fixture(), old = before.delivered('owner-A')
    const after = fixture()
    const current = after.delivered('owner-A')
    expect(current.token).not.toBe(old.token)
    await expect(after.service[method](old)).rejects.toThrow('未获得该父会话的用量读取授权')
    expect(after.refresh).not.toHaveBeenCalled()
    await expect(after.service[method](current)).resolves.toBeDefined()
  })
  it.each(['read', 'settlements'] as const)('%s rechecks authorization after the asynchronous journal refresh', async method => {
    const f = fixture(), access = f.delivered('owner-A')
    let release!: () => void
    f.refresh.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const result = f.service[method](access)
    const revoked = expect(result).rejects.toThrow('父会话读取授权已撤销')
    f.registry.clear()
    release()
    await revoked
    expect(f.snapshot).not.toHaveBeenCalled()
    expect(f.settlements).not.toHaveBeenCalled()
  })
})
