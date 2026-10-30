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
import { parse } from 'yaml'

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
  readonly models: readonly DshModelInfo[]
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
      models: declaredModels(profile),
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
