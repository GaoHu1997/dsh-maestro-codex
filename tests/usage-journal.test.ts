import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { UsageJournal } from '../src/usage-journal.js'
import { CLI_USAGE_EVENT, clearCliUsageMirrors, cliUsageProjectionDefinition, cliUsageRecordOf, type CliUsageTask } from '../src/usage.js'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'maestro-journal-compat-')); clearCliUsageMirrors() })
afterEach(async () => { clearCliUsageMirrors(); await rm(home, { recursive: true, force: true }) })
const task = (sessionId = 'parent-A'): CliUsageTask => ({
  id: 'durable-task', cli: 'claude', model: 'model', phase: 'done', sessionId,
  startedAt: 1000, endedAt: 2000, exitCode: 0, error: undefined,
  stats: { inputTokens: 10, outputTokens: 3, usageInputSemantics: 'uncached' },
})

describe('canonical journal and restart-safe display mirrors', () => {
  it('retains every settlement across a new journal instance without a Session event', async () => {
    const journal = new UsageJournal(home)
    await journal.begin(task())
    await journal.settle(task())
    const parent = Session.create('parent-A')
    const append = vi.spyOn(parent, 'append')
    const flush = vi.fn(async () => true)
    expect(await journal.publish(parent, parent.id, flush)).toBe(1)
    expect(await journal.publish(parent, parent.id, flush)).toBe(0)
    expect(append).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    expect(parent.seq).toBe(0)
    expect(journal.status().hostFlushAcknowledged).toBe(0)
    const files = (await readdir(journal.directory)).filter(name => !name.startsWith('.'))
    expect(files).toHaveLength(1)
    expect(JSON.parse(await readFile(join(journal.directory, files[0]!), 'utf8')).record.sessionId).toBe('parent-A')

    clearCliUsageMirrors()
    const restarted = new UsageJournal(home)
    await restarted.load()
    expect(restarted.status()).toMatchObject({ records: 1, incomplete: 0, corrupt: 0 })
    expect(restarted.snapshot('parent-A').totals.requests).toBe(1)
    expect(restarted.snapshot('parent-B').totals.requests).toBe(0)
    const reloadedParent = Session.create('parent-A')
    expect(await restarted.publish(reloadedParent, 'parent-A')).toBe(1)
    expect(reloadedParent.seq).toBe(0)
    const definition = cliUsageProjectionDefinition(id => restarted.recordsFor(id))
    expect(definition.wire.view(definition.init({ id: 'parent-A' }, 0)).totals).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 3 })
  })

  it('derives the view from canonical data without persisting the mirror or crossing owners', async () => {
    const journal = new UsageJournal(home)
    await journal.settle(task())
    await journal.settle({ ...task('parent-B'), id: 'other-task' })
    const definition = cliUsageProjectionDefinition(id => journal.recordsFor(id))
    const state = definition.init({ id: 'parent-A' }, 0)
    const serialized = JSON.stringify(state)
    expect(state.totals.requests).toBe(0)
    expect(definition.wire.view(state).totals.requests).toBe(1)
    expect(JSON.stringify(state)).toBe(serialized)
    expect(definition.wire.view(definition.init({ id: 'unknown-parent' }, 0)).totals.requests).toBe(0)
    const legacy = definition.apply(state, { type: CLI_USAGE_EVENT, data: cliUsageRecordOf(task()) })
    expect(definition.wire.view(legacy).totals.requests).toBe(1)
    expect(definition.wire.view(definition.apply(state, { type: CLI_USAGE_EVENT, data: cliUsageRecordOf(task('parent-B')) })).totals.requests).toBe(1)
    await expect(journal.publish(Session.create('parent-B'), 'parent-A')).rejects.toThrow('不属于')
    expect(journal.status().records).toBe(2)
  })
})
