import { describe, expect, it, vi } from 'vitest'
import { publicEndpointUrl, transportDiagnostic } from '../src/public-diagnostics.js'
import { listDshModels, resolveDshModelEndpoint, type DshModelEndpoint } from '../src/dsh-models.js'
import { classifyProbe, probeDshEndpoint, probeRequest } from '../src/preflight.js'

// Endpoint resolution sees a synthetic absent credential file and fake service,
// never the real home credential store.
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: vi.fn(() => { throw new Error('synthetic credential file absent') }),
}))

const key = 'SYNTHETIC_DIAGNOSTIC_KEY'
const endpoint: DshModelEndpoint = {
  provider: 'synthetic', model: 'synthetic-model', api: 'anthropic-messages',
  baseURL: 'https://provider.invalid/v1', apiKey: key,
}

describe('public endpoint diagnostics', () => {
  it('preserves ordinary public URLs and the empty unconfigured label', () => {
    expect(publicEndpointUrl(endpoint.baseURL)).toBe(endpoint.baseURL)
    expect(publicEndpointUrl('')).toBe('')
  })

  it('omits all userinfo, query values and fragments, including unfamiliar keys', () => {
    const raw = 'https://user:SYNTHETIC_PASSWORD@provider.invalid/v1?api_key=SYNTHETIC_QUERY&custom=SYNTHETIC_CUSTOM#SYNTHETIC_FRAGMENT'
    expect(publicEndpointUrl(raw)).toBe('https://provider.invalid/v1')
    expect(publicEndpointUrl('https://u:%70%61%73%73@provider.invalid/v1?x=encoded')).toBe('https://provider.invalid/v1')
  })

  it('never displays a malformed or non-HTTP credential URL verbatim', () => {
    for (const raw of ['not-a-url?key=SYNTHETIC_SECRET', 'https://u:SYNTHETIC_SECRET@', 'file:///SYNTHETIC_SECRET']) {
      expect(publicEndpointUrl(raw)).not.toContain('SYNTHETIC_SECRET')
    }
  })

  it('sanitizes the catalog without mutating the private resolver endpoint', async () => {
    const privateUrl = 'https://user:SYNTHETIC_PASSWORD@provider.invalid/v1?custom=SYNTHETIC_QUERY'
    const settings = { describe: () => [{ ns: 'llm-pi-ai', value: { providers: {
      synthetic: { api: 'anthropic-messages', baseURL: privateUrl, apiKeyEnv: 'SYNTHETIC_REF', models: ['synthetic-model'] },
    } } }] }
    const resolve = vi.fn(async () => ({ value: key, source: 'synthetic-service' }))
    const ctx = { credentials: { resolve } } as never
    const catalog = await listDshModels(ctx, settings)
    expect(catalog.providers[0]).toMatchObject({ baseURL: endpoint.baseURL, mappable: true, hasKeyRef: true })
    expect(JSON.stringify(catalog)).not.toMatch(/SYNTHETIC_PASSWORD|SYNTHETIC_QUERY/)
    const privateEndpoint = await resolveDshModelEndpoint(ctx, settings, 'synthetic::synthetic-model')
    expect(privateEndpoint).toMatchObject({ baseURL: privateUrl, apiKey: key })
    expect(resolve).toHaveBeenCalledWith('SYNTHETIC_REF')
    expect(settings.describe()[0]!.value.providers.synthetic.baseURL).toBe(privateUrl)
    expect((probeRequest(endpoint).init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${key}`)
  })
})

describe('preflight output boundary', () => {
  it.each([200, 400, 401, 403, 404, 429, 500])('does not echo credentials or arbitrary response text for HTTP %s', status => {
    const body = status === 400 ? `model does not exist: ${key}` : `UNTRUSTED_RESPONSE ${key} encoded=${encodeURIComponent(key)} other=SYNTHETIC_OTHER_SECRET`
    const privateEndpoint = { ...endpoint, baseURL: 'https://u:SYNTHETIC_PASSWORD@provider.invalid/v1?x=SYNTHETIC_QUERY' }
    const result = classifyProbe(privateEndpoint, status, body)
    expect(result.detail).not.toMatch(/SYNTHETIC_DIAGNOSTIC_KEY|SYNTHETIC_PASSWORD|SYNTHETIC_QUERY|SYNTHETIC_OTHER_SECRET|UNTRUSTED_RESPONSE/)
    expect(result.detail).toContain('synthetic-model')
    if ([400, 401, 403, 404].includes(status)) expect(result.status).toBe('mismatch')
    else expect(result.status).toBe('unknown')
  })

  it('keeps useful allowlisted transport codes without echoing exception text', () => {
    expect(transportDiagnostic(new Error(`getaddrinfo EAI_AGAIN secret=${key}`))).toBe('EAI_AGAIN')
    expect(transportDiagnostic(new Error(`fetch failed ${key}`, { cause: new Error(`ECONNREFUSED ${key}`) }))).toBe('ECONNREFUSED')
    expect(transportDiagnostic(new Error(key))).toBe('网络或传输错误')
    expect(transportDiagnostic(key)).toBe('网络或传输错误')
    expect(transportDiagnostic(Object.assign(new Error(key), { name: 'AbortError' }))).toBe('请求超时或中止')
  })

  it('does not echo a transport exception containing credentials or a private URL', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error(`Bearer ${key} at https://u:SYNTHETIC_PASSWORD@provider.invalid/v1?key=SYNTHETIC_QUERY`) }) as unknown as typeof fetch
    const result = await probeDshEndpoint(endpoint, { fetchImpl })
    expect(result.status).toBe('unknown')
    expect(result.detail).not.toMatch(/SYNTHETIC_DIAGNOSTIC_KEY|SYNTHETIC_PASSWORD|SYNTHETIC_QUERY/)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})
