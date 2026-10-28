/**
 * Plugin configuration: one flat, settings-projected surface. Every field is
 * `.volatile()`, so the dsh settings service projects them into live
 * configuration forms, and the plugin provides its own dedicated card (the
 * `auto: false` presentation policy) with CLI management and the task monitor
 * on top.
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { MaestroCliId } from './wire.js'

/** readVolatile: accept both a live projected value and a plain value. */
export function readVolatile<T>(value: Volatile<T> | T | undefined): T | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'object' && value !== null && 'get' in value && typeof (value as { get: unknown }).get === 'function') {
    return (value as Volatile<T>).get() as T
  }
  return value as T
}

/** Claude permission modes accepted by `claude -p --permission-mode`. */
export const CLAUDE_PERMISSION_MODES = ['inherit', 'default', 'acceptEdits', 'plan', 'bypassPermissions'] as const
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number]

/** Codex sandbox modes (the permission axis of a non-interactive codex run). */
export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number]

export const CLI_CHOICES = ['claude', 'codex'] as const

/** Defaults spelled once; `effectiveOf` layers the live config over them. */
export const CONFIG_DEFAULTS = {
  enabled: true,
  defaultCli: 'claude',
  claudeEnabled: true,
  claudeTaskTypes: ['重构', '测试', '文档', '分析', '代码审查'],
  claudeModel: '',
  claudePermissionMode: 'inherit',
  claudeBaseUrl: '',
  claudeAuthToken: '',
  claudeCliPath: '',
  claudeTimeoutMinutes: 20,
  codexEnabled: true,
  codexTaskTypes: ['脚本', '快速修复', '批处理', '原型'],
  codexModel: '',
  codexSandbox: 'workspace-write',
  codexBaseUrl: '',
  codexApiKey: '',
  codexCliPath: '',
  codexTimeoutMinutes: 20,
  codexConfigOverrides: [],
  npmRegistry: '',
  maxConcurrentTasks: 2,
} as const

/** The config shape the host entry receives. Absent keys = inherited default. */
export interface Config {
  enabled?: Volatile<boolean> | boolean
  defaultCli?: Volatile<string> | string
  claudeEnabled?: Volatile<boolean> | boolean
  claudeTaskTypes?: Volatile<string[]> | string[]
  claudeModel?: Volatile<string> | string
  claudePermissionMode?: Volatile<string> | string
  claudeBaseUrl?: Volatile<string> | string
  claudeAuthToken?: Volatile<string> | string
  claudeCliPath?: Volatile<string> | string
  claudeTimeoutMinutes?: Volatile<number> | number
  codexEnabled?: Volatile<boolean> | boolean
  codexTaskTypes?: Volatile<string[]> | string[]
  codexModel?: Volatile<string> | string
  codexSandbox?: Volatile<string> | string
  codexBaseUrl?: Volatile<string> | string
  codexApiKey?: Volatile<string> | string
  codexCliPath?: Volatile<string> | string
  codexTimeoutMinutes?: Volatile<number> | number
  codexConfigOverrides?: Volatile<string[]> | string[]
  npmRegistry?: Volatile<string> | string
  maxConcurrentTasks?: Volatile<number> | number
}

/**
 * Cordis resolves the composition entry's config through this schema before
 * `apply` runs. Every field is volatile so the settings service projects it.
 */
export const Config: z = z.object({
  enabled: z.boolean().default(CONFIG_DEFAULTS.enabled).volatile(),
  defaultCli: z.string().default(CONFIG_DEFAULTS.defaultCli).volatile(),
  claudeEnabled: z.boolean().default(CONFIG_DEFAULTS.claudeEnabled).volatile(),
  claudeTaskTypes: z.array(z.string()).default([...CONFIG_DEFAULTS.claudeTaskTypes]).volatile(),
  claudeModel: z.string().default(CONFIG_DEFAULTS.claudeModel).volatile(),
  claudePermissionMode: z.string().default(CONFIG_DEFAULTS.claudePermissionMode).volatile(),
  claudeBaseUrl: z.string().default(CONFIG_DEFAULTS.claudeBaseUrl).volatile(),
  claudeAuthToken: z.string().default(CONFIG_DEFAULTS.claudeAuthToken).volatile(),
  claudeCliPath: z.string().default(CONFIG_DEFAULTS.claudeCliPath).volatile(),
  claudeTimeoutMinutes: z.number().default(CONFIG_DEFAULTS.claudeTimeoutMinutes).volatile(),
  codexEnabled: z.boolean().default(CONFIG_DEFAULTS.codexEnabled).volatile(),
  codexTaskTypes: z.array(z.string()).default([...CONFIG_DEFAULTS.codexTaskTypes]).volatile(),
  codexModel: z.string().default(CONFIG_DEFAULTS.codexModel).volatile(),
  codexSandbox: z.string().default(CONFIG_DEFAULTS.codexSandbox).volatile(),
  codexBaseUrl: z.string().default(CONFIG_DEFAULTS.codexBaseUrl).volatile(),
  codexApiKey: z.string().default(CONFIG_DEFAULTS.codexApiKey).volatile(),
  codexCliPath: z.string().default(CONFIG_DEFAULTS.codexCliPath).volatile(),
  codexTimeoutMinutes: z.number().default(CONFIG_DEFAULTS.codexTimeoutMinutes).volatile(),
  codexConfigOverrides: z.array(z.string()).default([]).volatile(),
  npmRegistry: z.string().default(CONFIG_DEFAULTS.npmRegistry).volatile(),
  maxConcurrentTasks: z.number().default(CONFIG_DEFAULTS.maxConcurrentTasks).volatile(),
})

const CONFIG_KEYS = Object.keys(CONFIG_DEFAULTS) as readonly (keyof typeof CONFIG_DEFAULTS)[]

/** Reject stale or misspelled config keys before defaults can hide them. */
export function validateConfig(config: Config): void {
  const known = new Set<string>(CONFIG_KEYS)
  const unknown = Object.keys(config).find(key => !known.has(key))
  if (unknown !== undefined) {
    throw new Error(`MaestroConfig: unknown key "${unknown}"`)
  }
  const defaultCli = readVolatile(config.defaultCli)
  if (defaultCli !== undefined && !(CLI_CHOICES as readonly string[]).includes(defaultCli)) {
    throw new Error(`MaestroConfig: "defaultCli" must be one of ${CLI_CHOICES.join(' | ')}`)
  }
  const permissionMode = readVolatile(config.claudePermissionMode)
  if (permissionMode !== undefined && !(CLAUDE_PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    throw new Error(`MaestroConfig: "claudePermissionMode" must be one of ${CLAUDE_PERMISSION_MODES.join(' | ')}`)
  }
  const sandbox = readVolatile(config.codexSandbox)
  if (sandbox !== undefined && !(CODEX_SANDBOX_MODES as readonly string[]).includes(sandbox)) {
    throw new Error(`MaestroConfig: "codexSandbox" must be one of ${CODEX_SANDBOX_MODES.join(' | ')}`)
  }
  validateTimeout('claudeTimeoutMinutes', readVolatile(config.claudeTimeoutMinutes))
  validateTimeout('codexTimeoutMinutes', readVolatile(config.codexTimeoutMinutes))
  const concurrency = readVolatile(config.maxConcurrentTasks)
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)) {
    throw new Error('MaestroConfig: "maxConcurrentTasks" must be an integer between 1 and 8')
  }
  for (const field of ['claudeTaskTypes', 'codexTaskTypes', 'codexConfigOverrides'] as const) {
    const list = readVolatile(config[field])
    if (list !== undefined && (!Array.isArray(list) || !list.every(item => typeof item === 'string'))) {
      throw new Error(`MaestroConfig: "${field}" must be an array of strings`)
    }
  }
  const registry = readVolatile(config.npmRegistry)
  if (registry !== undefined && registry !== '' && !/^https?:\/\/\S+$/.test(registry)) {
    throw new Error('MaestroConfig: "npmRegistry" must be an http(s) URL when set')
  }
}

function validateTimeout(field: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 240)) {
    throw new Error(`MaestroConfig: "${field}" must be an integer between 1 and 240`)
  }
}

/** A model override must be a single safe CLI token (no whitespace, no shell metacharacters). */
export function modelTokenError(model: string): string | undefined {
  if (model === '') return undefined
  if (!/^[\w.:/@+-]+$/.test(model)) return '模型名只能包含字母、数字和 . : / @ + - _'
  return undefined
}

/** Fully-resolved view of the config: every absent key spelled by its default. */
export interface EffectiveConfig {
  enabled: boolean
  defaultCli: MaestroCliId
  claude: {
    enabled: boolean
    taskTypes: string[]
    model: string
    permissionMode: ClaudePermissionMode
    baseUrl: string
    authToken: string
    cliPath: string
    timeoutMinutes: number
  }
  codex: {
    enabled: boolean
    taskTypes: string[]
    model: string
    sandbox: CodexSandboxMode
    baseUrl: string
    apiKey: string
    cliPath: string
    timeoutMinutes: number
    /** Raw `-c key=value` overrides passed to every codex invocation. */
    configOverrides: string[]
  }
  npmRegistry: string
  maxConcurrentTasks: number
}

/** Layer the (possibly volatile) config over the shipped defaults. */
export function effectiveOf(config: Config): EffectiveConfig {
  const defaultCli = readVolatile(config.defaultCli) ?? CONFIG_DEFAULTS.defaultCli
  const permissionMode = readVolatile(config.claudePermissionMode) ?? CONFIG_DEFAULTS.claudePermissionMode
  const sandbox = readVolatile(config.codexSandbox) ?? CONFIG_DEFAULTS.codexSandbox
  return {
    enabled: readVolatile(config.enabled) ?? CONFIG_DEFAULTS.enabled,
    defaultCli: (CLI_CHOICES as readonly string[]).includes(defaultCli) ? defaultCli as MaestroCliId : CONFIG_DEFAULTS.defaultCli,
    claude: {
      enabled: readVolatile(config.claudeEnabled) ?? CONFIG_DEFAULTS.claudeEnabled,
      taskTypes: readVolatile(config.claudeTaskTypes) ?? [...CONFIG_DEFAULTS.claudeTaskTypes],
      model: readVolatile(config.claudeModel) ?? '',
      permissionMode: (CLAUDE_PERMISSION_MODES as readonly string[]).includes(permissionMode)
        ? permissionMode as ClaudePermissionMode
        : CONFIG_DEFAULTS.claudePermissionMode,
      baseUrl: readVolatile(config.claudeBaseUrl) ?? '',
      authToken: readVolatile(config.claudeAuthToken) ?? '',
      cliPath: readVolatile(config.claudeCliPath) ?? '',
      timeoutMinutes: readVolatile(config.claudeTimeoutMinutes) ?? CONFIG_DEFAULTS.claudeTimeoutMinutes,
    },
    codex: {
      enabled: readVolatile(config.codexEnabled) ?? CONFIG_DEFAULTS.codexEnabled,
      taskTypes: readVolatile(config.codexTaskTypes) ?? [...CONFIG_DEFAULTS.codexTaskTypes],
      model: readVolatile(config.codexModel) ?? '',
      sandbox: (CODEX_SANDBOX_MODES as readonly string[]).includes(sandbox)
        ? sandbox as CodexSandboxMode
        : CONFIG_DEFAULTS.codexSandbox,
      baseUrl: readVolatile(config.codexBaseUrl) ?? '',
      apiKey: readVolatile(config.codexApiKey) ?? '',
      cliPath: readVolatile(config.codexCliPath) ?? '',
      timeoutMinutes: readVolatile(config.codexTimeoutMinutes) ?? CONFIG_DEFAULTS.codexTimeoutMinutes,
      configOverrides: readVolatile(config.codexConfigOverrides) ?? [],
    },
    npmRegistry: readVolatile(config.npmRegistry) ?? '',
    maxConcurrentTasks: readVolatile(config.maxConcurrentTasks) ?? CONFIG_DEFAULTS.maxConcurrentTasks,
  }
}

/** The fields safe to echo to the browser: no auth tokens, no API keys. */
export function redactEffective(effective: EffectiveConfig): EffectiveConfig {
  return {
    ...effective,
    claude: { ...effective.claude, authToken: effective.claude.authToken === '' ? '' : '••••' },
    codex: { ...effective.codex, apiKey: effective.codex.apiKey === '' ? '' : '••••' },
  }
}
