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
