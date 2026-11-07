import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { cliMinTaskDifficulty, MaestroForm, type SectionValue } from '../src/client/form.js'
import type { ConfigFormFace, ConfigFormOp } from '../src/client/types.js'
import { CliDifficultySelect, TASK_DIFFICULTY_OPTIONS } from '../src/client/MaestroCard.js'
import { CLI_LABELS, MAESTRO_CLI_IDS } from '../src/wire.js'

/** Let the write queue drain: queue hop → commit → host answer → publish. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
}

function formHarness(
  initial: SectionValue = {},
  options: { writable?: boolean; mutate?: boolean } = {},
) {
  let value = initial
  const listeners = new Set<() => void>()
  const apply = (ops: readonly ConfigFormOp[]): void => {
    const next: Record<string, unknown> = { ...value }
    for (const op of ops) next[op.path[0]!] = op.value
    value = next as SectionValue
  }
  const set = vi.fn(async (field: string, next: unknown) => {
    apply([{ op: 'set', path: [field], value: next }])
    for (const listener of listeners) listener()
    return true
  })
  const mutate = vi.fn(async (ops: readonly ConfigFormOp[]) => {
    apply(ops)
    for (const listener of listeners) listener()
    return true
  })
  const scope: ConfigFormFace<SectionValue> = {
    getSnapshot: () => ({ status: 'ready', writable: options.writable ?? true, value }),
    set,
    ...(options.mutate === false ? {} : { mutate }),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { form: new MaestroForm(scope), set, mutate }
}

const fields = ['claudeMinTaskDifficulty', 'codexMinTaskDifficulty'] as const

describe('independent CLI difficulty configuration', () => {
  it('offers all four levels with Chinese labels in ascending order', () => {
    expect(TASK_DIFFICULTY_OPTIONS).toEqual([
      { value: 'low', label: '低' }, { value: 'medium', label: '中' },
      { value: 'high', label: '高' }, { value: 'extreme', label: '极高' },
    ])
  })

  for (const field of fields) {
    const otherField = field === 'claudeMinTaskDifficulty' ? 'codexMinTaskDifficulty' : 'claudeMinTaskDifficulty'
    it.each(['low', 'medium', 'high', 'extreme'] as const)(`${field} persists %s immediately without changing the other CLI`, async level => {
      const { form, set } = formHarness({ [otherField]: 'high', minTaskDifficulty: 'extreme' })
      form.actions().setImmediate(field, level)
      await flush()
      expect(set).toHaveBeenCalledExactlyOnceWith(field, level)
      const snapshot = form.bind().getSnapshot()
      expect(snapshot.values[field]).toBe(level)
      expect(snapshot.values[otherField]).toBe('high')
      expect(snapshot.values.minTaskDifficulty).toBe('extreme')
      expect(snapshot.dirty).toEqual([])
    })

    it(`${field} does not persist an unchanged difficulty again`, async () => {
      const { form, set } = formHarness({ [field]: 'medium' })
      form.actions().setImmediate(field, 'medium')
      await flush()
      expect(set).not.toHaveBeenCalled()
    })
  }

  it('defaults both CLIs to medium and inherits legacy values only until overridden', () => {
    for (const cli of MAESTRO_CLI_IDS) {
      expect(cliMinTaskDifficulty({}, cli)).toBe('medium')
      expect(cliMinTaskDifficulty({ minTaskDifficulty: 'extreme' }, cli)).toBe('extreme')
    }
    const values: SectionValue = { minTaskDifficulty: 'extreme', claudeMinTaskDifficulty: 'low' }
    expect(cliMinTaskDifficulty(values, 'claude')).toBe('low')
    expect(cliMinTaskDifficulty(values, 'codex')).toBe('extreme')
    values.codexMinTaskDifficulty = 'high'
    expect(cliMinTaskDifficulty(values, 'claude')).toBe('low')
    expect(cliMinTaskDifficulty(values, 'codex')).toBe('high')
  })

  it.each(MAESTRO_CLI_IDS)('renders the %s selector with only its own selected threshold', cli => {
    const values: SectionValue = { claudeMinTaskDifficulty: 'low', codexMinTaskDifficulty: 'extreme', grokMinTaskDifficulty: 'high' }
    const html = renderToStaticMarkup(createElement(CliDifficultySelect, { cli, values, onChange: () => {} }))
    expect(html).toContain(`${CLI_LABELS[cli]} 最低任务难度`)
    expect(html).toContain(`value="${cli === 'claude' ? 'low' : cli === 'grok' ? 'high' : 'extreme'}" selected=""`)
    expect(html).toContain('仅控制此 CLI')
    for (const option of TASK_DIFFICULTY_OPTIONS) expect(html).toContain(`>${option.label}</option>`)
  })

  it.each(MAESTRO_CLI_IDS)('renders inherited legacy difficulty for %s instead of silently resetting it', cli => {
    const html = renderToStaticMarkup(createElement(CliDifficultySelect, { cli, values: { minTaskDifficulty: 'high' }, onChange: () => {} }))
    expect(html).toContain('value="high" selected=""')
  })
})

describe('a task type belongs to exactly one CLI', () => {
  it('shows only current names without persisting a migration on read', () => {
    const initial = { claudeTaskTypes: ['重构', '模块重构', '自定义'], codexTaskTypes: ['代码生成', '调试修复'] }
    const { form, set, mutate } = formHarness(initial)
    const values = form.bind().getSnapshot().values
    expect(values.claudeTaskTypes).toEqual(['模块重构', '自定义'])
    expect(values.codexTaskTypes).toEqual(['功能开发', '缺陷修复'])
    expect(initial.claudeTaskTypes).toEqual(['重构', '模块重构', '自定义'])
    expect(set).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('moves a current name from a legacy selection in one batch', async () => {
    const { form, mutate } = formHarness({ claudeTaskTypes: [], codexTaskTypes: ['重构', '自定义'] })
    form.actions().toggleTaskType('claude', '模块重构')
    await flush()
    expect(mutate).toHaveBeenCalledExactlyOnceWith([
      { op: 'set', path: ['claudeTaskTypes'], value: ['模块重构'] },
      { op: 'set', path: ['codexTaskTypes'], value: ['自定义'] },
    ])
    expect(form.bind().getSnapshot().values.claudeTaskTypes).toEqual(['模块重构'])
    expect(form.bind().getSnapshot().values.codexTaskTypes).toEqual(['自定义'])
  })

  it('accepts a legacy toggle without adding an old/new duplicate', async () => {
    const { form, set } = formHarness({ claudeTaskTypes: ['重构'], codexTaskTypes: [] })
    form.actions().toggleTaskType('claude', '重构')
    await flush()
    expect(set).toHaveBeenCalledExactlyOnceWith('claudeTaskTypes', [])
    expect(form.bind().getSnapshot().values.claudeTaskTypes).toEqual([])
  })

  it('moves a type off the other CLI in the same write', async () => {
    const { form, mutate } = formHarness({
      claudeTaskTypes: ['方案设计'],
      codexTaskTypes: ['代码审查', '缺陷修复'],
    })
    form.actions().toggleTaskType('claude', '代码审查')
    await flush()
    expect(mutate).toHaveBeenCalledExactlyOnceWith([
      { op: 'set', path: ['claudeTaskTypes'], value: ['方案设计', '代码审查'] },
      { op: 'set', path: ['codexTaskTypes'], value: ['缺陷修复'] },
    ])
    const snapshot = form.bind().getSnapshot()
    expect(snapshot.values.claudeTaskTypes).toEqual(['方案设计', '代码审查'])
    expect(snapshot.values.codexTaskTypes).toEqual(['缺陷修复'])
    expect(snapshot.notice?.tone).toBe('info')
    expect(snapshot.notice?.text).toContain('代码审查')
    expect(snapshot.notice?.text).toContain('codex')
  })

  it('removes a type from its own CLI alone when the other CLI never had it', async () => {
    const { form, set, mutate } = formHarness({ claudeTaskTypes: ['方案设计'], codexTaskTypes: ['缺陷修复'] })
    form.actions().toggleTaskType('claude', '方案设计')
    await flush()
    expect(set).toHaveBeenCalledExactlyOnceWith('claudeTaskTypes', [])
    expect(mutate).not.toHaveBeenCalled()
    expect(form.bind().getSnapshot().values.claudeTaskTypes).toEqual([])
  })

  it('shows the moved type on screen before the host answers', async () => {
    const { form } = formHarness({ claudeTaskTypes: [], codexTaskTypes: ['代码审查'] })
    form.actions().toggleTaskType('codex', '代码审查')
    // Nothing awaited yet: the click must not look ignored.
    const pending = form.bind().getSnapshot().values
    expect(pending.codexTaskTypes).toEqual([])
    await flush()
    expect(form.bind().getSnapshot().values.codexTaskTypes).toEqual([])
  })

  it('replays fast clicks in order instead of losing the first one', async () => {
    const { form } = formHarness({ claudeTaskTypes: [], codexTaskTypes: [] })
    const actions = form.actions()
    actions.toggleTaskType('claude', '方案设计')
    actions.toggleTaskType('claude', '代码审查')
    await flush()
    expect(form.bind().getSnapshot().values.claudeTaskTypes).toEqual(['方案设计', '代码审查'])
  })

  it('drops the write when both CLIs already list the type and the user unchecks it', async () => {
    const { form } = formHarness({ claudeTaskTypes: ['代码审查'], codexTaskTypes: ['代码审查'] })
    form.actions().toggleTaskType('claude', '代码审查')
    await flush()
    const values = form.bind().getSnapshot().values
    expect(values.claudeTaskTypes).toEqual([])
    // The other side is untouched by an uncheck — it never promised anything.
    expect(values.codexTaskTypes).toEqual(['代码审查'])
  })
})

describe('immediate writes are never silently dropped', () => {
  it('restores the previous value and says which field refused to save', async () => {
    const { form, set } = formHarness({ codexSandbox: 'workspace-write' })
    set.mockResolvedValueOnce(false)
    form.actions().setImmediate('codexSandbox', 'danger-full-access')
    expect(form.bind().getSnapshot().values.codexSandbox).toBe('danger-full-access')
    await flush()
    const snapshot = form.bind().getSnapshot()
    expect(snapshot.values.codexSandbox).toBe('workspace-write')
    expect(snapshot.notice?.tone).toBe('error')
    expect(snapshot.notice?.text).toContain('codex 沙箱')
    expect(snapshot.notice?.text).toContain('恢复')
  })

  it('names the read-only config when the host is not writable', async () => {
    const { form, set } = formHarness({ codexSandbox: 'workspace-write' }, { writable: false })
    set.mockResolvedValueOnce(false)
    form.actions().setImmediate('codexSandbox', 'read-only')
    await flush()
    expect(form.bind().getSnapshot().notice?.text).toContain('只读')
  })

  it('keeps both task lists honest when the batch is refused', async () => {
    const { form, mutate } = formHarness({ claudeTaskTypes: [], codexTaskTypes: ['代码审查'] })
    mutate.mockResolvedValueOnce(false)
    form.actions().toggleTaskType('claude', '代码审查')
    await flush()
    const snapshot = form.bind().getSnapshot()
    expect(snapshot.values.claudeTaskTypes).toEqual([])
    expect(snapshot.values.codexTaskTypes).toEqual(['代码审查'])
    expect(snapshot.notice?.tone).toBe('error')
  })

  it('falls back to one write per field when the host exposes no mutate', async () => {
    const { form, set } = formHarness(
      { claudeTaskTypes: [], codexTaskTypes: ['代码审查'] },
      { mutate: false },
    )
    form.actions().toggleTaskType('claude', '代码审查')
    await flush()
    expect(set.mock.calls).toEqual([
      ['claudeTaskTypes', ['代码审查']],
      ['codexTaskTypes', []],
    ])
    const values = form.bind().getSnapshot().values
    expect(values.claudeTaskTypes).toEqual(['代码审查'])
    expect(values.codexTaskTypes).toEqual([])
  })

  it('takes a type away from the dsh fallback in the same batch', async () => {
    const { form, mutate } = formHarness({ claudeTaskTypes: ['方案设计'], dshTaskTypes: ['资料检索'] })
    form.actions().toggleTaskType('claude', '资料检索')
    await flush()
    expect(mutate).toHaveBeenCalledExactlyOnceWith([
      { op: 'set', path: ['claudeTaskTypes'], value: ['方案设计', '资料检索'] },
      { op: 'set', path: ['dshTaskTypes'], value: [] },
    ])
    const snapshot = form.bind().getSnapshot()
    expect(snapshot.values.claudeTaskTypes).toEqual(['方案设计', '资料检索'])
    expect(snapshot.values.dshTaskTypes).toEqual([])
    expect(snapshot.notice?.text).toContain('dsh 子代理')
  })

  it('takes a type onto dsh from both CLIs at once', async () => {
    const { form, mutate } = formHarness({ claudeTaskTypes: ['模块重构'], codexTaskTypes: ['模块重构'], dshTaskTypes: [] })
    form.actions().toggleTaskType('dsh', '模块重构')
    await flush()
    expect(mutate).toHaveBeenCalledExactlyOnceWith([
      { op: 'set', path: ['dshTaskTypes'], value: ['模块重构'] },
      { op: 'set', path: ['claudeTaskTypes'], value: [] },
      { op: 'set', path: ['codexTaskTypes'], value: [] },
    ])
    const snapshot = form.bind().getSnapshot()
    expect(snapshot.values.dshTaskTypes).toEqual(['模块重构'])
    expect(snapshot.values.claudeTaskTypes).toEqual([])
    expect(snapshot.values.codexTaskTypes).toEqual([])
    expect(snapshot.notice?.text).toContain('claude cli')
    expect(snapshot.notice?.text).toContain('codex cli')
  })
})
