import { describe, expect, it } from 'vitest'
import { cleanLogText, LEGACY_TASK_TYPE_NAMES, normalizeTaskType, normalizeTaskTypes, TASK_TYPE_CATALOG, TASK_TYPE_DESCRIPTIONS, taskTypeKeywords } from '../src/wire.js'

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
  it('lists exactly the thirteen approved task names in order', () => {
    expect(TASK_TYPE_CATALOG).toEqual([
      '仓库探索', '代码定位', '资料检索', '方案核验', '影响分析',
      '功能开发', '缺陷修复', '测试验证', '代码审查', '数据处理',
      '模块重构', '方案设计', '文档整理',
    ])
    expect(new Set(TASK_TYPE_CATALOG).size).toBe(TASK_TYPE_CATALOG.length)
  })

  it('uses four Chinese characters and supplies a description for every type', () => {
    for (const type of TASK_TYPE_CATALOG) {
      expect(type).toMatch(/^\p{Script=Han}{4}$/u)
      expect(TASK_TYPE_DESCRIPTIONS.get(type)).toEqual(expect.any(String))
      expect(TASK_TYPE_DESCRIPTIONS.get(type)?.length).toBeGreaterThan(0)
    }
    expect(TASK_TYPE_DESCRIPTIONS.size).toBe(TASK_TYPE_CATALOG.length)
  })
})

describe('legacy task names', () => {
  it.each([...LEGACY_TASK_TYPE_NAMES])('maps %s to %s and preserves its routing keyword', (legacy, current) => {
    expect(normalizeTaskType(legacy)).toBe(current)
    expect(normalizeTaskType(current)).toBe(current)
    expect(taskTypeKeywords(current)).toEqual([current, legacy])
    expect(taskTypeKeywords(legacy)).toEqual([current, legacy])
  })

  it('deduplicates old/new names while preserving order and custom keywords', () => {
    const original = ['重构', '模块重构', '代码生成', 'custom', 'custom']
    expect(normalizeTaskTypes(original)).toEqual(['模块重构', '功能开发', 'custom'])
    expect(original).toEqual(['重构', '模块重构', '代码生成', 'custom', 'custom'])
    expect(normalizeTaskType('constructor')).toBe('constructor')
    expect(taskTypeKeywords('CustomKeyword')).toEqual(['CustomKeyword'])
  })
})
