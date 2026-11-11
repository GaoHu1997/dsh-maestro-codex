/**
 * Reading dsh's own model catalog for CLI mapping. The source is the composed
 * `llm-pi-ai` settings namespace: its `providers` record carries each route's
 * wire protocol (`api`), `baseURL`, `apiKeyEnv` and the statically declared
 * `models` list — exactly the facts a CLI subprocess needs to reach the same
 * endpoint with the same credentials the host itself uses.
 *
 * A provider is *mappable* when it has a baseURL, a resolvable key reference
 * and a wire protocol a CLI can speak: codex maps over both OpenAI dialects,
 * claude only over `anthropic-messages`.
 *
 * One route can serve more than one endpoint. `dsh-model-think-level` keeps the
 * extra addresses (one OpenAI family, one Anthropic family) and the per-key
 * protocol pins in its own `key-index.json`, beside the harness home; the
 * catalog below folds that metadata over the official profile so a route that
 * carries both `/v1` and `/anthropic` yields one entry per family instead of
 * only the profile's own `api`. Deployments without the plugin have no index
 * file and keep the single-endpoint behaviour unchanged.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { parse } from 'yaml'
import { publicEndpointUrl } from './public-diagnostics.js'

/** Wire protocols a CLI subprocess can speak directly. */
export type MappableApi = 'anthropic-messages' | 'openai-completions' | 'openai-responses'

/** The address family a wire protocol draws its base URL from. */
export type DshEndpointFamily = 'openai' | 'anthropic'

/** Which family a protocol belongs to (anything not Anthropic is OpenAI-family). */
export function endpointFamilyOf(api: string): DshEndpointFamily {
  return api === 'anthropic-messages' ? 'anthropic' : 'openai'
}

/**
 * One key the think-level plugin lists for a route. Metadata only — the value
 * lives in the harness credential store under `ref`.
 */
export interface ThinkLevelKey {
  readonly ref: string
  /** Model scope; absent means catch-all, an empty list means nothing. */
  readonly models?: readonly string[]
  /** Pinned wire protocol; absent means "automatic" (per-model family). */
  readonly protocol?: MappableApi
  /** Switched out of the routing pool. */
  readonly disabled?: boolean
}

/** The slice of `dsh-model-think-level/key-index.json` this module consumes. */
export interface ThinkLevelIndex {
  readonly keys: Readonly<Record<string, readonly ThinkLevelKey[]>>
  readonly endpoints: Readonly<Record<string, { readonly openai?: string; readonly anthropic?: string }>>
}

/** One dsh provider endpoint as the CLI mapping needs it. */
export interface DshProviderInfo {
  /** Provider route id (the `provider` selection half). */
  readonly id: string
  readonly displayName: string
  readonly api: string
  readonly baseURL: string
  /** Whether a key reference (env var name) is configured. */
  readonly hasKeyRef: boolean
  /** Whether the protocol + key allow handing this provider to a CLI. */
  readonly mappable: boolean
  readonly models: readonly DshModelInfo[]
  /** Credential refs that may sign this endpoint, in preference order. */
  readonly keyRefs: readonly string[]
  /** The think-level keys behind those refs (empty for an official-only route). */
  readonly keys: readonly ThinkLevelKey[]
  /** Where this entry came from: the official profile or the extra address. */
  readonly origin: 'host' | 'think-level'
}

/** One model in a provider's catalog, with its configured reasoning efforts. */
export interface DshModelInfo {
  readonly id: string
  /**
   * The effort keys the model declares under `reasoningEfforts` (order kept
   * from the settings map). Empty when the entry is a bare id or declares none
   * — the card then only offers the CLI's own default.
   */
  readonly reasoningEfforts: readonly string[]
}

export interface DshModelCatalog {
  readonly providers: readonly DshProviderInfo[]
}

/** A resolved endpoint a CLI child can be pointed at. */
export interface DshModelEndpoint {
  readonly provider: string
  readonly model: string
  readonly api: MappableApi
  readonly baseURL: string
  readonly apiKey: string
}

/** The settings-service face this module needs (structural, host-owned). */
export interface SettingsDescribeFace {
  describe(): Array<{ ns: string; value?: unknown }>
}

/** The credentials-service face this module needs (structural, host-owned). */
export interface CredentialsFace {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
}

const PI_NS = 'llm-pi-ai'
const MappableApis: readonly string[] = ['anthropic-messages', 'openai-completions', 'openai-responses']

/** A `provider::model` selection string parses into two non-empty halves. */
export function parseDshModelSelection(value: string): { provider: string; model: string } | undefined {
  const index = value.indexOf('::')
  if (index <= 0 || index === value.length - 2) return undefined
  const provider = value.slice(0, index)
  const model = value.slice(index + 2)
  if (provider.trim() === '' || model.trim() === '') return undefined
  return { provider, model }
}

export function dshModelSelectionError(value: string): string | undefined {
  if (value === '') return undefined
  if (parseDshModelSelection(value) === undefined) return 'dsh 模型选择格式必须是 <provider>::<model>'
  return undefined
}

/** The `llm-pi-ai` provider profiles from the composed settings, keyed by route. */
export function providerProfiles(settings: SettingsDescribeFace | undefined): Record<string, Record<string, unknown>> {
  if (settings === undefined) return {}
  let entries: Array<{ ns: string; value?: unknown }>
  try {
    entries = settings.describe()
  } catch {
    return {}
  }
  const entry = entries.find(candidate => candidate.ns === PI_NS)
  const value = entry?.value
  if (typeof value !== 'object' || value === null) return {}
  const providers = (value as Record<string, unknown>)['providers']
  if (typeof providers !== 'object' || providers === null) return {}
  return providers as Record<string, Record<string, unknown>>
}

/**
 * The statically declared models of one provider profile: string entries are
 * bare ids; object entries carry `id` plus the `reasoningEfforts` map whose
 * keys are the effort levels the card offers for that model.
 */
export function declaredModels(profile: Record<string, unknown>): DshModelInfo[] {
  const models = profile['models']
  if (!Array.isArray(models)) return []
  const parsed: Array<DshModelInfo | undefined> = models.map((model): DshModelInfo | undefined => {
    if (typeof model === 'string') return model.trim() === '' ? undefined : { id: model.trim(), reasoningEfforts: [] }
    if (typeof model !== 'object' || model === null) return undefined
    const entry = model as Record<string, unknown>
    const id = entry['id']
    if (typeof id !== 'string' || id.trim() === '') return undefined
    const efforts = entry['reasoningEfforts']
    const keys = typeof efforts === 'object' && efforts !== null && !Array.isArray(efforts)
      ? Object.keys(efforts).filter(key => key.trim() !== '')
      : []
    return { id: id.trim(), reasoningEfforts: keys }
  })
  return parsed.filter((model): model is DshModelInfo => model !== undefined)
}

/** Default location of the think-level plugin's metadata index. */
export function thinkLevelIndexPath(home: string = homedir(), dshHome: string | undefined = process.env['DSH_HOME']): string {
  return join(dshHome ?? join(home, '.dsh'), 'dsh-model-think-level', 'key-index.json')
}

/**
 * Read the think-level index, or an empty one when the plugin is absent or the
 * file is unreadable. Every entry is validated independently: a hand-edited or
 * truncated file costs at most the lines it got wrong, never the official
 * catalog, and a deployment without the plugin behaves exactly as before.
 */
export function readThinkLevelIndex(file: string = thinkLevelIndexPath()): ThinkLevelIndex {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return { keys: {}, endpoints: {} }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { keys: {}, endpoints: {} }
  const document = raw as Record<string, unknown>
  const keys: Record<string, ThinkLevelKey[]> = {}
  const rawProviders = document['providers']
  if (typeof rawProviders === 'object' && rawProviders !== null && !Array.isArray(rawProviders)) {
    for (const [route, list] of Object.entries(rawProviders as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue
      const entries: ThinkLevelKey[] = []
      for (const item of list) {
        if (typeof item !== 'object' || item === null) continue
        const entry = item as Record<string, unknown>
        const ref = typeof entry['ref'] === 'string' ? entry['ref'].trim() : ''
        if (ref === '') continue
        const models = Array.isArray(entry['models'])
          ? entry['models'].filter((model): model is string => typeof model === 'string' && model.trim() !== '').map(model => model.trim())
          : undefined
        const protocol = entry['protocol'] === 'anthropic-messages' || entry['protocol'] === 'openai-completions' || entry['protocol'] === 'openai-responses'
          ? entry['protocol']
          : undefined
        entries.push({
          ref,
          ...(models === undefined ? {} : { models }),
          ...(protocol === undefined ? {} : { protocol }),
          ...(entry['disabled'] === true ? { disabled: true } : {}),
        })
      }
      if (entries.length > 0) keys[route] = entries
    }
  }
  const endpoints: Record<string, { openai?: string; anthropic?: string }> = {}
  const rawEndpoints = document['endpoints']
  if (typeof rawEndpoints === 'object' && rawEndpoints !== null && !Array.isArray(rawEndpoints)) {
    for (const [route, value] of Object.entries(rawEndpoints as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const entry = value as Record<string, unknown>
      const openai = usableEndpointUrl(entry['openai'])
      const anthropic = usableEndpointUrl(entry['anthropic'])
      if (openai === undefined && anthropic === undefined) continue
      endpoints[route] = { ...(openai === undefined ? {} : { openai }), ...(anthropic === undefined ? {} : { anthropic }) }
    }
  }
  return { keys, endpoints }
}

/** A configured endpoint URL, trimmed and http(s)-only; anything else is absent. */
function usableEndpointUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : undefined
  } catch {
    return undefined
  }
}

/** One route endpoint before the catalog decodes it for display. */
interface RawEndpoint {
  readonly id: string
  readonly displayName: string
  readonly api: string
  readonly baseURL: string
  readonly apiKeyEnv: string
  readonly models: readonly DshModelInfo[]
  readonly keys: readonly ThinkLevelKey[]
  readonly origin: 'host' | 'think-level'
}

/**
 * Every endpoint the composed profile plus the think-level index describes: the
 * official route itself, then each extra address family that route stores.
 * Duplicates (same protocol + same URL) collapse, so an address equal to the
 * route's own `baseURL` adds nothing.
 */
function rawEndpoints(profiles: Record<string, Record<string, unknown>>, index: ThinkLevelIndex): RawEndpoint[] {
  const out: RawEndpoint[] = []
  for (const [route, profile] of Object.entries(profiles)) {
    if (typeof profile !== 'object' || profile === null) continue
    const api = typeof profile['api'] === 'string' ? profile['api'].trim() : ''
    const baseURL = typeof profile['baseURL'] === 'string' ? profile['baseURL'].trim() : ''
    const apiKeyEnv = typeof profile['apiKeyEnv'] === 'string' ? profile['apiKeyEnv'].trim() : ''
    const displayName = typeof profile['displayName'] === 'string' && profile['displayName'].trim() !== ''
      ? profile['displayName'].trim()
      : route
    const models = declaredModels(profile)
    const keys = index.keys[route] ?? []
    const seen = new Set<string>()
    const push = (entryApi: string, entryBaseURL: string, origin: 'host' | 'think-level'): void => {
      if (entryBaseURL === '' && origin === 'think-level') return
      const fingerprint = `${entryApi}\n${entryBaseURL}`
      if (seen.has(fingerprint)) return
      seen.add(fingerprint)
      out.push({ id: route, displayName, api: entryApi, baseURL: entryBaseURL, apiKeyEnv, models, keys, origin })
    }
    push(api, baseURL, 'host')
    const extra = index.endpoints[route]
    if (extra !== undefined) {
      push('anthropic-messages', extra.anthropic ?? '', 'think-level')
      // The OpenAI family address serves both dialects; keep the route's own
      // dialect when it already is one (codex drives either over responses).
      push(endpointFamilyOf(api) === 'openai' && api !== '' ? api : 'openai-completions', extra.openai ?? '', 'think-level')
    }
  }
  return out
}

/**
 * Credential refs that may sign one endpoint for one model, in preference
 * order: scope + protocol-family matches first, then any key in scope, then
 * catch-all keys, and finally the route's own `apiKeyEnv`. A key the
 * think-level plugin switched off — or one whose explicit scope is empty or
 * names other models — is never used; its scope is the user's intent, not a
 * hint. An official-only route yields exactly its `apiKeyEnv`, which is the
 * pre-plugin behaviour.
 */
function keyRefsFor(entry: RawEndpoint, model: string): string[] {
  const refs: string[] = []
  const push = (ref: string): void => {
    if (ref !== '' && !refs.includes(ref)) refs.push(ref)
  }
  const family = endpointFamilyOf(entry.api)
  const enabled = entry.keys.filter(key => key.disabled !== true)
  const catchAll = (key: ThinkLevelKey): boolean => key.models === undefined
  const inScope = (key: ThinkLevelKey): boolean => key.models === undefined || key.models.includes(model)
  for (const key of enabled) {
    if (inScope(key) && (key.protocol === undefined || endpointFamilyOf(key.protocol) === family)) push(key.ref)
  }
  for (const key of enabled) if (inScope(key)) push(key.ref)
  for (const key of enabled) if (catchAll(key)) push(key.ref)
  push(entry.apiKeyEnv)
  return refs
}

/** List the dsh model catalog joined with CLI-mappability facts. */
export async function listDshModels(_ctx: Context, settings: SettingsDescribeFace | undefined, index: ThinkLevelIndex = readThinkLevelIndex()): Promise<DshModelCatalog> {
  const providers = rawEndpoints(providerProfiles(settings), index).map((entry): DshProviderInfo => {
    // Any model may be signed by these: enabled keys with a non-empty scope
    // (catch-all or a named set) plus the route's own reference. Whether a
    // particular model is covered is decided per dispatch by `keyRefsFor`.
    const keyRefs = [...new Set([
      ...entry.keys.filter(key => key.disabled !== true && (key.models === undefined || key.models.length > 0)).map(key => key.ref),
      entry.apiKeyEnv,
    ].filter(ref => ref !== ''))]
    const mappable = (MappableApis as readonly string[]).includes(entry.api) && entry.baseURL !== '' && keyRefs.length > 0
    return {
      id: entry.id,
      displayName: entry.displayName,
      api: entry.api,
      baseURL: publicEndpointUrl(entry.baseURL),
      hasKeyRef: keyRefs.length > 0,
      mappable,
      models: entry.models,
      keyRefs,
      keys: entry.keys,
      origin: entry.origin,
    }
  })
  providers.sort((a, b) => a.displayName.localeCompare(b.displayName)
    || a.id.localeCompare(b.id)
    || (a.origin === b.origin ? 0 : a.origin === 'host' ? -1 : 1)
    || a.api.localeCompare(b.api))
  return { providers }
}

/**
 * Resolve one `provider::model` selection into a concrete endpoint + key for a
 * CLI child. When the CLI is known its protocol family decides which of the
 * route's endpoints is used — claude picks the Anthropic address, codex and
 * grok the OpenAI one — so a route that carries both families stays a single
 * `<provider>::<model>` choice in the picker. Throws a user-facing message when
 * the provider vanished, no endpoint matches the CLI, or the key cannot be
 * resolved.
 */
export async function resolveDshModelEndpoint(
  ctx: Context,
  settings: SettingsDescribeFace | undefined,
  selection: string,
  cli?: 'claude' | 'codex' | 'grok',
  index: ThinkLevelIndex = readThinkLevelIndex(),
): Promise<DshModelEndpoint> {
  const parsed = parseDshModelSelection(selection)
  if (parsed === undefined) throw new Error(`dsh 模型选择无效：${selection}`)
  const profiles = providerProfiles(settings)
  const profile = profiles[parsed.provider]
  if (typeof profile !== 'object' || profile === null) {
    throw new Error(`dsh 供应商 "${parsed.provider}" 不存在（可能已被移除），请重新在配置页选择`)
  }
  const entries = rawEndpoints(profiles, index).filter(entry => entry.id === parsed.provider)
  const family = cli === undefined ? undefined : endpointFamilyOf(cli === 'claude' ? 'anthropic-messages' : 'openai-completions')
  const candidates = family === undefined ? entries : entries.filter(entry => endpointFamilyOf(entry.api) === family)
  if (candidates.length === 0) {
    const apis = [...new Set(entries.map(entry => entry.api).filter(api => api !== ''))]
    const describe = apis.length === 0 ? '未知' : apis.join(' / ')
    throw new Error(`dsh 供应商 "${parsed.provider}" 只提供 ${describe} 协议端点，${cli ?? 'CLI'} 子代理无法使用；请在配置页改用兼容该协议的供应商，或给该供应商补上对应地址族的端点`)
  }
  // Host endpoint first: it is what dsh itself uses. A route whose host
  // protocol cannot be mapped still has its extra family to fall back to.
  const ordered = [...candidates].sort((a, b) => (a.origin === b.origin ? 0 : a.origin === 'host' ? -1 : 1))
  const endpoint = ordered.find(entry => (MappableApis as readonly string[]).includes(entry.api) && entry.baseURL !== '')
  if (endpoint === undefined) {
    const first = ordered[0]
    if (first === undefined) throw new Error(`dsh 供应商 "${parsed.provider}" 没有可用端点`)
    if (!(MappableApis as readonly string[]).includes(first.api)) {
      throw new Error(`dsh 供应商 "${parsed.provider}" 的协议（${first.api || '未知'}）无法直接映射给 CLI 子代理，请在配置页换一个 OpenAI/Anthropic 兼容的供应商`)
    }
    throw new Error(`dsh 供应商 "${parsed.provider}" 未配置 baseURL`)
  }
  const keyRefs = keyRefsFor(endpoint, parsed.model)
  if (keyRefs.length === 0) throw new Error(`dsh 供应商 "${parsed.provider}" 未配置密钥引用（apiKeyEnv）`)
  for (const ref of keyRefs) {
    const apiKey = await resolveKey(ctx, ref)
    if (apiKey !== '') {
      return { provider: parsed.provider, model: parsed.model, api: endpoint.api as MappableApi, baseURL: endpoint.baseURL, apiKey }
    }
  }
  throw new Error(`无法解析 dsh 供应商 "${parsed.provider}" 的密钥（${keyRefs.join(', ')}）`)
}

async function resolveKey(ctx: Context, apiKeyEnv: string): Promise<string> {
  // dsh persists credential references in `$DSH_HOME/.credentials.yaml` under a
  // flat `refs:` map ("<ENV_NAME>: <value>") — the same store the credentials
  // service resolves. Read it directly: a plugin-facing context throws on
  // undeclared service property access ("without inject"), and the host may not
  // export the variable into the process env. Values travel to the CLI child
  // env only; they are never logged.
  const fromFile = credentialFileRefs()[apiKeyEnv]
  if (fromFile !== undefined && fromFile !== '') return fromFile
  try {
    // Cordis throws on undeclared service property access — the guard is the
    // control flow, not paranoia.
    const credentials = (ctx as unknown as { credentials?: CredentialsFace }).credentials
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<undefined>(resolvePromise => {
        timer = setTimeout(() => resolvePromise(undefined), 5_000)
        timer.unref?.()
      })
      try {
        const resolved = await Promise.race([credentials.resolve(apiKeyEnv), timeout])
        if (resolved?.value !== undefined && resolved.value !== '') return resolved.value
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
  } catch { /* no credentials service on this context */ }
  return process.env[apiKeyEnv] ?? ''
}

/**
 * The `refs:` map of `$DSH_HOME/.credentials.yaml`. Read on every call — the
 * file is tiny, and a process-lifetime cache meant a key edited in the app
 * never reached a dispatch until the next restart.
 */
export function credentialFileRefs(home: string = homedir(), dshHome: string | undefined = process.env['DSH_HOME']): Record<string, string> {
  const refs: Record<string, string> = {}
  try {
    const file = join(dshHome ?? join(home, '.dsh'), '.credentials.yaml')
    const parsed = parse(readFileSync(file, 'utf8')) as unknown
    const raw = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['refs'] : undefined
    if (typeof raw === 'object' && raw !== null) {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'string') {
          if (value !== '') refs[key] = value
        } else if (typeof value === 'number' || typeof value === 'boolean') {
          refs[key] = String(value)
        }
      }
    }
  } catch {
    // No credentials file (or unreadable) — the ambient env is the last resort.
  }
  return refs
}
