import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CONFIG_HISTORY_VERSION, ConfigHistory, diffEffective, flattenEffective } from '../src/config-history.js'
import { effectiveOf } from '../src/config.js'

function fileOf(): string {
  return join(mkdtempSync(join(tmpdir(), 'maestro-config-history-')), 'config-history.json')
}

describe('flattenEffective', () => {
  it('flattens nested config into one string per field', () => {
    const flat = flattenEffective(effectiveOf({}))
    expect(flat['enabled']).toBe('true')
    expect(typeof flat['claude.minTaskDifficulty']).toBe('string')
    expect(flat['claude.taskTypes']).toContain('[')
  })

  it('never carries a secret into the history', () => {
    const flat = flattenEffective(effectiveOf({ claudeAuthToken: 'sk-secret-value', codexApiKey: 'sk-openai-value' }))
    expect(JSON.stringify(flat)).not.toContain('sk-secret-value')
    expect(JSON.stringify(flat)).not.toContain('sk-openai-value')
  })
})

describe('diffEffective', () => {
  it('labels the codes a reader cares about and leaves the rest as fieldChanged', () => {
    const changes = diffEffective(effectiveOf({}), effectiveOf({ enabled: false, claudeEnabled: false, maxConcurrentTasks: 5 }))
    const codes = changes.map(change => `${change.field}:${change.code}`)
    expect(codes).toContain('enabled:enabledOff')
    expect(codes).toContain('claude.enabled:cliDisabled')
    expect(codes).toContain('maxConcurrentTasks:fieldChanged')
    expect(changes.map(change => change.field)).toEqual([...changes.map(change => change.field)].sort())
  })

  it('is empty when nothing changed', () => {
    expect(diffEffective(effectiveOf({}), effectiveOf({}))).toEqual([])
  })
})

describe('ConfigHistory', () => {
  it('records only real changes', async () => {
    let now = 1_000
    const history = new ConfigHistory({ now: () => now })
    expect(await history.record(effectiveOf({}))).toEqual([])
    expect(history.entriesOf()).toHaveLength(1)
    now += 1_000
    expect(await history.record(effectiveOf({}))).toEqual([])
    expect(history.entriesOf()).toHaveLength(1)
    now += 1_000
    const changes = await history.record(effectiveOf({ maxConcurrentTasks: 4 }))
    expect(changes.map(change => change.field)).toContain('maxConcurrentTasks')
    expect(history.entriesOf()).toHaveLength(2)
    expect(history.latestChanges().map(change => change.field)).toContain('maxConcurrentTasks')
  })

  it('does not let polling fill the history with identical snapshots', async () => {
    let now = 0
    const history = new ConfigHistory({ now: () => now, debounceMs: 10 })
    await history.record(effectiveOf({}))
    for (let tick = 0; tick < 5; tick += 1) {
      now += 100
      await history.record(effectiveOf({}))
    }
    expect(history.entriesOf()).toHaveLength(1)
  })

  it('persists snapshots and reads them back', async () => {
    const file = fileOf()
    const first = new ConfigHistory({ file })
    await first.record(effectiveOf({ maxConcurrentTasks: 2 }))
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { version: number; entries: unknown[] }
    expect(stored.version).toBe(CONFIG_HISTORY_VERSION)
    const second = new ConfigHistory({ file })
    await second.load()
    expect(second.entriesOf()).toHaveLength(1)
    // 读回之后同一份配置不再产生新快照。
    expect(await second.record(effectiveOf({ maxConcurrentTasks: 2 }))).toEqual([])
  })

  it('keeps only the newest snapshots', async () => {
    const history = new ConfigHistory({ keep: 2 })
    await history.record(effectiveOf({ maxConcurrentTasks: 2 }))
    await history.record(effectiveOf({ maxConcurrentTasks: 3 }))
    await history.record(effectiveOf({ maxConcurrentTasks: 4 }))
    expect(history.entriesOf()).toHaveLength(2)
  })

  it('warns and starts empty on an unreadable file', async () => {
    const file = fileOf()
    writeFileSync(file, 'not json', 'utf8')
    const onWarn = vi.fn()
    const history = new ConfigHistory({ file, onWarn })
    await history.load()
    expect(history.entriesOf()).toEqual([])
    expect(onWarn).toHaveBeenCalled()
  })
})
