import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  declaredModels, dshModelSelectionError, listDshModels, parseDshModelSelection, providerProfiles,
  readThinkLevelIndex, resolveDshModelEndpoint, thinkLevelIndexPath, type ThinkLevelIndex,
} from '../src/dsh-models.js'
import type { Context } from '@deepseek-ai/cordis'

/** No think-level plugin: the official single-endpoint catalog. */
const officialOnly: ThinkLevelIndex = { keys: {}, endpoints: {} }

/** A route that carries both address families, the way the plugin stores it. */
const multiEndpoint: ThinkLevelIndex = {
  keys: {
    ofox: [
      { ref: 'OFOX_KEY' },
      { ref: 'OFOX_ANTHROPIC', protocol: 'anthropic-messages' },
      { ref: 'OFOX_OFF', disabled: true },
    ],
  },
  endpoints: {
    ofox: { openai: 'https://gw/v1', anthropic: 'https://gw/anthropic' },
    half: { openai: 'https://half/v1' },
  },
}

describe('parseDshModelSelection', () => {
  it('parses provider::model with slashes in the model id', () => {
    expect(parseDshModelSelection('ofox::group/deepseek-v4.1-flash')).toEqual({ provider: 'ofox', model: 'group/deepseek-v4.1-flash' })
  })

  it('rejects malformed selections', () => {
    expect(parseDshModelSelection('')).toBeUndefined()
    expect(parseDshModelSelection('ofox')).toBeUndefined()
    expect(parseDshModelSelection('::model')).toBeUndefined()
    expect(parseDshModelSelection('ofox::')).toBeUndefined()
    expect(dshModelSelectionError('ofox')).toContain('::')
    expect(dshModelSelectionError('')).toBeUndefined()
  })
})

describe('providerProfiles', () => {
  it('reads the llm-pi-ai providers from the composed settings', () => {
    const settings = {
      describe: () => [
        { ns: 'other', value: {} },
        { ns: 'llm-pi-ai', value: { providers: { ofox: { api: 'openai-completions', baseURL: 'https://gw/v1', apiKeyEnv: 'OFOX_API_KEY' } } } },
      ],
    }
    const profiles = providerProfiles(settings)
    expect(profiles['ofox']?.['api']).toBe('openai-completions')
  })

  it('degrades to empty on missing namespace or a throwing describe', () => {
    expect(providerProfiles(undefined)).toEqual({})
    expect(providerProfiles({ describe: () => { throw new Error('boot') } })).toEqual({})
  })
})

describe('listDshModels', () => {
  it('joins profiles with catalog models and mappability', async () => {
    const settings = {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: {
        ofox: { api: 'openai-completions', baseURL: 'https://gw/v1', apiKeyEnv: 'OFOX_API_KEY', displayName: '中粮网关' },
        bare: { api: 'openai-completions', baseURL: 'https://x/v1' },
      } } }],
    }
    const ctx = {
      // buildModelCatalog import fails in tests; profiles alone must carry the shape.
    } as unknown as Context
    const catalog = await listDshModels(ctx, settings, officialOnly)
    const ofox = catalog.providers.find(provider => provider.id === 'ofox')
    const bare = catalog.providers.find(provider => provider.id === 'bare')
    expect(ofox?.displayName).toBe('中粮网关')
    expect(ofox?.mappable).toBe(true)
    expect(bare?.mappable).toBe(false)
  })

  it('carries each model’s configured reasoningEfforts as the thinking levels', () => {
    const models = declaredModels({ models: [
      'bare/string-model',
      { id: 'anthropic/claude-fable-5', name: 'Claude Fable 5', reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' }, reasoning: 'high' },
      { id: 'openai/gpt-6' },
      { reasoningEfforts: { low: 'low' } },
      42,
    ] })
    expect(models).toEqual([
      { id: 'bare/string-model', reasoningEfforts: [] },
      { id: 'anthropic/claude-fable-5', reasoningEfforts: ['off', 'low', 'medium', 'high'] },
      { id: 'openai/gpt-6', reasoningEfforts: [] },
    ])
  })

  it('returns nothing without a models array', () => {
    expect(declaredModels({})).toEqual([])
    expect(declaredModels({ models: 'nope' })).toEqual([])
  })
})

describe('think-level multi-endpoint catalog', () => {
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', value: { providers: {
      ofox: { api: 'openai-completions', baseURL: 'https://gw/v1', apiKeyEnv: 'OFOX_KEY', displayName: '网关', models: ['gpt-x', 'claude-x'] },
      half: { api: 'anthropic-messages', baseURL: 'https://half/an', apiKeyEnv: 'HALF_KEY', displayName: '半端', models: ['claude-y'] },
    } } }],
  }
  const ctx = {} as unknown as Context

  it('folds the extra address families over the official profile', async () => {
    const catalog = await listDshModels(ctx, settings, multiEndpoint)
    const ofox = catalog.providers.filter(provider => provider.id === 'ofox')
    expect(ofox.map(entry => [entry.api, entry.baseURL, entry.origin])).toEqual([
      ['openai-completions', 'https://gw/v1', 'host'],
      ['anthropic-messages', 'https://gw/anthropic', 'think-level'],
    ])
    const half = catalog.providers.filter(provider => provider.id === 'half')
    expect(half.map(entry => [entry.api, entry.baseURL, entry.origin])).toEqual([
      ['anthropic-messages', 'https://half/an', 'host'],
      ['openai-completions', 'https://half/v1', 'think-level'],
    ])
    expect(ofox.every(entry => entry.mappable)).toBe(true)
  })

  it('treats a model-scoped key list as mappable even without apiKeyEnv', async () => {
    const settings = {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: {
        scoped: { api: 'openai-completions', baseURL: 'https://s/v1', models: ['m1'] },
      } } }],
    }
    const index: ThinkLevelIndex = { keys: { scoped: [{ ref: 'SC_KEY', models: ['m1'] }] }, endpoints: {} }
    const [entry] = (await listDshModels(ctx, settings, index)).providers
    expect(entry?.mappable).toBe(true)
    expect(entry?.keyRefs).toEqual(['SC_KEY'])
  })

  it('keeps the official endpoint when a route has no extra addresses', async () => {    const catalog = await listDshModels(ctx, settings, { keys: {}, endpoints: {} })
    expect(catalog.providers.filter(provider => provider.id === 'ofox')).toHaveLength(1)
    expect(catalog.providers.find(provider => provider.id === 'ofox')?.origin).toBe('host')
  })

  it('does not duplicate an extra address equal to the route’s own baseURL', async () => {
    const index: ThinkLevelIndex = { keys: {}, endpoints: { half: { anthropic: 'https://half/an' } } }
    const catalog = await listDshModels(ctx, settings, index)
    expect(catalog.providers.filter(provider => provider.id === 'half')).toHaveLength(1)
  })
})

describe('resolveDshModelEndpoint', () => {
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', value: { providers: {
      ofox: { api: 'openai-completions', baseURL: 'https://gw/v1', apiKeyEnv: 'TEST_OFOX_KEY', models: ['gpt-x', 'claude-x'] },
      anthropicOne: { api: 'anthropic-messages', baseURL: 'https://an/v1', apiKeyEnv: 'TEST_AN_KEY', models: ['claude-sonnet-4-5'] },
    } } }],
  }
  const ctxWithCredentials = {
    credentials: { resolve: async (ref: string) => ({ value: `key-for-${ref}`, source: 'env' }) },
  } as unknown as Context

  it('resolves the endpoint and key through the credentials service', async () => {
    const endpoint = await resolveDshModelEndpoint(ctxWithCredentials, settings, 'ofox::group/deepseek-v4.1-flash', undefined, officialOnly)
    expect(endpoint).toEqual({ provider: 'ofox', model: 'group/deepseek-v4.1-flash', api: 'openai-completions', baseURL: 'https://gw/v1', apiKey: 'key-for-TEST_OFOX_KEY' })
  })

  it('rejects non-mappable providers for claude (handled by dispatch) with clear errors', async () => {
    await expect(resolveDshModelEndpoint(ctxWithCredentials, settings, 'missing::m1', 'claude', officialOnly)).rejects.toThrow(/不存在/)
  })

  it('falls back to the ambient env when the credentials service is absent', async () => {
    process.env['TEST_AN_KEY'] = 'ambient-key'
    const endpoint = await resolveDshModelEndpoint({} as Context, settings, 'anthropicOne::claude-sonnet-4-5', undefined, officialOnly)
    expect(endpoint.apiKey).toBe('ambient-key')
    delete process.env['TEST_AN_KEY']
  })

  it('picks the Anthropic address for claude and the OpenAI one otherwise', async () => {
    const index: ThinkLevelIndex = { keys: { ofox: [{ ref: 'TEST_OFOX_KEY' }] }, endpoints: { ofox: { openai: 'https://gw/v1', anthropic: 'https://gw/anthropic' } } }
    const forClaude = await resolveDshModelEndpoint(ctxWithCredentials, settings, 'ofox::claude-x', 'claude', index)
    expect(forClaude).toMatchObject({ api: 'anthropic-messages', baseURL: 'https://gw/anthropic' })
    const forCodex = await resolveDshModelEndpoint(ctxWithCredentials, settings, 'ofox::gpt-x', 'codex', index)
    expect(forCodex).toMatchObject({ api: 'openai-completions', baseURL: 'https://gw/v1' })
    const forGrok = await resolveDshModelEndpoint(ctxWithCredentials, settings, 'ofox::gpt-x', 'grok', index)
    expect(forGrok).toMatchObject({ api: 'openai-completions', baseURL: 'https://gw/v1' })
  })

  it('fails loudly when the route has no endpoint for that CLI family', async () => {
    const settingsOpenAiOnly = {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: {
        gw: { api: 'openai-completions', baseURL: 'https://gw/v1', apiKeyEnv: 'TEST_GW_KEY' },
      } } }],
    }
    await expect(resolveDshModelEndpoint(ctxWithCredentials, settingsOpenAiOnly, 'gw::m1', 'claude', officialOnly))
      .rejects.toThrow(/只提供 openai-completions 协议端点/)
  })

  it('prefers a key whose model scope and protocol family match', async () => {
    const index: ThinkLevelIndex = {
      keys: {
        ofox: [
          { ref: 'TEST_WRONG_FAMILY', protocol: 'openai-responses' },
          { ref: 'TEST_CLAUDE_KEY', models: ['claude-x'], protocol: 'anthropic-messages' },
          { ref: 'TEST_ANY_KEY' },
        ],
      },
      endpoints: { ofox: { anthropic: 'https://gw/anthropic' } },
    }
    const endpoint = await resolveDshModelEndpoint(ctxWithCredentials, settings, 'ofox::claude-x', 'claude', index)
    expect(endpoint.apiKey).toBe('key-for-TEST_CLAUDE_KEY')
    expect(endpoint.baseURL).toBe('https://gw/anthropic')
  })

  it('never signs with a key the plugin switched off', async () => {
    const index: ThinkLevelIndex = { keys: { ofox: [{ ref: 'TEST_OFF_KEY', disabled: true }] }, endpoints: {} }
    const endpoint = await resolveDshModelEndpoint(ctxWithCredentials, settings, 'ofox::gpt-x', 'codex', index)
    expect(endpoint.apiKey).toBe('key-for-TEST_OFOX_KEY')
  })

  it('does not use a key whose scope excludes the model', async () => {
    const index: ThinkLevelIndex = {
      keys: { ofox: [{ ref: 'TEST_OTHER_MODEL_KEY', models: ['other-model'] }, { ref: 'TEST_EMPTY_SCOPE_KEY', models: [] }] },
      endpoints: {},
    }
    const endpoint = await resolveDshModelEndpoint(ctxWithCredentials, settings, 'ofox::gpt-x', 'codex', index)
    expect(endpoint.apiKey).toBe('key-for-TEST_OFOX_KEY')
  })
})

describe('readThinkLevelIndex', () => {
  it('reads keys and endpoints, dropping unusable entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'maestro-think-level-'))
    try {
      const file = join(dir, 'key-index.json')
      writeFileSync(file, JSON.stringify({
        version: 1,
        providers: {
          ofox: [
            { ref: 'A', alias: '主', models: ['m1', ''] },
            { ref: '', alias: 'empty' },
            { ref: 'B', protocol: 'anthropic-messages', disabled: true },
            { ref: 'C', protocol: 'not-a-protocol' },
            'nope',
          ],
        },
        endpoints: {
          ofox: { openai: ' https://gw/v1 ', anthropic: 'ftp://gw/an', extra: 'https://ignored/v1' },
          empty: {},
        },
      }))
      expect(readThinkLevelIndex(file)).toEqual({
        keys: { ofox: [{ ref: 'A', models: ['m1'] }, { ref: 'B', protocol: 'anthropic-messages', disabled: true }, { ref: 'C' }] },
        endpoints: { ofox: { openai: 'https://gw/v1' } },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is empty when the plugin is absent or the file is broken', () => {
    expect(readThinkLevelIndex(join(tmpdir(), 'definitely-missing-key-index.json'))).toEqual({ keys: {}, endpoints: {} })
    const dir = mkdtempSync(join(tmpdir(), 'maestro-think-level-'))
    try {
      const broken = join(dir, 'broken.json')
      writeFileSync(broken, '{ not json')
      expect(readThinkLevelIndex(broken)).toEqual({ keys: {}, endpoints: {} })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves next to the harness home', () => {
    expect(thinkLevelIndexPath('C:/Users/x', 'D:/home/.dsh')).toBe(join('D:/home/.dsh', 'dsh-model-think-level', 'key-index.json'))
  })
})
