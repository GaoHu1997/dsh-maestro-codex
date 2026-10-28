import { describe, expect, it } from 'vitest'
import { CONFIG_DEFAULTS, effectiveOf, redactEffective, validateConfig, type Config } from '../src/config.js'

describe('validateConfig', () => {
  it('accepts an empty config and the shipped defaults', () => {
    expect(() => validateConfig({})).not.toThrow()
    expect(() => validateConfig({ ...CONFIG_DEFAULTS })).not.toThrow()
  })

  it('rejects unknown keys', () => {
    expect(() => validateConfig({ nope: true } as unknown as Config)).toThrow(/unknown key "nope"/)
  })

  it('rejects bad enums and ranges', () => {
    expect(() => validateConfig({ defaultCli: 'gemini' })).toThrow(/defaultCli/)
    expect(() => validateConfig({ claudePermissionMode: 'yolo' })).toThrow(/claudePermissionMode/)
    expect(() => validateConfig({ codexSandbox: 'off' })).toThrow(/codexSandbox/)
    expect(() => validateConfig({ claudeTimeoutMinutes: 0 })).toThrow(/claudeTimeoutMinutes/)
    expect(() => validateConfig({ maxConcurrentTasks: 9 })).toThrow(/maxConcurrentTasks/)
    expect(() => validateConfig({ npmRegistry: 'ftp://x' })).toThrow(/npmRegistry/)
  })
})

describe('effectiveOf', () => {
  it('layers defaults under absent keys', () => {
    const effective = effectiveOf({})
    expect(effective.enabled).toBe(true)
    expect(effective.defaultCli).toBe('claude')
    expect(effective.claude.permissionMode).toBe('inherit')
    expect(effective.codex.sandbox).toBe('workspace-write')
    expect(effective.maxConcurrentTasks).toBe(2)
  })

  it('applies provided values', () => {
    const effective = effectiveOf({ defaultCli: 'codex', claudeModel: 'claude-sonnet-4-5', maxConcurrentTasks: 3 })
    expect(effective.defaultCli).toBe('codex')
    expect(effective.claude.model).toBe('claude-sonnet-4-5')
    expect(effective.maxConcurrentTasks).toBe(3)
  })

  it('falls back to the default on an out-of-enum value', () => {
    const effective = effectiveOf({ defaultCli: 'yolo' })
    expect(effective.defaultCli).toBe(CONFIG_DEFAULTS.defaultCli)
  })
})

describe('redactEffective', () => {
  it('masks tokens but keeps other fields readable', () => {
    const effective = effectiveOf({ claudeAuthToken: 'sk-secret', codexApiKey: 'sk-openai', claudeModel: 'm1' })
    const redacted = redactEffective(effective)
    expect(redacted.claude.authToken).toBe('••••')
    expect(redacted.codex.apiKey).toBe('••••')
    expect(redacted.claude.model).toBe('m1')
    // The original keeps the real values.
    expect(effective.claude.authToken).toBe('sk-secret')
  })
})
