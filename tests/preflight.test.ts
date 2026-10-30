import { describe, expect, it } from 'vitest'
import {
  classifyProbe,
  declaredModelProblem,
  preflightDshModel,
  probeDshEndpoint,
  probeRequest,
} from '../src/preflight.js'
import type { DshModelEndpoint } from '../src/dsh-models.js'

const anthropic: DshModelEndpoint = {
  provider: 'tierflow',
  model: 'tierflow_pro',
  api: 'anthropic-messages',
  baseURL: 'https://tierflow.cn',
  apiKey: 'sk-1',
}

function fetchReturning(status: number, body: string): typeof fetch {
  return (() => Promise.resolve(new Response(body, { status }))) as unknown as typeof fetch
}

describe('probeRequest', () => {
  it('posts a one-token completion at the anthropic path with both auth headers', () => {
    const { url, init } = probeRequest(anthropic)
    expect(url).toBe('https://tierflow.cn/v1/messages')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-1')
    expect(headers['authorization']).toBe('Bearer sk-1')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'tierflow_pro', max_tokens: 1 })
  })

  it('builds the responses and chat paths for the openai APIs', () => {
    const responses = probeRequest({ ...anthropic, api: 'openai-responses', baseURL: 'https://wb.example/v1' })
    expect(responses.url).toBe('https://wb.example/v1/responses')
    expect((responses.init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-1')
    const chat = probeRequest({ ...anthropic, api: 'openai-completions', baseURL: 'https://x.example/' })
    expect(chat.url).toBe('https://x.example/v1/chat/completions')
  })
})

describe('classifyProbe', () => {
  it('treats 2xx as a pass', () => {
    expect(classifyProbe(anthropic, 200, '{"ok":true}').status).toBe('ok')
  })

  it('treats 404 and rejected credentials as a mismatch', () => {
    expect(classifyProbe(anthropic, 404, 'not found').status).toBe('mismatch')
    expect(classifyProbe(anthropic, 401, 'bad key').status).toBe('mismatch')
    expect(classifyProbe(anthropic, 403, '<html>Attention Required! | Cloudflare</html>').status).toBe('mismatch')
  })

  it('names the missing model when the body says so', () => {
    const verdict = classifyProbe(anthropic, 400, '{"error":{"message":"model tierflow_pro does not exist"}}')
    expect(verdict.status).toBe('mismatch')
    expect(verdict.detail).toContain('tierflow_pro')
  })

  it('stays undecided on a status it cannot read', () => {
    // A 500 or an unrelated 400 says nothing about the model name: proceed.
    expect(classifyProbe(anthropic, 500, 'upstream exploded').status).toBe('unknown')
    expect(classifyProbe(anthropic, 400, '{"error":"bad request"}').status).toBe('unknown')
  })
})

describe('declaredModelProblem', () => {
  it('stays silent for providers that declare nothing or declare the model', () => {
    expect(declaredModelProblem(anthropic, [])).toBeUndefined()
    expect(declaredModelProblem(anthropic, [{ id: 'tierflow_pro', reasoningEfforts: [] }])).toBeUndefined()
  })

  it('remarks on an undeclared alias without blocking it', () => {
    const note = declaredModelProblem(anthropic, [{ id: 'other', reasoningEfforts: [] }])
    expect(note).toContain('tierflow_pro')
    expect(note).toContain('other')
  })
})

describe('probeDshEndpoint', () => {
  it('passes when the endpoint answers', async () => {
    const verdict = await probeDshEndpoint(anthropic, { fetchImpl: fetchReturning(200, '{}') })
    expect(verdict.status).toBe('ok')
  })

  it('fails the candidate when the endpoint refuses the model', async () => {
    const verdict = await probeDshEndpoint(anthropic, {
      fetchImpl: fetchReturning(400, '{"error":{"message":"model does not exist"}}'),
    })
    expect(verdict.status).toBe('mismatch')
  })

  it('never throws on transport errors', async () => {
    const broken = (() => Promise.reject(new Error('getaddrinfo EAI_AGAIN'))) as unknown as typeof fetch
    const verdict = await probeDshEndpoint(anthropic, { fetchImpl: broken })
    expect(verdict.status).toBe('unknown')
    expect(verdict.detail).toContain('EAI_AGAIN')
  })
})

describe('preflightDshModel', () => {
  it('attaches the undeclared-model remark to the probe verdict', async () => {
    const verdict = await preflightDshModel(anthropic, [{ id: 'other', reasoningEfforts: [] }], {
      fetchImpl: fetchReturning(200, '{}'),
    })
    expect(verdict.status).toBe('ok')
    expect(verdict.note).toContain('tierflow_pro')
  })
})
