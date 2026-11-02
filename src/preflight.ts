/**
 * Preflight for a resolved dsh model endpoint.
 *
 * `protocolProblem` already keeps a CLI from being handed a protocol it cannot
 * speak; this is the second half of the story — the model *name*. A selection
 * like `tierflow::tierflow_pro` may name a gateway alias the provider never
 * declared, or a model the endpoint no longer serves. Without a check, the only
 * symptoms are a mid-run 4xx or a CLI "unrecognized model" warning the operator
 * has to decode. One tiny request before the child spawns turns both into a
 * sentence naming the provider and the model.
 *
 * The probe is advisory by contract: `unknown` (network, timeout, unexpected
 * status) never blocks a dispatch — only a definite "this endpoint does not
 * serve this model" does.
 */

import type { DshModelEndpoint, DshModelInfo } from './dsh-models.js'
import { publicEndpointUrl, transportDiagnostic } from './public-diagnostics.js'

/** How long the probe may take before the dispatch stops waiting for it. */
export const PREFLIGHT_TIMEOUT_MS = 8_000

export interface DshPreflight {
  /**
   * `ok` — the endpoint answered for this model; `mismatch` — it definitely does
   * not serve it (the candidate must be rejected); `unknown` — no verdict
   * (network/timeout/odd status), so the dispatch proceeds.
   */
  status: 'ok' | 'mismatch' | 'unknown'
  /** One agent-facing line; doubles as the note text and the failure reason. */
  detail: string
  /** Non-blocking remark (e.g. an undeclared model id). */
  note?: string | undefined
}

/** Model-name words used to tell "bad model" apart from "bad request". */
const MODEL_WORD = /\bmodel\b|模型/i
const MISSING_WORD = /not\s*found|does\s+not\s+exist|no\s+such|unknown|unsupported|not\s+supported|invalid|不存在|不支持|无效|未找到/i

/**
 * A provider that declares its models is making a promise the selection has to
 * keep; a provider that declares none cannot be checked at all. Never fatal —
 * gateways legitimately expose aliases they do not list.
 */
export function declaredModelProblem(endpoint: DshModelEndpoint, declared: readonly DshModelInfo[]): string | undefined {
  if (declared.length === 0) return undefined
  if (declared.some(model => model.id === endpoint.model)) return undefined
  const known = declared.slice(0, 6).map(model => model.id).join('、')
  return `供应商 ${endpoint.provider} 未声明模型 "${endpoint.model}"（已声明：${known}${declared.length > 6 ? '…' : ''}），可能是网关别名；仍按原名传给 CLI`
}

function trimBase(baseURL: string): string {
  return baseURL.replace(/\/+$/, '')
}

/** The minimal request that proves the endpoint serves this model. */
export function probeRequest(endpoint: DshModelEndpoint): { url: string; init: RequestInit } {
  const base = trimBase(endpoint.baseURL)
  const atV1 = base.endsWith('/v1')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  let path: string
  let body: unknown
  if (endpoint.api === 'anthropic-messages') {
    path = atV1 ? '/messages' : '/v1/messages'
    // Claude Code authenticates with `Authorization: Bearer`; Anthropic's own
    // API expects `x-api-key`. Send both so a gateway accepting either passes.
    headers['x-api-key'] = endpoint.apiKey
    headers['authorization'] = `Bearer ${endpoint.apiKey}`
    headers['anthropic-version'] = '2023-06-01'
    body = { model: endpoint.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
  } else if (endpoint.api === 'openai-responses') {
    path = atV1 ? '/responses' : '/v1/responses'
    headers['authorization'] = `Bearer ${endpoint.apiKey}`
    body = { model: endpoint.model, input: 'ping', max_output_tokens: 16 }
  } else {
    path = atV1 ? '/chat/completions' : '/v1/chat/completions'
    headers['authorization'] = `Bearer ${endpoint.apiKey}`
    body = { model: endpoint.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }
  }
  return { url: `${base}${path}`, init: { method: 'POST', headers, body: JSON.stringify(body) } }
}

/** Turn one probe response into a verdict. */
export function classifyProbe(endpoint: DshModelEndpoint, status: number, bodyText: string): DshPreflight {
  const label = `${endpoint.provider}::${endpoint.model}`
  // Response bodies may echo credentials in arbitrary or encoded forms. They
  // are used only for classification, never copied into agent-visible details.
  if (status >= 200 && status < 300) {
    let raw: unknown
    try { raw = JSON.parse(bodyText) } catch { raw = undefined }
    const response = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const valid = endpoint.api === 'anthropic-messages' ? response['type'] === 'message' && Array.isArray(response['content'])
      : endpoint.api === 'openai-responses' ? response['object'] === 'response' && Array.isArray(response['output'])
        : Array.isArray(response['choices'])
    return valid ? { status: 'ok', detail: `预检通过：${label} 可服务` }
      : { status: 'unknown', detail: `模型预检 HTTP ${status} 响应不符合 ${endpoint.api} 协议，无法确认 ${label} 可用（仍尝试派发）` }
  }
  if (status === 404) {
    return { status: 'mismatch', detail: `模型预检失败：${publicEndpointUrl(endpoint.baseURL)} 对 ${label} 返回 404（端点或模型不存在）` }
  }
  if (status === 401 || status === 403) {
    return { status: 'mismatch', detail: `模型预检失败：${label} 被端点拒绝鉴权（HTTP ${String(status)}），请检查端点鉴权配置` }
  }
  if (MODEL_WORD.test(bodyText) && MISSING_WORD.test(bodyText)) {
    return { status: 'mismatch', detail: `模型预检失败：端点不认这个模型 ${label}（HTTP ${String(status)}）` }
  }
  return { status: 'unknown', detail: `模型预检返回 HTTP ${String(status)}，无法判定 ${label} 是否可用（仍尝试派发）` }
}

/**
 * Ask the endpoint to serve one token of this model.
 *
 * Transport failures become `unknown`; caller cancellation always propagates
 * unchanged and must never authorize a CLI launch.
 */
export async function probeDshEndpoint(
  endpoint: DshModelEndpoint,
  options: { fetchImpl?: typeof fetch | undefined; timeoutMs?: number | undefined; cli?: 'codex' | 'claude' | undefined; signal?: AbortSignal | undefined } = {},
): Promise<DshPreflight> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS
  const actualEndpoint: DshModelEndpoint = options.cli === 'codex' && endpoint.api === 'openai-completions'
    ? { ...endpoint, api: 'openai-responses' } : endpoint
  const { url, init } = probeRequest(actualEndpoint)
  options.signal?.throwIfAborted()
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    options.signal?.throwIfAborted()
    const text = await response.text().catch(() => '')
    options.signal?.throwIfAborted()
    return classifyProbe(actualEndpoint, response.status, text)
  } catch (error) {
    options.signal?.throwIfAborted()
    const reason = transportDiagnostic(error)
    return { status: 'unknown', detail: `模型预检无法连通 ${endpoint.provider}::${endpoint.model}（${reason}），仍尝试派发` }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/** Declared-model remark + probe verdict, in the shape the dispatcher consumes. */
export async function preflightDshModel(
  endpoint: DshModelEndpoint,
  declared: readonly DshModelInfo[],
  options: { fetchImpl?: typeof fetch | undefined; timeoutMs?: number | undefined; cli?: 'codex' | 'claude' | undefined; signal?: AbortSignal | undefined } = {},
): Promise<DshPreflight> {
  const note = declaredModelProblem(endpoint, declared)
  const verdict = await probeDshEndpoint(endpoint, options)
  return note === undefined ? verdict : { ...verdict, note }
}
