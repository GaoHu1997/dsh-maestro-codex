import { describe, expect, it } from 'vitest'
import { Config, CONFIG_DEFAULTS, TASK_DIFFICULTIES, effectiveOf, readVolatile, redactEffective, validateConfig } from '../src/config.js'

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
    expect(() => validateConfig({ claudeThinking: 'not a token' })).toThrow(/claudeThinking/)
    expect(() => validateConfig({ codexThinking: 'a"b' })).toThrow(/codexThinking/)
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
    const effective = effectiveOf({ defaultCli: 'codex', claudePermissionMode: 'acceptEdits', maxConcurrentTasks: 3 })
    expect(effective.defaultCli).toBe('codex')
    expect(effective.claude.permissionMode).toBe('acceptEdits')
    expect(effective.maxConcurrentTasks).toBe(3)
  })

  it('falls back to the default on an out-of-enum value', () => {
    const effective = effectiveOf({ defaultCli: 'yolo' })
    expect(effective.defaultCli).toBe(CONFIG_DEFAULTS.defaultCli)
  })
})

describe('thinking levels', () => {
  it('defaults both CLIs to unset', () => {
    expect(CONFIG_DEFAULTS.claudeThinking).toBe('')
    expect(CONFIG_DEFAULTS.codexThinking).toBe('')
    expect(effectiveOf({}).claude.thinking).toBe('')
    expect(effectiveOf({}).codex.thinking).toBe('')
  })

  it('passes model-configured level keys through untouched', () => {
    // Levels come from the dsh model catalog (reasoningEfforts), so any safe
    // token is accepted here — the channels decide what each CLI understands.
    const effective = effectiveOf({ claudeThinking: 'high', codexThinking: 'minimal' })
    expect(effective.claude.thinking).toBe('high')
    expect(effective.codex.thinking).toBe('minimal')
    expect(effectiveOf({ claudeThinking: 'ultra' }).claude.thinking).toBe('ultra')
    expect(effectiveOf({ codexThinking: 'xhigh' }).codex.thinking).toBe('xhigh')
  })

  it('rejects unsafe level tokens at the config boundary', () => {
    expect(() => validateConfig({ claudeThinking: 'a b' } as Config)).toThrow(/claudeThinking/)
    expect(() => validateConfig({ codexThinking: 'x;y' } as Config)).toThrow(/codexThinking/)
  })

  it('schema parses and projects the fields as volatile', () => {
    const parsed = Config({ claudeThinking: 'medium', codexThinking: 'high' }) as Config
    expect(readVolatile(parsed.claudeThinking)).toBe('medium')
    expect(readVolatile(parsed.codexThinking)).toBe('high')
    expect(Config.dict.claudeThinking.meta.volatile).toBe(true)
    expect(Config.dict.codexThinking.meta.volatile).toBe(true)
  })
})

describe('minimum task difficulty', () => {
  it('defaults each CLI to medium and keeps only independent values in the redacted browser view', () => {
    expect(CONFIG_DEFAULTS.minTaskDifficulty).toBe('medium')
    expect(CONFIG_DEFAULTS.claudeMinTaskDifficulty).toBe('medium')
    expect(CONFIG_DEFAULTS.codexMinTaskDifficulty).toBe('medium')
    expect(effectiveOf({}).claude.minTaskDifficulty).toBe('medium')
    expect(effectiveOf({}).codex.minTaskDifficulty).toBe('medium')
    expect(effectiveOf({})).not.toHaveProperty('minTaskDifficulty')
    const redacted = redactEffective(effectiveOf({ minTaskDifficulty: 'high', codexMinTaskDifficulty: 'low' }))
    expect(redacted.claude.minTaskDifficulty).toBe('high')
    expect(redacted.codex.minTaskDifficulty).toBe('low')
  })

  it.each(TASK_DIFFICULTIES)('accepts and resolves the legacy %s threshold for both CLIs', minTaskDifficulty => {
    expect(() => validateConfig({ minTaskDifficulty })).not.toThrow()
    expect(effectiveOf({ minTaskDifficulty }).claude.minTaskDifficulty).toBe(minTaskDifficulty)
    expect(effectiveOf({ minTaskDifficulty }).codex.minTaskDifficulty).toBe(minTaskDifficulty)
  })

  for (const field of ['claudeMinTaskDifficulty', 'codexMinTaskDifficulty'] as const) {
    const cli = field === 'claudeMinTaskDifficulty' ? 'claude' : 'codex'
    const other = cli === 'claude' ? 'codex' : 'claude'
    it.each(TASK_DIFFICULTIES)(`accepts independent ${field}=%s without changing the other CLI`, minimum => {
      const config = { minTaskDifficulty: 'extreme', [field]: minimum }
      expect(() => validateConfig(config)).not.toThrow()
      expect(effectiveOf(config)[cli].minTaskDifficulty).toBe(minimum)
      expect(effectiveOf(config)[other].minTaskDifficulty).toBe('extreme')
    })
  }

  for (const field of ['minTaskDifficulty', 'claudeMinTaskDifficulty', 'codexMinTaskDifficulty'] as const) {
    it.each(['', 'HIGH', 'unknown', null, 3])(`rejects invalid configured ${field} %s`, value => {
      const config = { [field]: value } as unknown as Config
      expect(() => validateConfig(config)).toThrow(field)
      expect(effectiveOf(config).claude.minTaskDifficulty).toBe('medium')
      expect(effectiveOf(config).codex.minTaskDifficulty).toBe('medium')
    })
  }

  it('re-reads volatile legacy and independent values without coupling CLIs', () => {
    let legacy = 'high'
    let claude: string | undefined = 'low'
    let codex: string | undefined
    const config = {
      minTaskDifficulty: { get: () => legacy },
      claudeMinTaskDifficulty: { get: () => claude },
      codexMinTaskDifficulty: { get: () => codex },
    } as unknown as Config
    expect(effectiveOf(config).claude.minTaskDifficulty).toBe('low')
    expect(effectiveOf(config).codex.minTaskDifficulty).toBe('high')
    claude = 'extreme'
    codex = 'medium'
    legacy = 'low'
    expect(effectiveOf(config).claude.minTaskDifficulty).toBe('extreme')
    expect(effectiveOf(config).codex.minTaskDifficulty).toBe('medium')
    expect(() => validateConfig(config)).not.toThrow()
    claude = undefined
    expect(effectiveOf(config).claude.minTaskDifficulty).toBe('low')
    codex = 'invalid'
    expect(() => validateConfig(config)).toThrow(/codexMinTaskDifficulty/)
    expect(effectiveOf(config).codex.minTaskDifficulty).toBe('medium')
    legacy = 'invalid'
    expect(() => validateConfig(config)).toThrow(/minTaskDifficulty/)
    expect(effectiveOf(config).claude.minTaskDifficulty).toBe('medium')
  })

  it.each(['high', 'extreme'] as const)('schema parsing does not fill independent defaults and hide legacy %s', minimum => {
    const parsed = Config({ minTaskDifficulty: minimum }) as Config
    expect(readVolatile(parsed.claudeMinTaskDifficulty)).toBeUndefined()
    expect(readVolatile(parsed.codexMinTaskDifficulty)).toBeUndefined()
    expect(effectiveOf(parsed).claude.minTaskDifficulty).toBe(minimum)
    expect(effectiveOf(parsed).codex.minTaskDifficulty).toBe(minimum)
  })

  it('schema accepts missing new keys and independent overrides', () => {
    const defaults = effectiveOf(Config({}) as Config)
    expect(defaults.claude.minTaskDifficulty).toBe('medium')
    expect(defaults.codex.minTaskDifficulty).toBe('medium')
    const parsed = Config({ minTaskDifficulty: 'extreme', claudeMinTaskDifficulty: 'low', codexMinTaskDifficulty: 'high' }) as Config
    expect(() => validateConfig(parsed)).not.toThrow()
    expect(effectiveOf(parsed).claude.minTaskDifficulty).toBe('low')
    expect(effectiveOf(parsed).codex.minTaskDifficulty).toBe('high')
    expect(Config.dict.claudeMinTaskDifficulty.meta.volatile).toBe(true)
    expect(Config.dict.codexMinTaskDifficulty.meta.volatile).toBe(true)
  })
})

describe('redactEffective', () => {
  it('masks tokens but keeps other fields readable', () => {
    const effective = effectiveOf({ claudeAuthToken: 'sk-secret', codexApiKey: 'sk-openai', claudePermissionMode: 'acceptEdits' })
    const redacted = redactEffective(effective)
    expect(redacted.claude.authToken).toBe('••••')
    expect(redacted.codex.apiKey).toBe('••••')
    expect(redacted.claude.permissionMode).toBe('acceptEdits')
    // The original keeps the real values.
    expect(effective.claude.authToken).toBe('sk-secret')
  })
})

describe('persistTasks', () => {
  it('defaults to on and passes explicit values through', () => {
    expect(CONFIG_DEFAULTS.persistTasks).toBe(true)
    expect(effectiveOf({}).persistTasks).toBe(true)
    expect(effectiveOf({ persistTasks: false }).persistTasks).toBe(false)
    const parsed = Config({ persistTasks: false }) as Config
    expect(readVolatile(parsed.persistTasks)).toBe(false)
    expect(Config.dict.persistTasks.meta.volatile).toBe(true)
  })
})
