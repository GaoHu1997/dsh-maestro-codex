import { describe, expect, it } from 'vitest'
import { CONFIG_DEFAULTS, effectiveOf } from '../src/config.js'
import { pickCli, routingHint, RoutingError } from '../src/routing.js'

function config(overrides: Partial<ReturnType<typeof effectiveOf>> = {}): ReturnType<typeof effectiveOf> {
  return { ...effectiveOf({}), ...overrides }
}

describe('pickCli', () => {
  it('honors an explicit request', () => {
    expect(pickCli(config(), 'claude', '随便什么').cli).toBe('claude')
    expect(pickCli(config(), 'codex', '随便什么').reason).toBe('requested')
  })

  it('rejects an unknown CLI name', () => {
    expect(() => pickCli(config(), 'gemini', 'x')).toThrow(RoutingError)
  })

  it('falls back when the requested CLI is disabled', () => {
    const cfg = config({ claude: { ...effectiveOf({}).claude, enabled: false } })
    const decision = pickCli(cfg, 'claude', 'x')
    expect(decision.cli).toBe('codex')
    expect(decision.note).toContain('回落')
  })

  it('fails when both CLIs are disabled', () => {
    const base = effectiveOf({})
    const cfg = config({
      claude: { ...base.claude, enabled: false },
      codex: { ...base.codex, enabled: false },
    })
    expect(() => pickCli(cfg, 'auto', 'x')).toThrow(/都未启用/)
  })

  it('routes by task-type keywords', () => {
    const cfg = effectiveOf({}) // defaults: 重构/测试/文档/分析/代码审查 → claude; 脚本/快速修复/批处理/原型 → codex
    expect(pickCli(cfg, 'auto', '帮我重构这个模块').cli).toBe('claude')
    expect(pickCli(cfg, 'auto', '写一个批量重命名的脚本').cli).toBe('codex')
    expect(pickCli(cfg, 'auto', '帮我重构并补个测试').reason).toBe('keyword')
  })

  it('uses the default CLI when nothing matches', () => {
    const decision = pickCli(config(), 'auto', '做点别的事情')
    expect(decision.reason).toBe('default')
    expect(decision.cli).toBe(CONFIG_DEFAULTS.defaultCli)
  })

  it('prefers the non-disabled CLI when the default is disabled', () => {
    const cfg = config({ codex: { ...effectiveOf({}).codex, enabled: false } })
    expect(pickCli(cfg, 'auto', '无命中任务').cli).toBe('claude')
  })
})

describe('routingHint', () => {
  it('lists enabled CLIs with their task types and models', () => {
    const hint = routingHint(effectiveOf({ claudeModel: 'claude-sonnet-4-5' }), 'dispatch_cli_task')
    expect(hint).toContain('dispatch_cli_task')
    expect(hint).toContain('claude cli')
    expect(hint).toContain('claude-sonnet-4-5')
    expect(hint).toContain('codex cli')
    expect(hint).toContain('重构')
  })

  it('is empty when the plugin is disabled', () => {
    expect(routingHint(config({ enabled: false }), 'dispatch_cli_task')).toBe('')
  })

  it('is empty when both CLIs are disabled', () => {
    const base = effectiveOf({})
    const cfg = config({
      claude: { ...base.claude, enabled: false },
      codex: { ...base.codex, enabled: false },
    })
    expect(routingHint(cfg, 'dispatch_cli_task')).toBe('')
  })
})
