import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { cliMinTaskDifficulty, MaestroForm, type SectionValue } from '../src/client/form.js'
import type { ConfigFormFace } from '../src/client/types.js'
import { CliDifficultySelect, TASK_DIFFICULTY_OPTIONS } from '../src/client/MaestroCard.js'
import { CLI_LABELS, MAESTRO_CLI_IDS } from '../src/wire.js'

function formHarness(initial: SectionValue = {}) {
  let value = initial
  const listeners = new Set<() => void>()
  const set = vi.fn(async (field: string, next: unknown) => {
    value = { ...value, [field]: next }
    for (const listener of listeners) listener()
  })
  const scope: ConfigFormFace<SectionValue> = {
    getSnapshot: () => ({ status: 'ready', writable: true, value }),
    set,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { form: new MaestroForm(scope), set }
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
      await Promise.resolve()
      expect(set).toHaveBeenCalledExactlyOnceWith(field, level)
      const snapshot = form.bind().getSnapshot()
      expect(snapshot.values[field]).toBe(level)
      expect(snapshot.values[otherField]).toBe('high')
      expect(snapshot.values.minTaskDifficulty).toBe('extreme')
      expect(snapshot.dirty).toEqual([])
    })

    it(`${field} does not persist an unchanged difficulty again`, () => {
      const { form, set } = formHarness({ [field]: 'medium' })
      form.actions().setImmediate(field, 'medium')
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
    const values: SectionValue = { claudeMinTaskDifficulty: 'low', codexMinTaskDifficulty: 'extreme' }
    const html = renderToStaticMarkup(createElement(CliDifficultySelect, { cli, values, onChange: () => {} }))
    expect(html).toContain(`${CLI_LABELS[cli]} 最低任务难度`)
    expect(html).toContain(`value="${cli === 'claude' ? 'low' : 'extreme'}" selected=""`)
    expect(html).toContain('仅控制此 CLI')
    for (const option of TASK_DIFFICULTY_OPTIONS) expect(html).toContain(`>${option.label}</option>`)
  })

  it.each(MAESTRO_CLI_IDS)('renders inherited legacy difficulty for %s instead of silently resetting it', cli => {
    const html = renderToStaticMarkup(createElement(CliDifficultySelect, { cli, values: { minTaskDifficulty: 'high' }, onChange: () => {} }))
    expect(html).toContain('value="high" selected=""')
  })
})
