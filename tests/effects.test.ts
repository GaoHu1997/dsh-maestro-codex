import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EFFECT_SPECS, EFFECTS_VERSION, FAILURES_BEFORE_ERROR, EffectQueue, Later, backoffOf } from '../src/effects.js'

function fileOf(): string {
  return join(mkdtempSync(join(tmpdir(), 'maestro-effects-')), 'effects.json')
}

describe('EffectQueue', () => {
  it('persists one row per kind+key and bumps the generation on re-enqueue', async () => {
    const file = fileOf()
    const queue = new EffectQueue({ file })
    const first = await queue.enqueue('launch', 'task-1', { taskId: 'task-1' })
    expect(first.generation).toBe(1)
    const second = await queue.enqueue('launch', 'task-1', { taskId: 'task-1', prompt: '再来' })
    expect(second.generation).toBe(2)
    expect(queue.size()).toBe(1)
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { version: number; rows: Array<{ key: string; value: Record<string, unknown> }> }
    expect(stored.version).toBe(EFFECTS_VERSION)
    expect(stored.rows).toHaveLength(1)
    expect(stored.rows[0]?.value['prompt']).toBe('再来')
  })

  it('only hands out rows that are due, and never more than the kind limit', async () => {
    let now = 1_000
    const queue = new EffectQueue({ now: () => now })
    const limit = EFFECT_SPECS.launch.limit
    for (let index = 0; index < limit + 2; index += 1) await queue.enqueue('launch', `task-${String(index)}`, {})
    expect(queue.pending('launch')).toHaveLength(limit)
    const [row] = queue.pending('launch')
    if (row === undefined) throw new Error('expected a pending row')
    await queue.fail('launch', row.key, '一时失败')
    // 退避把这一行推到将来：到期前不再出现在可尝试集合里。
    now += 1_000
    expect(queue.pending('launch').map(item => item.key)).not.toContain(row.key)
    now += backoffOf(EFFECT_SPECS.launch, 1)
    expect(queue.pending('launch').map(item => item.key)).toContain(row.key)
  })

  it('backs off exponentially up to the configured ceiling', () => {
    const spec = EFFECT_SPECS.launch
    expect(backoffOf(spec, 1)).toBe(spec.retry[0])
    expect(backoffOf(spec, 2)).toBe(spec.retry[0] * 2)
    expect(backoffOf(spec, 99)).toBe(spec.retry[1])
  })

  it('stops scheduling after three failures and reports each give-up once', async () => {
    const onGiveUp = vi.fn()
    const queue = new EffectQueue({ onGiveUp })
    await queue.enqueue('launch', 'task-1', {})
    for (let attempt = 1; attempt <= FAILURES_BEFORE_ERROR; attempt += 1) {
      await queue.fail('launch', 'task-1', `第 ${String(attempt)} 次失败`)
    }
    expect(onGiveUp).toHaveBeenCalledTimes(1)
    expect(onGiveUp.mock.calls[0]?.[0]).toMatchObject({ key: 'task-1', attempts: FAILURES_BEFORE_ERROR })
    expect(queue.dead('launch').map(row => row.key)).toEqual(['task-1'])
    expect(queue.pending('launch')).toEqual([])
  })

  it('ignores a settle whose generation is stale', async () => {
    const queue = new EffectQueue()
    const first = await queue.enqueue('launch', 'task-1', {})
    await queue.enqueue('launch', 'task-1', {})
    expect(await queue.settle('launch', 'task-1', first.generation)).toBe(false)
    expect(queue.size()).toBe(1)
    expect(await queue.settle('launch', 'task-1')).toBe(true)
    expect(queue.size()).toBe(0)
  })

  it('keeps unfinished rows across drain and load — that is the whole point', async () => {
    const file = fileOf()
    const queue = new EffectQueue({ file })
    await queue.enqueue('launch', 'task-1', { taskId: 'task-1', prompt: '没跑完' })
    await queue.drain()
    const reopened = new EffectQueue({ file })
    await reopened.load()
    expect(reopened.entries('launch').map(row => row.key)).toEqual(['task-1'])
    expect(reopened.entries('launch')[0]?.value['prompt']).toBe('没跑完')
  })

  it('drops an unreadable file with a warning instead of taking the plugin down', async () => {
    const file = fileOf()
    writeFileSync(file, '{ not json', 'utf8')
    const onWarn = vi.fn()
    const queue = new EffectQueue({ file, onWarn })
    await queue.load()
    expect(queue.size()).toBe(0)
    expect(onWarn).toHaveBeenCalled()
  })

  it('recognises the later-not-failed sentinel by name', () => {
    const later = new Later()
    expect(later.name).toBe('Later')
    expect(later).toBeInstanceOf(Error)
  })
})
