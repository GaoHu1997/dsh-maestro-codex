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
    expect(classifyProbe(anthropic, 200, '{"type":"message","content":[]}').status).toBe('ok')
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

describe('classifyProbe error classification regressions', () => {
  it.each([
    ['unsupported max_tokens', { code: 'unsupported_parameter', param: 'max_tokens', message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." }],
    ['unsupported parameter without param', { code: 'unsupported_parameter', param: null, message: 'Unknown model option: max_tokens' }],
    ['invalid temperature value', { code: 'invalid_value', param: 'temperature', message: 'Unsupported value for this model' }],
    ['non-model param with generic code', { code: 'invalid_request_error', param: 'max_output_tokens', message: 'model tierflow_pro does not exist' }],
    ['non-model param without code', { param: 'messages[0].content', message: 'Unknown model request content' }],
    ['nested model feature param', { code: 'invalid_request_error', param: 'model.reasoning_effort', message: 'model tierflow_pro is invalid' }],
    ['context limit', { code: 'context_length_exceeded', param: 'model', message: 'The model is unsupported for this context length' }],
    ['quota exhaustion', { code: 'insufficient_quota', param: null, message: 'Unknown model availability after quota exhaustion' }],
    ['billing limit', { code: 'billing_hard_limit_reached', message: 'model tierflow_pro does not exist in this billing tier' }],
    ['rate limit type', { type: 'rate_limit_error', message: 'model tierflow_pro was not found in the rate-limited response' }],
    ['server overload', { type: 'overloaded_error', message: 'model tierflow_pro is not supported while overloaded' }],
    ['unrecognized structured code', { code: 'upstream_broken', message: 'Unknown model: tierflow_pro' }],
    ['contradictory model code and unrelated param', { code: 'model_not_found', param: 'input', message: 'model tierflow_pro does not exist' }],
    ['malformed structured code', { code: ['model_not_found'], param: 'model', message: 'model tierflow_pro does not exist' }],
    ['malformed structured param', { code: 'model_not_found', param: ['model'], message: 'model tierflow_pro does not exist' }],
  ])('does not confuse a structured %s error with a missing model', (_name, error) => {
    expect(classifyProbe(anthropic, 400, JSON.stringify({ error })).status).toBe('unknown')
  })

  it.each(['code', 'type'])('scopes generic INVALID_ARGUMENT %s by its model param and explicit message', field => {
    const error = { [field]: 'INVALID_ARGUMENT', param: 'model', message: 'model tierflow_pro does not exist' }
    expect(classifyProbe(anthropic, 400, JSON.stringify({ error })).status).toBe('mismatch')
    error.param = 'max_tokens'
    expect(classifyProbe(anthropic, 400, JSON.stringify({ error })).status).toBe('unknown')
  })

  it('reads structured errors at the top level as well as under error', () => {
    expect(classifyProbe(anthropic, 400, JSON.stringify({ code: 'unsupported_parameter', param: 'max_tokens', message: 'Unsupported parameter for this model' })).status).toBe('unknown')
    expect(classifyProbe(anthropic, 422, JSON.stringify({ code: 'model_not_found', param: 'model', message: 'Request rejected' })).status).toBe('mismatch')
  })

  it.each(['model_not_found', 'model_not_exists', 'model_does_not_exist', 'unknown_model', 'unsupported_model', 'invalid_model', 'model_not_supported', 'no_such_model'])('keeps definite %s structured model errors blocking', code => {
    const verdict = classifyProbe(anthropic, 400, JSON.stringify({ error: { code, param: 'model', message: 'Request rejected' } }))
    expect(verdict.status).toBe('mismatch')
    expect(verdict.detail).toContain('tierflow::tierflow_pro')
    expect(verdict.detail).not.toContain('Request rejected')
  })

  it('handles null model params, generic error types and normalized model codes', () => {
    expect(classifyProbe(anthropic, 400, JSON.stringify({ error: { code: 'MODEL-NOT-FOUND', param: null, type: 'invalid_request_error', message: 'Rejected' } })).status).toBe('mismatch')
    expect(classifyProbe(anthropic, 422, JSON.stringify({ error: { code: 'invalid_request_error', param: 'model', message: 'The model `tierflow_pro` does not exist or you do not have access to it.' } })).status).toBe('mismatch')
    expect(classifyProbe(anthropic, 400, JSON.stringify({ error: { type: 'not_found_error', message: 'model tierflow_pro not found' } })).status).toBe('mismatch')
    expect(classifyProbe(anthropic, 400, JSON.stringify({ error: { code: ' Model.Not.Found ', param: ' MODEL_ID ', message: 'Check request parameters' } })).status).toBe('mismatch')
  })

  it.each([
    'Unsupported parameter: max_tokens is not supported with this model.',
    'Unsupported value: low is not supported with this model.',
    'This model does not support the Responses API.',
    'Invalid request for model tierflow_pro.',
    'Unknown upstream error while using model tierflow_pro.',
    'model tierflow_pro is valid; user does not exist.',
    'The model is valid, but input does not exist.',
    'Model not found due to insufficient quota.',
    'Unknown model availability after rate limit exceeded.',
    'Invalid model configuration: reasoning effort is unsupported.',
    '模型不支持 max_tokens 参数',
    '模型上下文长度超限，参数无效',
    '模型不存在可用配额，额度不足',
    '模型请求限流，unknown error',
  ])('does not classify unrelated or non-model text as a mismatch: %s', message => {
    expect(classifyProbe(anthropic, 400, message).status).toBe('unknown')
    expect(classifyProbe(anthropic, 400, JSON.stringify({ error: { message } })).status).toBe('unknown')
  })

  it.each([
    'model tierflow_pro does not exist',
    'The model `tierflow_pro` does not exist or you do not have access to it.',
    'model "tierflow_pro" was not found',
    'model tierflow_pro is not supported',
    'Unknown model: tierflow_pro',
    'Unsupported model: tierflow_pro',
    'Invalid model: tierflow_pro',
    'No such model: tierflow_pro',
    '模型 tierflow_pro 不存在',
    '模型 "tierflow_pro" 未找到',
    '未找到模型 tierflow_pro',
    '未知模型：tierflow_pro',
    '无此模型 tierflow_pro',
    '不支持的模型 tierflow_pro',
  ])('recognizes explicit legacy missing-model text: %s', message => {
    expect(classifyProbe(anthropic, 400, message).status).toBe('mismatch')
    expect(classifyProbe(anthropic, 400, JSON.stringify({ error: message })).status).toBe('mismatch')
    expect(classifyProbe(anthropic, 400, JSON.stringify({ error: { message } })).status).toBe('mismatch')
  })

  it.each([402, 429, 500, 503])('keeps quota/rate-limit/server HTTP %s advisory even if model words appear', status => {
    expect(classifyProbe(anthropic, status, 'Unknown model: tierflow_pro').status).toBe('unknown')
    expect(classifyProbe(anthropic, status, JSON.stringify({ error: { code: 'model_not_found', param: 'model', message: 'model tierflow_pro does not exist' } })).status).toBe('unknown')
  })

  it('does not classify echoed request fields or unrelated structured metadata', () => {
    const body = JSON.stringify({ model: 'unknown_model', code: 'model_not_found', error: { message: 'bad request', request: { model: 'unknown_model' } } })
    expect(classifyProbe(anthropic, 400, body).status).toBe('unknown')
    expect(classifyProbe(anthropic, 400, '{"error":{"message":"bad request"},"debug":"model does not exist"}').status).toBe('unknown')
    expect(classifyProbe(anthropic, 400, '["model does not exist"]').status).toBe('unknown')
  })

  it.each([401, 403, 404])('keeps HTTP %s security policy ahead of non-model error classification', status => {
    const verdict = classifyProbe(anthropic, status, JSON.stringify({ error: { code: 'unsupported_parameter', param: 'max_tokens', message: 'model tierflow_pro is invalid' } }))
    expect(verdict.status).toBe('mismatch')
    expect(verdict.detail).toContain(String(status))
  })

  it.each([200, 400, 401, 403, 404, 422, 429, 500])('never copies response text or private endpoint data into HTTP %s detail', status => {
    const endpoint = { ...anthropic, apiKey: 'SYNTHETIC_BODY_KEY', baseURL: 'https://u:SYNTHETIC_URL_PASSWORD@example.test/v1?token=SYNTHETIC_QUERY#SYNTHETIC_FRAGMENT' }
    const body = JSON.stringify({ error: { code: 'model_not_found', param: 'model', message: 'model does not exist: RAW_UNTRUSTED SYNTHETIC_BODY_KEY encoded=%53%59%4e%54%48' } })
    const verdict = classifyProbe(endpoint, status, body)
    expect(verdict.detail).not.toMatch(/SYNTHETIC|RAW_UNTRUSTED|%53%59/)
    expect(verdict.detail).toContain('tierflow::tierflow_pro')
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
    const verdict = await probeDshEndpoint(anthropic, { fetchImpl: fetchReturning(200, ' {"type":"message","content":[]}') })
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
  it('keeps parameter-validation failures advisory through the complete preflight path', async () => {
    const verdict = await preflightDshModel(anthropic, [{ id: 'other', reasoningEfforts: [] }], {
      fetchImpl: fetchReturning(400, JSON.stringify({ error: { code: 'unsupported_parameter', param: 'max_tokens', message: "Unsupported parameter: 'max_tokens' is not supported with this model." } })),
      cli: 'codex',
    })
    expect(verdict.status).toBe('unknown')
    expect(verdict.note).toContain('未声明模型')
    expect(verdict.detail).not.toContain('Unsupported parameter')
  })

  it('attaches the undeclared-model remark to the probe verdict', async () => {
    const verdict = await preflightDshModel(anthropic, [{ id: 'other', reasoningEfforts: [] }], {
      fetchImpl: fetchReturning(200, ' {"type":"message","content":[]}'),
    })
    expect(verdict.status).toBe('ok')
    expect(verdict.note).toContain('tierflow_pro')
  })
})
