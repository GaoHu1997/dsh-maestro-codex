/**
 * Plugin configuration: one flat, settings-projected surface. Every field is
 * `.volatile()`, so the dsh settings service projects them into live
 * configuration forms, and the plugin provides its own dedicated card (the
 * `auto: false` presentation policy) with CLI management and the task monitor
 * on top.
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshModelSelectionError } from './dsh-models.js'
import { normalizeTaskTypes, type MaestroCliId } from './wire.js'

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

/** How host tools ride the bridge: never, filtered, or an explicit allowlist. */
export const BRIDGE_TOOLS_MODES = ['off', 'auto', 'custom'] as const
export type BridgeToolsMode = (typeof BRIDGE_TOOLS_MODES)[number]

/** How claude children receive dsh skills: through the bridge, or natively staged. */
export const CLAUDE_SKILLS_MODES = ['bridge', 'native'] as const
export type ClaudeSkillsMode = (typeof CLAUDE_SKILLS_MODES)[number]

/** Codex sandbox modes (the permission axis of a non-interactive codex run). */
export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number]

export const CLI_CHOICES = ['claude', 'codex'] as const

/** Ordered from least to most difficult; keywords never determine this rank. */
export const TASK_DIFFICULTIES = ['low', 'medium', 'high', 'extreme'] as const
export type TaskDifficulty = (typeof TASK_DIFFICULTIES)[number]
export const TASK_DIFFICULTY_LABELS: Record<TaskDifficulty, string> = {
  low: '低',
  medium: '中',
  high: '高',
  extreme: '极高',
}

export function isTaskDifficulty(value: unknown): value is TaskDifficulty {
  return typeof value === 'string' && (TASK_DIFFICULTIES as readonly string[]).includes(value)
}

/** Defaults spelled once; `effectiveOf` layers the live config over them. */
export const CONFIG_DEFAULTS = {
  enabled: true,
  defaultCli: 'claude',
  minTaskDifficulty: 'medium',
  claudeMinTaskDifficulty: 'medium',
  codexMinTaskDifficulty: 'medium',
  claudeEnabled: true,
  claudeTaskTypes: ['仓库探索', '影响分析', '模块重构', '方案设计', '文档整理'],
  claudePermissionMode: 'inherit',
  claudeBaseUrl: '',
  claudeAuthToken: '',
  claudeCliPath: '',
  claudeTimeoutMinutes: 20,
  codexEnabled: true,
  codexTaskTypes: ['功能开发', '缺陷修复', '测试验证', '代码审查', '数据处理'],
  codexSandbox: 'workspace-write',
  codexBaseUrl: '',
  codexApiKey: '',
  codexCliPath: '',
  codexTimeoutMinutes: 20,
  codexConfigOverrides: [],
  codexDshModel: '',
  claudeDshModel: '',
  /** dsh 子代理是内置回退：类型与门槛都可配，其余选项不暴露（没有 CLI 进程）。 */
  dshMinTaskDifficulty: 'low',
  dshTaskTypes: ['代码定位', '资料检索', '方案核验'],
  claudeThinking: '',
  codexThinking: '',
  bridgeMcp: true,
  bridgeSkills: true,
  bridgeTools: 'auto',
  bridgeToolAllowlist: [],
  claudeSkillsMode: 'bridge',
  mcpDiagnostics: false,
  npmRegistry: '',
  maxConcurrentTasks: 2,
  persistTasks: true,
  injectGitContext: true,
  recordChildSessions: true,
  failureRetries: 0,
  prepareCommand: '',
} as const

/** The config shape the host entry receives. Absent keys = inherited default. */
export interface Config {
  enabled?: Volatile<boolean> | boolean
  defaultCli?: Volatile<string> | string
  /** Legacy shared threshold, inherited only when a CLI has no own setting. */
  minTaskDifficulty?: Volatile<string> | string
  claudeMinTaskDifficulty?: Volatile<TaskDifficulty> | TaskDifficulty
  codexMinTaskDifficulty?: Volatile<TaskDifficulty> | TaskDifficulty
  claudeEnabled?: Volatile<boolean> | boolean
  claudeTaskTypes?: Volatile<string[]> | string[]
  claudePermissionMode?: Volatile<string> | string
  claudeBaseUrl?: Volatile<string> | string
  claudeAuthToken?: Volatile<string> | string
  claudeCliPath?: Volatile<string> | string
  claudeTimeoutMinutes?: Volatile<number> | number
  codexEnabled?: Volatile<boolean> | boolean
  codexTaskTypes?: Volatile<string[]> | string[]
  codexSandbox?: Volatile<string> | string
  codexBaseUrl?: Volatile<string> | string
  codexApiKey?: Volatile<string> | string
  codexCliPath?: Volatile<string> | string
  codexTimeoutMinutes?: Volatile<number> | number
  codexConfigOverrides?: Volatile<string[]> | string[]
  codexDshModel?: Volatile<string> | string
  claudeDshModel?: Volatile<string> | string
  /** dsh 子代理（内置回退）的最低任务难度；固定独立于 legacy 共享项。 */
  dshMinTaskDifficulty?: Volatile<TaskDifficulty> | TaskDifficulty
  /** dsh 子代理擅长的任务类型：命中即建议改用 subagent，不派发 CLI。 */
  dshTaskTypes?: Volatile<string[]> | string[]
  /** Thinking level per CLI; '' = the CLI's own default. */
  claudeThinking?: Volatile<string> | string
  codexThinking?: Volatile<string> | string
  bridgeMcp?: Volatile<boolean> | boolean
  /** Hand dsh's skills to the dispatched CLI runs (catalog + on-demand load). */
  bridgeSkills?: Volatile<boolean> | boolean
  /** Host-tool bridging: off, auto (denylist filter), or custom (allowlist). */
  bridgeTools?: Volatile<string> | string
  /** Exact tool names for `bridgeTools: 'custom'`. */
  bridgeToolAllowlist?: Volatile<string[]> | string[]
  /** How claude children load dsh skills: bridge tools or a staged native dir. */
  claudeSkillsMode?: Volatile<string> | string
  mcpDiagnostics?: Volatile<boolean> | boolean
  npmRegistry?: Volatile<string> | string
  maxConcurrentTasks?: Volatile<number> | number
  /** Persist settled dispatch results under $DSH_HOME/maestro/tasks (default on). */
  persistTasks?: Volatile<boolean> | boolean
  /** Prepend a read-only git branch/status snapshot to the child's task text. */
  injectGitContext?: Volatile<boolean> | boolean
  /** Record each dispatch as a real dsh child session (usage + catalog row, default on). */
  recordChildSessions?: Volatile<boolean> | boolean
  /** Automatic re-runs after a plain failure (not timeout/cancel); 0–2, default 0. */
  failureRetries?: Volatile<number> | number
  /**
   * 就绪命令：spawn 前在 cwd 里跑一次（典型是 `git worktree add`）。失败即
   * 当轮失败；留空则不跑。
   */
  prepareCommand?: Volatile<string> | string
}

/**
 * Cordis resolves the composition entry's config through this schema before
 * `apply` runs. Every field is volatile so the settings service projects it.
 */
export const Config: z = z.object({
  enabled: z.boolean().default(CONFIG_DEFAULTS.enabled).volatile(),
  defaultCli: z.string().default(CONFIG_DEFAULTS.defaultCli).volatile(),
  minTaskDifficulty: z.union(TASK_DIFFICULTIES.map(value => z.const(value))).default(CONFIG_DEFAULTS.minTaskDifficulty).volatile(),
  // No default here: a projected medium would hide a legacy high/extreme.
  claudeMinTaskDifficulty: z.union(TASK_DIFFICULTIES.map(value => z.const(value))).volatile(),
  codexMinTaskDifficulty: z.union(TASK_DIFFICULTIES.map(value => z.const(value))).volatile(),
  claudeEnabled: z.boolean().default(CONFIG_DEFAULTS.claudeEnabled).volatile(),
  claudeTaskTypes: z.array(z.string()).default([...CONFIG_DEFAULTS.claudeTaskTypes]).volatile(),
  claudePermissionMode: z.string().default(CONFIG_DEFAULTS.claudePermissionMode).volatile(),
  claudeBaseUrl: z.string().default(CONFIG_DEFAULTS.claudeBaseUrl).volatile(),
  claudeAuthToken: z.string().default(CONFIG_DEFAULTS.claudeAuthToken).volatile(),
  claudeCliPath: z.string().default(CONFIG_DEFAULTS.claudeCliPath).volatile(),
  claudeTimeoutMinutes: z.number().default(CONFIG_DEFAULTS.claudeTimeoutMinutes).volatile(),
  codexEnabled: z.boolean().default(CONFIG_DEFAULTS.codexEnabled).volatile(),
  codexTaskTypes: z.array(z.string()).default([...CONFIG_DEFAULTS.codexTaskTypes]).volatile(),
  codexSandbox: z.string().default(CONFIG_DEFAULTS.codexSandbox).volatile(),
  codexBaseUrl: z.string().default(CONFIG_DEFAULTS.codexBaseUrl).volatile(),
  codexApiKey: z.string().default(CONFIG_DEFAULTS.codexApiKey).volatile(),
  codexCliPath: z.string().default(CONFIG_DEFAULTS.codexCliPath).volatile(),
  codexTimeoutMinutes: z.number().default(CONFIG_DEFAULTS.codexTimeoutMinutes).volatile(),
  codexConfigOverrides: z.array(z.string()).default([]).volatile(),
  codexDshModel: z.string().default(CONFIG_DEFAULTS.codexDshModel).volatile(),
  claudeDshModel: z.string().default(CONFIG_DEFAULTS.claudeDshModel).volatile(),
  // dsh 是内置回退，门槛不继承 legacy：旧配置只描述外部 CLI。
  dshMinTaskDifficulty: z.union(TASK_DIFFICULTIES.map(value => z.const(value))).default(CONFIG_DEFAULTS.dshMinTaskDifficulty).volatile(),
  dshTaskTypes: z.array(z.string()).default([...CONFIG_DEFAULTS.dshTaskTypes]).volatile(),
  claudeThinking: z.string().default(CONFIG_DEFAULTS.claudeThinking).volatile(),
  codexThinking: z.string().default(CONFIG_DEFAULTS.codexThinking).volatile(),
  bridgeMcp: z.boolean().default(CONFIG_DEFAULTS.bridgeMcp).volatile(),
  bridgeSkills: z.boolean().default(CONFIG_DEFAULTS.bridgeSkills).volatile(),
  bridgeTools: z.string().default(CONFIG_DEFAULTS.bridgeTools).volatile(),
  bridgeToolAllowlist: z.array(z.string()).default([]).volatile(),
  claudeSkillsMode: z.string().default(CONFIG_DEFAULTS.claudeSkillsMode).volatile(),
  mcpDiagnostics: z.boolean().default(CONFIG_DEFAULTS.mcpDiagnostics).volatile(),
  npmRegistry: z.string().default(CONFIG_DEFAULTS.npmRegistry).volatile(),
  maxConcurrentTasks: z.number().default(CONFIG_DEFAULTS.maxConcurrentTasks).volatile(),
  persistTasks: z.boolean().default(CONFIG_DEFAULTS.persistTasks).volatile(),
  injectGitContext: z.boolean().default(CONFIG_DEFAULTS.injectGitContext).volatile(),
  recordChildSessions: z.boolean().default(CONFIG_DEFAULTS.recordChildSessions).volatile(),
  failureRetries: z.number().default(CONFIG_DEFAULTS.failureRetries).volatile(),
  prepareCommand: z.string().default(CONFIG_DEFAULTS.prepareCommand).volatile(),
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
  for (const field of ['minTaskDifficulty', 'claudeMinTaskDifficulty', 'codexMinTaskDifficulty', 'dshMinTaskDifficulty'] as const) {
    const minimum = readVolatile(config[field])
    if (minimum !== undefined && !isTaskDifficulty(minimum)) {
      throw new Error(`MaestroConfig: "${field}" must be one of ${TASK_DIFFICULTIES.join(' | ')}`)
    }
  }
  const permissionMode = readVolatile(config.claudePermissionMode)
  if (permissionMode !== undefined && !(CLAUDE_PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    throw new Error(`MaestroConfig: "claudePermissionMode" must be one of ${CLAUDE_PERMISSION_MODES.join(' | ')}`)
  }
  const sandbox = readVolatile(config.codexSandbox)
  if (sandbox !== undefined && !(CODEX_SANDBOX_MODES as readonly string[]).includes(sandbox)) {
    throw new Error(`MaestroConfig: "codexSandbox" must be one of ${CODEX_SANDBOX_MODES.join(' | ')}`)
  }
  const bridgeTools = readVolatile(config.bridgeTools)
  if (bridgeTools !== undefined && !(BRIDGE_TOOLS_MODES as readonly string[]).includes(bridgeTools)) {
    throw new Error(`MaestroConfig: "bridgeTools" must be one of ${BRIDGE_TOOLS_MODES.join(' | ')}`)
  }
  const claudeSkillsMode = readVolatile(config.claudeSkillsMode)
  if (claudeSkillsMode !== undefined && !(CLAUDE_SKILLS_MODES as readonly string[]).includes(claudeSkillsMode)) {
    throw new Error(`MaestroConfig: "claudeSkillsMode" must be one of ${CLAUDE_SKILLS_MODES.join(' | ')}`)
  }
  validateTimeout('claudeTimeoutMinutes', readVolatile(config.claudeTimeoutMinutes))
  validateTimeout('codexTimeoutMinutes', readVolatile(config.codexTimeoutMinutes))
  const claudeDshModel = readVolatile(config.claudeDshModel)
  if (claudeDshModel !== undefined) {
    const error = dshModelSelectionError(claudeDshModel)
    if (error !== undefined) throw new Error(`MaestroConfig: "claudeDshModel" ${error}`)
  }
  const codexDshModel = readVolatile(config.codexDshModel)
  if (codexDshModel !== undefined) {
    const error = dshModelSelectionError(codexDshModel)
    if (error !== undefined) throw new Error(`MaestroConfig: "codexDshModel" ${error}`)
  }
  const claudeThinking = readVolatile(config.claudeThinking)
  if (claudeThinking !== undefined) {
    const error = modelTokenError(claudeThinking)
    if (error !== undefined) throw new Error(`MaestroConfig: "claudeThinking" ${error}`)
  }
  const codexThinking = readVolatile(config.codexThinking)
  if (codexThinking !== undefined) {
    const error = modelTokenError(codexThinking)
    if (error !== undefined) throw new Error(`MaestroConfig: "codexThinking" ${error}`)
  }
  const concurrency = readVolatile(config.maxConcurrentTasks)
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)) {
    throw new Error('MaestroConfig: "maxConcurrentTasks" must be an integer between 1 and 8')
  }
  const retries = readVolatile(config.failureRetries)
  if (retries !== undefined && (!Number.isInteger(retries) || retries < 0 || retries > 2)) {
    throw new Error('MaestroConfig: "failureRetries" must be an integer between 0 and 2')
  }
  const prepare = readVolatile(config.prepareCommand)
  if (prepare !== undefined && prepare.length > 4000) {
    throw new Error('MaestroConfig: "prepareCommand" must be at most 4000 characters')
  }
  for (const field of ['claudeTaskTypes', 'codexTaskTypes', 'dshTaskTypes', 'codexConfigOverrides'] as const) {
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
    minTaskDifficulty: TaskDifficulty
    taskTypes: string[]
    /** `<provider>::<model>` selection from the dsh catalog; '' = not used. */
    dshModel: string
    /** Thinking level key (from the model's reasoningEfforts); '' = CLI default. */
    thinking: string
    permissionMode: ClaudePermissionMode
    baseUrl: string
    authToken: string
    cliPath: string
    timeoutMinutes: number
  }
  codex: {
    enabled: boolean
    minTaskDifficulty: TaskDifficulty
    taskTypes: string[]
    dshModel: string
    /** Thinking level key (`model_reasoning_effort`); '' = CLI default. */
    thinking: string
    sandbox: CodexSandboxMode
    baseUrl: string
    apiKey: string
    cliPath: string
    timeoutMinutes: number
    /** Raw `-c key=value` overrides passed to every codex invocation. */
    configOverrides: string[]
  }
  /** 内置 dsh 子代理：没有 CLI 进程，只由类型与门槛决定「建议用它还是主代理直接做」。 */
  dsh: {
    minTaskDifficulty: TaskDifficulty
    taskTypes: string[]
  }
  npmRegistry: string
  maxConcurrentTasks: number
  /** Persist settled dispatch results under $DSH_HOME/maestro/tasks. */
  persistTasks: boolean
  /** Prepend a read-only git snapshot to the child's task text. */
  injectGitContext: boolean
  /** Record each dispatch as a real dsh child session (usage + catalog row). */
  recordChildSessions: boolean
  /** Automatic re-runs after a plain failure; 0 disables (default). */
  failureRetries: number
  /** 就绪命令：spawn 前在 cwd 里跑一次；空串 = 不跑。 */
  prepareCommand: string
  /** Hand dsh's own MCP servers to the dispatched CLI runs. */
  bridgeMcp: boolean
  /** Hand dsh's skills to the dispatched CLI runs (catalog + on-demand load). */
  bridgeSkills: boolean
  /** Host-tool bridging mode: `off`, `auto` (denylist filter) or `custom` (allowlist). */
  bridgeTools: BridgeToolsMode
  /** Exact tool names bridged when mode is `custom`. */
  bridgeToolAllowlist: string[]
  /** How claude children load dsh skills: bridge tools or a staged native dir. */
  claudeSkillsMode: ClaudeSkillsMode
  /** Temporary discovery diagnostics for the /models route. */
  mcpDiagnostics: boolean
}

/** The configured thinking level of one CLI ('' when absent). */
function thinkingOf(config: Config, field: 'claudeThinking' | 'codexThinking'): string {
  return readVolatile(config[field]) ?? ''
}

/** Layer the (possibly volatile) config over the shipped defaults. */
export function effectiveOf(config: Config): EffectiveConfig {
  const defaultCli = readVolatile(config.defaultCli) ?? CONFIG_DEFAULTS.defaultCli
  const legacyMinimum = readVolatile(config.minTaskDifficulty)
  const inheritedMinimum = isTaskDifficulty(legacyMinimum) ? legacyMinimum : CONFIG_DEFAULTS.minTaskDifficulty
  const claudeMinimum = readVolatile(config.claudeMinTaskDifficulty) ?? inheritedMinimum
  const codexMinimum = readVolatile(config.codexMinTaskDifficulty) ?? inheritedMinimum
  const permissionMode = readVolatile(config.claudePermissionMode) ?? CONFIG_DEFAULTS.claudePermissionMode
  const sandbox = readVolatile(config.codexSandbox) ?? CONFIG_DEFAULTS.codexSandbox
  return {
    enabled: readVolatile(config.enabled) ?? CONFIG_DEFAULTS.enabled,
    defaultCli: (CLI_CHOICES as readonly string[]).includes(defaultCli) ? defaultCli as MaestroCliId : CONFIG_DEFAULTS.defaultCli,
    claude: {
      enabled: readVolatile(config.claudeEnabled) ?? CONFIG_DEFAULTS.claudeEnabled,
      minTaskDifficulty: isTaskDifficulty(claudeMinimum) ? claudeMinimum : CONFIG_DEFAULTS.claudeMinTaskDifficulty,
      taskTypes: normalizeTaskTypes(readVolatile(config.claudeTaskTypes) ?? [...CONFIG_DEFAULTS.claudeTaskTypes]),
      dshModel: readVolatile(config.claudeDshModel) ?? '',
      thinking: thinkingOf(config, 'claudeThinking'),
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
      minTaskDifficulty: isTaskDifficulty(codexMinimum) ? codexMinimum : CONFIG_DEFAULTS.codexMinTaskDifficulty,
      taskTypes: normalizeTaskTypes(readVolatile(config.codexTaskTypes) ?? [...CONFIG_DEFAULTS.codexTaskTypes]),
      dshModel: readVolatile(config.codexDshModel) ?? '',
      thinking: thinkingOf(config, 'codexThinking'),
      sandbox: (CODEX_SANDBOX_MODES as readonly string[]).includes(sandbox)
        ? sandbox as CodexSandboxMode
        : CONFIG_DEFAULTS.codexSandbox,
      baseUrl: readVolatile(config.codexBaseUrl) ?? '',
      apiKey: readVolatile(config.codexApiKey) ?? '',
      cliPath: readVolatile(config.codexCliPath) ?? '',
      timeoutMinutes: readVolatile(config.codexTimeoutMinutes) ?? CONFIG_DEFAULTS.codexTimeoutMinutes,
      configOverrides: readVolatile(config.codexConfigOverrides) ?? [],
    },
    dsh: {
      minTaskDifficulty: (() => {
        const minimum = readVolatile(config.dshMinTaskDifficulty) ?? CONFIG_DEFAULTS.dshMinTaskDifficulty
        return isTaskDifficulty(minimum) ? minimum : CONFIG_DEFAULTS.dshMinTaskDifficulty
      })(),
      taskTypes: normalizeTaskTypes(readVolatile(config.dshTaskTypes) ?? [...CONFIG_DEFAULTS.dshTaskTypes]),
    },
    npmRegistry: readVolatile(config.npmRegistry) ?? '',
    maxConcurrentTasks: readVolatile(config.maxConcurrentTasks) ?? CONFIG_DEFAULTS.maxConcurrentTasks,
    persistTasks: readVolatile(config.persistTasks) ?? CONFIG_DEFAULTS.persistTasks,
    injectGitContext: readVolatile(config.injectGitContext) ?? CONFIG_DEFAULTS.injectGitContext,
    recordChildSessions: readVolatile(config.recordChildSessions) ?? CONFIG_DEFAULTS.recordChildSessions,
    failureRetries: readVolatile(config.failureRetries) ?? CONFIG_DEFAULTS.failureRetries,
    prepareCommand: readVolatile(config.prepareCommand) ?? CONFIG_DEFAULTS.prepareCommand,
    bridgeMcp: readVolatile(config.bridgeMcp) ?? CONFIG_DEFAULTS.bridgeMcp,
    bridgeSkills: readVolatile(config.bridgeSkills) ?? CONFIG_DEFAULTS.bridgeSkills,
    bridgeTools: (BRIDGE_TOOLS_MODES as readonly string[]).includes(readVolatile(config.bridgeTools) ?? '')
      ? readVolatile(config.bridgeTools) as BridgeToolsMode
      : CONFIG_DEFAULTS.bridgeTools,
    bridgeToolAllowlist: readVolatile(config.bridgeToolAllowlist) ?? [],
    claudeSkillsMode: (CLAUDE_SKILLS_MODES as readonly string[]).includes(readVolatile(config.claudeSkillsMode) ?? '')
      ? readVolatile(config.claudeSkillsMode) as ClaudeSkillsMode
      : CONFIG_DEFAULTS.claudeSkillsMode,
    mcpDiagnostics: readVolatile(config.mcpDiagnostics) ?? CONFIG_DEFAULTS.mcpDiagnostics,
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
