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
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** Wire protocols a CLI subprocess can speak directly. */
export type MappableApi = 'anthropic-messages' | 'openai-completions' | 'openai-responses'

/** One dsh provider as the CLI mapping needs it. */
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
  readonly models: readonly string[]
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

/** The statically declared model ids of one provider profile. */
export function declaredModelIds(profile: Record<string, unknown>): string[] {
  const models = profile['models']
  if (!Array.isArray(models)) return []
  return models
    .map(model => typeof model === 'string' ? model : typeof model === 'object' && model !== null ? (model as Record<string, unknown>)['id'] : undefined)
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
}

/** List the dsh model catalog joined with CLI-mappability facts. */
export async function listDshModels(_ctx: Context, settings: SettingsDescribeFace | undefined): Promise<DshModelCatalog> {
  const profiles = providerProfiles(settings)
  const providers: DshProviderInfo[] = []
  for (const [route, profile] of Object.entries(profiles)) {
    if (typeof profile !== 'object' || profile === null) continue
    const api = typeof profile['api'] === 'string' ? profile['api'] : ''
    const baseURL = typeof profile['baseURL'] === 'string' ? profile['baseURL'].trim() : ''
    const apiKeyEnv = typeof profile['apiKeyEnv'] === 'string' ? profile['apiKeyEnv'].trim() : ''
    const displayName = typeof profile['displayName'] === 'string' && profile['displayName'].trim() !== ''
      ? profile['displayName'].trim()
      : route
    const mappable = (MappableApis as readonly string[]).includes(api) && baseURL !== '' && apiKeyEnv !== ''
    providers.push({
      id: route,
      displayName,
      api,
      baseURL,
      hasKeyRef: apiKeyEnv !== '',
      mappable,
      models: declaredModelIds(profile),
    })
  }
  providers.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return { providers }
}

/**
 * Resolve one `provider::model` selection into a concrete endpoint + key for a
 * CLI child. Throws a user-facing message when the provider vanished, is not
 * mappable, or its key cannot be resolved.
 */
export async function resolveDshModelEndpoint(ctx: Context, settings: SettingsDescribeFace | undefined, selection: string): Promise<DshModelEndpoint> {
  const parsed = parseDshModelSelection(selection)
  if (parsed === undefined) throw new Error(`dsh 模型选择无效：${selection}`)
  const profiles = providerProfiles(settings)
  const profile = profiles[parsed.provider]
  if (typeof profile !== 'object' || profile === null) {
    throw new Error(`dsh 供应商 "${parsed.provider}" 不存在（可能已被移除），请重新在配置页选择`)
  }
  const api = typeof profile['api'] === 'string' ? profile['api'] : ''
  const baseURL = typeof profile['baseURL'] === 'string' ? profile['baseURL'].trim() : ''
  const apiKeyEnv = typeof profile['apiKeyEnv'] === 'string' ? profile['apiKeyEnv'].trim() : ''
  if (!(MappableApis as readonly string[]).includes(api)) {
    throw new Error(`dsh 供应商 "${parsed.provider}" 的协议（${api || '未知'}）无法直接映射给 CLI 子代理，请在配置页换一个 OpenAI/Anthropic 兼容的供应商`)
  }
  if (baseURL === '') throw new Error(`dsh 供应商 "${parsed.provider}" 未配置 baseURL`)
  if (apiKeyEnv === '') throw new Error(`dsh 供应商 "${parsed.provider}" 未配置密钥引用（apiKeyEnv）`)

  const apiKey = await resolveKey(ctx, apiKeyEnv)
  if (apiKey === '') throw new Error(`无法解析 dsh 供应商 "${parsed.provider}" 的密钥（${apiKeyEnv}）`)
  return { provider: parsed.provider, model: parsed.model, api: api as MappableApi, baseURL, apiKey }
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
      const resolved = await Promise.race([
        credentials.resolve(apiKeyEnv),
        new Promise<undefined>(resolvePromise => { setTimeout(() => resolvePromise(undefined), 5_000) }),
      ])
      if (resolved?.value !== undefined && resolved.value !== '') return resolved.value
    }
  } catch { /* no credentials service on this context */ }
  return process.env[apiKeyEnv] ?? ''
}

/** The `refs:` map of `$DSH_HOME/.credentials.yaml`, parsed once per process. */
let credentialRefsCache: Record<string, string> | undefined

export function credentialFileRefs(home: string = homedir(), dshHome: string | undefined = process.env['DSH_HOME']): Record<string, string> {
  if (credentialRefsCache !== undefined) return credentialRefsCache
  const refs: Record<string, string> = {}
  try {
    const file = join(dshHome ?? join(home, '.dsh'), '.credentials.yaml')
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    let inRefs = false
    for (const line of lines) {
      if (/^refs:\s*$/.test(line)) {
        inRefs = true
        continue
      }
      if (!inRefs) continue
      if (/^\S/.test(line)) break // next top-level key: refs section over
      const match = /^ {2}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
      const name = match?.[1]
      const value = match?.[2]
      if (name !== undefined && value !== undefined) refs[name] = value.trim()
    }
  } catch {
    // No credentials file (or unreadable) — the ambient env is the last resort.
  }
  credentialRefsCache = refs
  return refs
}
