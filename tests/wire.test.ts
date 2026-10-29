import { describe, expect, it } from 'vitest'
import { cleanLogText, TASK_TYPE_CATALOG } from '../src/wire.js'

describe('cleanLogText', () => {
  it('strips CSI colour sequences', () => {
    expect(cleanLogText('\u001b[31merror\u001b[0m done')).toBe('error done')
  })

  it('strips OSC title sequences', () => {
    expect(cleanLogText('\u001b]0;title\u0007ok')).toBe('ok')
  })

  it('drops control bytes but keeps newlines and tabs', () => {
    expect(cleanLogText('a\r\nb\u0000c\tz')).toBe('a\nbc\tz')
  })

  it('keeps ordinary unicode intact', () => {
    expect(cleanLogText('重构 ✓ done')).toBe('重构 ✓ done')
  })
})

describe('TASK_TYPE_CATALOG', () => {
  it('lists distinct default task types', () => {
    expect(TASK_TYPE_CATALOG).toContain('重构')
    expect(TASK_TYPE_CATALOG).toContain('代码审查')
    expect(new Set(TASK_TYPE_CATALOG).size).toBe(TASK_TYPE_CATALOG.length)
  })
})
