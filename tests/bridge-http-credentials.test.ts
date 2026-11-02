import { describe, expect, it } from 'vitest'
import { bridgeCallRequestBody, bridgeCatalogRequestQuery } from '../src/routes.js'
import { BRIDGE_ACCESS_HEADER } from '../src/wire.js'
import { fetchCatalog, handleShimMessage } from '../src/bridge-shim.js'

describe('header-only per-run bridge credentials', () => {
  it('query and body credentials cannot select a different run', () => {
    const query = new URLSearchParams({ token: 'foreign-run', cwd: '/fixture' })
    expect(bridgeCatalogRequestQuery(query, 'trusted-run').get('token')).toBe('trusted-run')
    expect(bridgeCatalogRequestQuery(query, undefined).get('token')).toBe('')
    expect(bridgeCatalogRequestQuery(query, ['trusted-run']).get('token')).toBe('')
    expect(bridgeCallRequestBody({ token: 'foreign-run', kind: 'tool', name: 'fixture' }, 'trusted-run')).toEqual({ token: 'trusted-run', kind: 'tool', name: 'fixture' })
    expect(bridgeCallRequestBody({ token: 'foreign-run' }, undefined).token).toBe('')
  })
  it('shim places the credential only in headers, never URL or JSON', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    const doFetch: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), ...(init === undefined ? {} : { init }) })
      return new Response(JSON.stringify(String(input).includes('/bridge/catalog') ? { skills: [], tools: [{ name: 'fixture', description: '', parameters: { type: 'object', properties: {} } }] } : { ok: true, text: 'done' }), { status: 200 })
    }
    const state = { baseUrl: 'http://fixture.invalid', token: 'private-run-credential' }
    const catalog = await fetchCatalog(state, '/fixture', doFetch)
    await handleShimMessage(state, { id: 1, method: 'tools/call', params: { name: 'fixture', arguments: {} } }, { catalog, fetchImpl: doFetch })
    expect(seen).toHaveLength(2)
    for (const request of seen) {
      expect(request.url).not.toContain(state.token)
      expect(request.url).not.toContain('token=')
      expect(new Headers(request.init?.headers).get(BRIDGE_ACCESS_HEADER)).toBe(state.token)
      expect(String(request.init?.body ?? '')).not.toContain(state.token)
    }
  })
})
