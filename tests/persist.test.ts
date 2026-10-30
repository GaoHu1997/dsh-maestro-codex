import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskRegistry } from '../src/task-registry.js'
import { dshHomeOf, loadPersistedTasks, persistedOf, persistTask, prunePersisted, tasksDirOf } from '../src/persist.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'maestro-persist-'))
}

function settledTask(overrides: Partial<Parameters<typeof persistedOf>[0]> = {}): Parameters<typeof persistedOf>[0] {
  return {
    id: 'task-abcd1234',
    cli: 'codex',
    title: '数据处理任务',
    cwd: 'C:\\work\\repo',
    model: 'gpt-5-codex',
    sessionId: 'session-1',
    phase: 'done',
    startedAt: 1_000,
    endedAt: 4_000,
    exitCode: 0,
    finalText: '结论 42',
    stats: { outputTokens: 7 },
    events: [
      { seq: 1, at: 1_100, kind: 'phase', text: '已创建，等待调度' },
      { seq: 2, at: 1_200, kind: 'text', text: '结论 42' },
      { seq: 3, at: 4_000, kind: 'phase', text: '执行完成' },
    ],
    ...overrides,
  }
}

describe('persistedOf', () => {
  it('keeps the tail of the event ring and drops absent fields', () => {
    const record = persistedOf(settledTask(), 5_000, 2)
    expect(record.events.map(event => event.seq)).toEqual([2, 3])
    expect(record.savedAt).toBe(5_000)
    expect(record).not.toHaveProperty('error')
    const bare = persistedOf(settledTask({ cwd: undefined, sessionId: undefined, stats: undefined }), 5_000)
    expect(bare).not.toHaveProperty('cwd')
    expect(bare).not.toHaveProperty('sessionId')
    expect(bare).not.toHaveProperty('stats')
  })
})

describe('persistTask / loadPersistedTasks', () => {
  it('round-trips a settled task through disk and back into the registry', async () => {
    const dir = home()
    try {
      await persistTask(dir, settledTask(), { now: 5_000 })
      const loaded = await loadPersistedTasks(dir)
      expect(loaded).toHaveLength(1)
      expect(loaded[0]).toMatchObject({ id: 'task-abcd1234', cli: 'codex', phase: 'done', finalText: '结论 42', exitCode: 0 })

      const registry = new TaskRegistry()
      const restored = registry.restore(loaded[0]!)
      expect(restored?.phase).toBe('done')
      const summary = registry.list()[0]
      expect(summary).toMatchObject({ id: 'task-abcd1234', durationMs: 3_000 })
      // 事件尾被种回事件环，详情路由（eventsSince）有内容可给。
      const page = registry.eventsSince('task-abcd1234', 0)
      expect(page?.events.map(event => event.text)).toContain('结论 42')
      // 文件收在 maestro/tasks 下、收紧到 owner 权限位。
      const file = readFileSync(join(tasksDirOf(dir), 'task-abcd1234.json'), 'utf8')
      expect(file).toContain('"finalText": "结论 42"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips non-terminal phases and npm jobs', async () => {
    const dir = home()
    try {
      await persistTask(dir, settledTask({ phase: 'running' }))
      await persistTask(dir, settledTask({ id: 'npm-abcd1234' }))
      expect(await loadPersistedTasks(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prunes the oldest files beyond keep', async () => {
    const dir = home()
    try {
      mkdirSync(tasksDirOf(dir), { recursive: true })
      for (let index = 0; index < 5; index += 1) {
        const record = persistedOf(settledTask({ id: `task-0000000${String(index)}`, startedAt: 1_000 + index, endedAt: 2_000 + index }), 5_000)
        writeFileSync(join(tasksDirOf(dir), `task-0000000${String(index)}.json`), JSON.stringify(record), 'utf8')
      }
      await prunePersisted(tasksDirOf(dir), 3)
      const left = await loadPersistedTasks(dir, 10)
      expect(left.map(record => record.id).sort()).toEqual(['task-00000002', 'task-00000003', 'task-00000004'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('degrades to empty on a missing dir and skips corrupt files', async () => {
    expect(await loadPersistedTasks('D:/definitely/not/a/real/home-xyz')).toEqual([])
    const dir = home()
    try {
      mkdirSync(tasksDirOf(dir), { recursive: true })
      writeFileSync(join(tasksDirOf(dir), 'task-bad1.json'), '{not json', 'utf8')
      writeFileSync(join(tasksDirOf(dir), 'task-bad2.json'), JSON.stringify({ id: 'task-bad2', phase: 'running' }), 'utf8')
      await persistTask(dir, settledTask(), { now: 5_000 })
      const loaded = await loadPersistedTasks(dir)
      expect(loaded).toHaveLength(1)
      expect(loaded[0]?.id).toBe('task-abcd1234')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves the dsh home like the rest of the plugin', () => {
    expect(dshHomeOf({ DSH_HOME: '  C:\\custom\\dsh  ' })).toBe('C:\\custom\\dsh')
    expect(dshHomeOf({})).toContain('.dsh')
  })
})
