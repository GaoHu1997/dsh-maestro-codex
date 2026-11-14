/** Public endpoint labels never carry URL credentials, queries or fragments.
 * The resolver retains its private URL separately for the actual request.
 */
export function publicEndpointUrl(value: string): string {
  if (value === '') return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '（无效端点 URL）'
    if (url.username === '' && url.password === '' && url.search === '' && url.hash === '') return value
    url.username = ''
    url.password = ''
    // Even an unfamiliar query key may contain a credential; this is a label,
    // not an executable endpoint, so all query values are intentionally omitted.
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    // Malformed credential URLs are not safe to display verbatim either.
    return '（无效端点 URL）'
  }
}

/** Keep diagnostic usefulness without echoing arbitrary exception text.
 * Only a fixed allowlist of transport codes can cross the output boundary.
 */
const TRANSPORT_CODES = [
  'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
] as const

export function transportDiagnostic(error: unknown): string {
  let text = ''
  if (error instanceof Error) {
    text = error.message
    if (error.cause instanceof Error) text += ` ${error.cause.message}`
  }
  const code = TRANSPORT_CODES.find(candidate => new RegExp(`\\b${candidate}\\b`).test(text))
  if (code !== undefined) return code
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) return '请求超时或中止'
  return '网络或传输错误'
}

/** Model-facing failure facts. Raw stderr stays in the authorized task detail. */
export interface CliFailureInput {
  readonly phase: string
  readonly error?: string | undefined
  readonly exitCode: number | null
}

const FAILURE_PHASES = ['failed', 'cancelled', 'timeout', 'interrupted'] as const

/** Categorize private text, but publish only fixed labels and numeric facts. */
export function cliFailureDiagnostic(input: CliFailureInput): string {
  const phase = (FAILURE_PHASES as readonly string[]).includes(input.phase) ? input.phase : 'failed'
  const text = input.error ?? ''
  const category = phase === 'cancelled' ? 'cancelled'
    : phase === 'timeout' ? 'timeout'
    : phase === 'interrupted' ? 'interrupted'
    : /category=authentication|\b401\b|\b403\b|unauthori[sz]ed|authentication|invalid.?api.?key/i.test(text) ? 'authentication'
    : /category=rate-limit|\b429\b|rate.?limit|too many requests|quota|限流|额度/i.test(text) ? 'rate-limit'
    : /category=timeout|timed? ?out|timeout|超时/i.test(text) ? 'timeout'
    : /category=access-policy|permission.?denied|access.?denied|sandbox.*fail|权限.*拒绝/i.test(text) ? 'access-policy'
    : /category=transport|ECONN|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR|network|网络|stream.*disconnect/i.test(text) ? 'transport'
    : /category=invalid-result|未返回.*(?:结果|答复)|缺少.*(?:终态|completed)|invalid.?result|terminal.*(?:missing|invalid)|result.*(?:缺失|为空)/i.test(text) ? 'invalid-result'
    : typeof input.exitCode === 'number' && input.exitCode !== 0 ? 'process'
    : 'unknown'
  const exit = typeof input.exitCode === 'number' && Number.isSafeInteger(input.exitCode) ? `, exitCode=${input.exitCode}` : ''
  return `CLI 失败（phase=${phase}, category=${category}${exit}）；原始诊断与部分输出已保留在任务详情`
}
