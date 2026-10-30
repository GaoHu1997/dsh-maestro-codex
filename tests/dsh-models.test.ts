import { describe, expect, it } from 'vitest'
import { declaredModels, listDshModels, parseDshModelSelection, providerProfiles, resolveDshModelEndpoint, dshModelSelectionError } from '../src/dsh-models.js'
import type { Context } from '@deepseek-ai/cordis'

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
    const catalog = await listDshModels(ctx, settings)
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

describe('resolveDshModelEndpoint', () => {
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', value: { providers: {
      ofox: { api: 'openai-completions', baseURL: 'https://gw/v1', apiKeyEnv: 'TEST_OFOX_KEY' },
      anthropicOne: { api: 'anthropic-messages', baseURL: 'https://an/v1', apiKeyEnv: 'TEST_AN_KEY' },
    } } }],
  }
  const ctxWithCredentials = {
    credentials: { resolve: async (ref: string) => ({ value: `key-for-${ref}`, source: 'env' }) },
  } as unknown as Context

  it('resolves the endpoint and key through the credentials service', async () => {
    const endpoint = await resolveDshModelEndpoint(ctxWithCredentials, settings, 'ofox::group/deepseek-v4.1-flash')
    expect(endpoint).toEqual({ provider: 'ofox', model: 'group/deepseek-v4.1-flash', api: 'openai-completions', baseURL: 'https://gw/v1', apiKey: 'key-for-TEST_OFOX_KEY' })
  })

  it('rejects non-mappable providers for claude (handled by dispatch) with clear errors', async () => {
    await expect(resolveDshModelEndpoint(ctxWithCredentials, settings, 'missing::m1')).rejects.toThrow(/不存在/)
  })

  it('falls back to the ambient env when the credentials service is absent', async () => {
    process.env['TEST_AN_KEY'] = 'ambient-key'
    const endpoint = await resolveDshModelEndpoint({} as Context, settings, 'anthropicOne::claude-sonnet-4-5')
    expect(endpoint.apiKey).toBe('ambient-key')
    delete process.env['TEST_AN_KEY']
  })
})
