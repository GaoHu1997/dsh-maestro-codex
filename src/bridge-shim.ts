/**
 * The `dsh_bridge` MCP stdio shim — the process a dispatched CLI child spawns
 * as one of its MCP servers. Speaks newline-delimited JSON-RPC on stdin/stdout
 * and proxies every tool call to the plugin's HTTP routes with the per-run
 * token it was handed through the environment. The token dies with the run, so
 * the shim deliberately keeps no auth of its own.
 *
 * Compiled to `lib/bridge-shim.js` (beside `lib/index.js`); spawned via
 * `node <shimPath>` by `bridgeServerEntry`. Runs standalone: imports only the
 * wire constants, never the host-facing half.
 */

import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { awaitWithin, DeadlineError } from './deadline.js'
import { BRIDGE_ACCESS_HEADER, ROUTE_PREFIX } from './wire.js'

const CATALOG_PATH = `${ROUTE_PREFIX}/bridge/catalog`
const CALL_PATH = `${ROUTE_PREFIX}/bridge/call`

/** Budget for the run catalog (and therefore every skill/tool lookup). */
export const CATALOG_TIMEOUT_MS = 20_000
/** Host tool calls can legitimately run long (image/office work); still bounded. */
export const CALL_TIMEOUT_MS = 15 * 60_000
/** After stdin closes, in-flight replies get this long to flush before exit. */
export const SHUTDOWN_GRACE_MS = 2_000

/** Shim runtime configuration, from the environment the entry carries. */
export interface ShimState {
  readonly baseUrl: string
  readonly token: string
}

export function shimStateFromEnv(env: NodeJS.ProcessEnv = process.env): ShimState | undefined {
  const baseUrl = env['MAESTRO_BRIDGE_URL']?.trim() ?? ''
  const token = env['MAESTRO_BRIDGE_TOKEN']?.trim() ?? ''
  if (baseUrl === '' || token === '') return undefined
  return { baseUrl, token }
}

/** One inbound JSON-RPC message (fields the shim reads). */
export interface ShimRequest {
  readonly jsonrpc?: string
  readonly id?: string | number | null
  readonly method?: string
  readonly params?: Record<string, unknown> | undefined
}

/** One outbound JSON-RPC message. */
export interface ShimResponse {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown }
}

/** One MCP tool as `tools/list` answers. */
export interface ShimTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: { readonly type: 'object'; readonly properties: Record<string, unknown> }
}

/** One skill entry of the run catalog, as both list and call paths read it. */
export interface ShimCatalogSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse: string | undefined
  readonly tool: string
}

/** One host tool of the run catalog (schema passed through from the registry). */
export interface ShimCatalogTool {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

export interface ShimCatalog {
  readonly skills: readonly ShimCatalogSkill[]
  readonly tools: readonly ShimCatalogTool[]
}

/** Injection seam for tests; production always uses the global fetch. */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

function errorText(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null && typeof (payload as Record<string, unknown>)['error'] === 'string') {
    return (payload as Record<string, unknown>)['error'] as string
  }
  return `HTTP ${String(status)}`
}

/** Per-request cancellation and budget; the loop supplies both in production. */
export interface ShimRequestOptions {
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
}

interface ShimHttpResult {
  readonly response: Response
  readonly payload: unknown
}

/**
 * One HTTP request including its body, under a single deadline. Response
 * headers arriving does not mean the body will: a stalled body used to keep
 * `tools/list` / `tools/call` pending, and with it the shim after stdin EOF.
 */
async function requestJson(
  url: string | URL,
  init: RequestInit,
  doFetch: FetchLike,
  options: ShimRequestOptions,
  fallbackTimeoutMs: number,
): Promise<ShimHttpResult> {
  const configured = options.timeoutMs
  const timeoutMs = configured !== undefined && Number.isFinite(configured) && configured > 0 ? configured : fallbackTimeoutMs
  const deadline = Date.now() + timeoutMs
  const remaining = (): number => deadline - Date.now()
  const signal = options.signal
  const response = await awaitWithin(
    () => doFetch(url, { ...init, ...(signal === undefined ? {} : { signal }) }),
    { ...(signal === undefined ? {} : { signal }), timeoutMs: Math.max(1, remaining()), label: 'dsh_bridge 请求' },
  )
  const left = remaining()
  if (left <= 0) {
    throw new DeadlineError(`dsh_bridge 请求在 ${String(Math.max(1, Math.round(timeoutMs / 1000)))} 秒内没有完整返回，已放弃等待`, timeoutMs)
  }
  const payload: unknown = await awaitWithin(() => response.json(), {
    ...(signal === undefined ? {} : { signal }),
    timeoutMs: left,
    label: 'dsh_bridge 响应体',
  }).catch((error: unknown) => {
    // Invalid or empty JSON stays a soft failure (callers already tolerate it);
    // a deadline or a cancellation must surface as a real error.
    if (error instanceof DeadlineError) throw error
    if (signal?.aborted === true) throw error
    return undefined
  })
  return { response, payload }
}

/** Fetch the run's catalog from the plugin routes. */
export async function fetchCatalog(
  state: ShimState,
  cwd: string | undefined,
  doFetch: FetchLike = fetch,
  options: ShimRequestOptions = {},
): Promise<ShimCatalog> {
  const url = new URL(CATALOG_PATH, state.baseUrl)
  if (cwd !== undefined && cwd !== '') url.searchParams.set('cwd', cwd)
  const { response, payload } = await requestJson(
    url,
    { headers: { [BRIDGE_ACCESS_HEADER]: state.token } },
    doFetch,
    options,
    CATALOG_TIMEOUT_MS,
  )
  if (!response.ok) throw new Error(errorText(payload, response.status))
  const list = (key: string): unknown[] =>
    typeof payload === 'object' && payload !== null && Array.isArray((payload as Record<string, unknown>)[key])
      ? (payload as Record<string, unknown>)[key] as unknown[]
      : []
  const skills = list('skills').map((raw): ShimCatalogSkill | undefined => {
    const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
    const name = typeof record['name'] === 'string' ? record['name'] : ''
    const tool = typeof record['tool'] === 'string' ? record['tool'] : ''
    if (name === '' || tool === '') return undefined
    return {
      name,
      tool,
      description: typeof record['description'] === 'string' ? record['description'] : '',
      whenToUse: typeof record['whenToUse'] === 'string' ? record['whenToUse'] : undefined,
    }
  }).filter((skill): skill is ShimCatalogSkill => skill !== undefined)
  const tools = list('tools').map((raw): ShimCatalogTool | undefined => {
    const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
    const name = typeof record['name'] === 'string' ? record['name'] : ''
    if (name === '') return undefined
    return {
      name,
      description: typeof record['description'] === 'string' ? record['description'] : '',
      parameters: record['parameters'] ?? { type: 'object', properties: {} },
    }
  }).filter((tool): tool is ShimCatalogTool => tool !== undefined)
  return { skills, tools }
}

/** The MCP tool list one catalog produces: skill loaders + host tools. */
export function toolsOfCatalog(catalog: ShimCatalog): ShimTool[] {
  const skillTools = catalog.skills.map(skill => ({
    name: skill.tool,
    description: [
      `加载 dsh 技能「${skill.name}」的完整指令。`,
      skill.whenToUse !== undefined && skill.whenToUse.trim() !== '' ? `何时使用：${skill.whenToUse}` : `说明：${skill.description}`,
      '任务涉及该技能时先调用本工具取得全文，再按指令执行。',
    ].join(' '),
    inputSchema: { type: 'object' as const, properties: {} },
  }))
  const hostTools = catalog.tools.map(tool => ({
    name: tool.name,
    description: tool.description === '' ? `调用 dsh 宿主工具 ${tool.name}` : tool.description,
    inputSchema: objectSchemaOf(tool.parameters),
  }))
  // A malformed or stale catalog must never publish ambiguous MCP names.
  const counts = new Map<string, number>()
  for (const tool of [...skillTools, ...hostTools]) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
  return [...skillTools, ...hostTools].filter(tool => counts.get(tool.name) === 1)
}

/** Coerce a registry schema into MCP's object form; junk falls back to empty. */
function objectSchemaOf(parameters: unknown): ShimTool['inputSchema'] {
  if (typeof parameters === 'object' && parameters !== null && !Array.isArray(parameters)
    && (parameters as Record<string, unknown>)['type'] === 'object') {
    return parameters as ShimTool['inputSchema']
  }
  return { type: 'object', properties: {} }
}

/** POST one bridge call; resolves the model-facing text, rejects with the route's error. */
async function callBridge(
  state: ShimState,
  body: Record<string, unknown>,
  doFetch: FetchLike,
  options: ShimRequestOptions,
): Promise<string> {
  const { response, payload } = await requestJson(
    new URL(CALL_PATH, state.baseUrl),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', [BRIDGE_ACCESS_HEADER]: state.token },
      body: JSON.stringify(body),
    },
    doFetch,
    options,
    CALL_TIMEOUT_MS,
  )
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  if (!response.ok || record['ok'] !== true || typeof record['text'] !== 'string') {
    throw new Error(typeof record['error'] === 'string' ? record['error'] : `HTTP ${String(response.status)}`)
  }
  return record['text']
}

/** MCP tool-call result: text content plus an isError flag on failure. */
export interface ShimToolCallResult {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>
  readonly isError?: true
}

function textResult(text: string, isError: boolean): ShimToolCallResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  }
}

function rpcResult(id: ShimRequest['id'], result: unknown): ShimResponse {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function rpcError(id: ShimRequest['id'], code: number, message: string): ShimResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

/** JSON-RPC method-not-found. */
const METHOD_NOT_FOUND = -32601

/** Diagnostic code for "the plugin routes answered, but not with a catalog". */
const BRIDGE_UNAVAILABLE = -32000

export interface ShimContext {
  /** The working directory the catalog is scoped to (the CLI child's cwd). */
  readonly cwd?: string | undefined
  /** Pre-seeded catalog (tests); production always refetches per message. */
  readonly catalog?: ShimCatalog | undefined
  readonly fetchImpl?: FetchLike | undefined
  /** Cancellation for this one request (stdin EOF / notifications/cancelled). */
  readonly signal?: AbortSignal | undefined
  /** Per-request HTTP budget; the catalog/call defaults apply when absent. */
  readonly timeoutMs?: number | undefined
}

/**
 * Handle one inbound message. Notifications resolve to undefined (no reply);
 * protocol violations become JSON-RPC errors; tool failures become isError
 * results — per MCP, a failed tool call is a result, not a transport error.
 */
export async function handleShimMessage(state: ShimState, message: ShimRequest, context: ShimContext = {}): Promise<ShimResponse | undefined> {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return rpcError(null, -32600, 'invalid request')
  const doFetch = context.fetchImpl ?? fetch
  const requestOptions: ShimRequestOptions = {
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.timeoutMs === undefined ? {} : { timeoutMs: context.timeoutMs }),
  }
  const method = typeof message.method === 'string' ? message.method : ''
  if (method.startsWith('notifications/')) return undefined
  const id = message.id
  if (method === 'initialize') {
    const params = message.params ?? {}
    // Echo the client's dialect: both supported clients pin their own version.
    const requested = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '2025-06-18'
    return rpcResult(id, {
      protocolVersion: requested,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'dsh_bridge', version: '0.1.0' },
    })
  }
  if (method === 'ping') return rpcResult(id, {})
  if (method === 'tools/list') {
    try {
      const catalog = context.catalog ?? await fetchCatalog(state, context.cwd, doFetch, requestOptions)
      return rpcResult(id, { tools: toolsOfCatalog(catalog) })
    } catch (error) {
      return rpcError(id, BRIDGE_UNAVAILABLE, `dsh_bridge 目录不可用：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (method === 'tools/call') {
    const params = message.params ?? {}
    const name = typeof params['name'] === 'string' ? params['name'] : ''
    if (name === '') return rpcResult(id, textResult('Error: 工具名不能为空', true))
    const cwd = context.cwd
    try {
      const catalog = context.catalog ?? await fetchCatalog(state, cwd, doFetch, requestOptions)
      if (!toolsOfCatalog(catalog).some(tool => tool.name === name)) return rpcResult(id, textResult(`Error: 工具 ${name} 不存在或目录命名冲突`, true))
      const skill = catalog.skills.find(candidate => candidate.tool === name)
      if (skill !== undefined) {
        const text = await callBridge(state, { kind: 'skill', name: skill.name, ...(cwd === undefined ? {} : { cwd }) }, doFetch, requestOptions)
        return rpcResult(id, textResult(text, false))
      }
      const tool = catalog.tools.find(candidate => candidate.name === name)
      if (tool !== undefined) {
        const args = typeof params['arguments'] === 'object' && params['arguments'] !== null && !Array.isArray(params['arguments'])
          ? params['arguments'] as Record<string, unknown>
          : {}
        const text = await callBridge(state, { kind: 'tool', name, arguments: args }, doFetch, requestOptions)
        return rpcResult(id, textResult(text, false))
      }
      return rpcResult(id, textResult(`Error: dsh_bridge 上没有工具 ${name}（目录可能已变化，请重新连接后重试）`, true))
    } catch (error) {
      return rpcResult(id, textResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true))
    }
  }
  return rpcError(id, METHOD_NOT_FOUND, `method not found: ${method}`)
}

/** One writable sink the loop replies to (`process.stdout`, or a test stream). */
export interface ShimWritable {
  write(chunk: string): unknown
  readonly writableEnded?: boolean | undefined
  readonly destroyed?: boolean | undefined
}

export interface ShimLoopIo {
  readonly input: NodeJS.ReadableStream
  readonly output: ShimWritable
  /** Working directory the catalog is scoped to; `process.cwd()` when absent. */
  readonly cwd?: string | undefined
  readonly fetchImpl?: FetchLike | undefined
}

/**
 * The stdio loop: one JSON-RPC message per line, replies in order, bounded
 * shutdown. stdin EOF aborts every in-flight request, so a stalled host call
 * can no longer keep the shim alive after the CLI stopped talking. Extracted
 * from `main` so EOF behaviour is testable with in-memory streams.
 */
export async function runShimLoop(state: ShimState, io: ShimLoopIo): Promise<void> {
  const cwd = io.cwd ?? process.cwd()
  const root = new AbortController()
  const input = createInterface({ input: io.input })
  const pending = new Set<Promise<void>>()
  const byRequestId = new Map<string | number, AbortController>()
  const write = (payload: unknown): void => {
    if (io.output.writableEnded === true || io.output.destroyed === true) return
    try { io.output.write(`${JSON.stringify(payload)}\n`) } catch { /* the reader is gone; nothing to recover */ }
  }
  input.on('line', line => {
    const trimmed = line.trim()
    if (trimmed === '') return
    let parsed: ShimRequest
    try { parsed = JSON.parse(trimmed) as ShimRequest } catch { return }
    // MCP cancellation is a notification, not a request: it must reach the
    // in-flight HTTP call instead of being dropped with the other notifications.
    if (parsed.method === 'notifications/cancelled') {
      const target = parsed.params?.['requestId']
      if (typeof target === 'string' || typeof target === 'number') byRequestId.get(target)?.abort()
      return
    }
    const request = new AbortController()
    const id = parsed.id
    const requestId = typeof id === 'string' || typeof id === 'number' ? id : undefined
    if (requestId !== undefined) byRequestId.set(requestId, request)
    const replyId = requestId ?? null
    const done = handleShimMessage(state, parsed, {
      cwd,
      ...(io.fetchImpl === undefined ? {} : { fetchImpl: io.fetchImpl }),
      signal: AbortSignal.any([root.signal, request.signal]),
    }).then(
      reply => { if (reply !== undefined) write(reply) },
      error => { write(rpcError(replyId, BRIDGE_UNAVAILABLE, error instanceof Error ? error.message : String(error))) },
    ).finally(() => { if (requestId !== undefined) byRequestId.delete(requestId) })
    pending.add(done)
    void done.finally(() => { pending.delete(done) })
  })
  await new Promise<void>(resolve => { input.once('close', () => { resolve() }) })
  // stdin is gone: cancel everything still in flight, give the handlers a
  // short flush window, then return so the caller exits regardless.
  root.abort(new DOMException('dsh_bridge stdin 已关闭', 'AbortError'))
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, SHUTDOWN_GRACE_MS)
    function done(): void {
      clearTimeout(timer)
      resolve()
    }
    void Promise.allSettled([...pending]).then(done)
  })
}

/** The stdio entry point: env-configured state, real process streams. */
export function main(): void {
  const state = shimStateFromEnv()
  if (state === undefined) {
    process.stderr.write('[dsh_bridge] missing MAESTRO_BRIDGE_URL / MAESTRO_BRIDGE_TOKEN — exiting\n')
    process.exit(1)
  }
  void runShimLoop(state, { input: process.stdin, output: process.stdout })
    .catch(() => { /* shutdown is best effort; never leave the shim spinning */ })
    .then(() => process.exit(0))
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
}
