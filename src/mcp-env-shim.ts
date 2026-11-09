/** Secret-free argv descriptor; values arrive through run-scoped env aliases only. */
import { spawn } from 'node:child_process'
import { launchPlan } from './spawn.js'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// MCP programs need their own declared credentials, not the enclosing model
// provider's keys or another server's bridge capability. Explicit env entries
// are restored below, so a server may intentionally request any of these names.
const MODEL_CREDENTIAL_ENV = /^(MAESTRO_DSH_PROVIDER_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|GEMINI_API_KEY|GOOGLE_API_KEY|DEEPSEEK_API_KEY|AZURE_OPENAI_API_KEY|OPENROUTER_API_KEY|MAESTRO_BRIDGE_TOKEN)$/i
const MODEL_ENDPOINT_ENV = /^(OPENAI_BASE_URL|ANTHROPIC_BASE_URL|GROK_XAI_API_BASE_URL|AZURE_OPENAI_ENDPOINT)$/i

interface Descriptor { command: string; args: string[]; keys: string[]; aliases: string[] }
export function mcpChildEnv(descriptor: Pick<Descriptor, 'keys' | 'aliases'>, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited }
  for (const name of Object.keys(env)) {
    if (/^MAESTRO_MCP_SECRET_/i.test(name) || MODEL_CREDENTIAL_ENV.test(name) || MODEL_ENDPOINT_ENV.test(name)) delete env[name]
  }
  descriptor.keys.forEach((key, index) => {
    const alias = descriptor.aliases[index]
    if (alias === undefined || inherited[alias] === undefined) throw new Error('MCP environment alias unavailable')
    // Windows environment keys are case insensitive; remove a prior spelling.
    if (process.platform === 'win32') for (const name of Object.keys(env)) if (name.toLowerCase() === key.toLowerCase()) delete env[name]
    env[key] = inherited[alias]
  })
  return env
}

/** How long a terminating MCP child gets before the shim escalates to SIGKILL. */
export const SHIM_KILL_GRACE_MS = 5_000

/** The child-process surface the supervisor needs (injectable for tests). */
export interface McpChildLike {
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export interface SuperviseOptions {
  readonly graceMs?: number
  readonly signals?: { on(signal: NodeJS.Signals, listener: () => void): unknown }
  readonly exit?: (code: number) => void
}

/**
 * Forward termination to the MCP child, escalate to SIGKILL if it ignores
 * SIGTERM, and exit with the child's code as soon as it exits. An MCP server
 * that traps SIGTERM would otherwise keep the inherited stdio open and leave
 * the shim (and therefore the CLI's pipe) alive after the run was cancelled.
 */
export function superviseMcpChild(child: McpChildLike, options: SuperviseOptions = {}): void {
  const graceMs = options.graceMs ?? SHIM_KILL_GRACE_MS
  const signals = options.signals ?? process
  const exit = options.exit ?? ((code: number) => process.exit(code))
  let stopping = false
  let timer: ReturnType<typeof setTimeout> | undefined
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    signals.on(signal, () => {
      if (stopping) return
      stopping = true
      try { child.kill(signal) } catch { /* already gone */ }
      timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, graceMs)
      timer.unref?.()
    })
  }
  child.on('error', () => {
    process.stderr.write('MCP command failed to start\n')
    exit(1)
  })
  child.on('exit', (code) => {
    if (timer !== undefined) clearTimeout(timer)
    exit(code ?? 1)
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const descriptor = JSON.parse(process.argv[2] ?? '') as Descriptor
  if (typeof descriptor.command !== 'string' || !Array.isArray(descriptor.args) || !Array.isArray(descriptor.keys) || !Array.isArray(descriptor.aliases) || descriptor.keys.length !== descriptor.aliases.length) throw new Error('Invalid MCP descriptor')
  const plan = launchPlan(descriptor.command, descriptor.args)
  const child = spawn(plan.file, plan.args, { ...(plan.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: plan.windowsVerbatimArguments }), env: mcpChildEnv(descriptor, process.env), stdio: 'inherit', shell: false, windowsHide: true })
  superviseMcpChild(child)
}
