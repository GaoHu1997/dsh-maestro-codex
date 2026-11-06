/** Secret-free argv descriptor; values arrive through Codex env_vars aliases only. */
import { spawn } from 'node:child_process'
import { launchPlan } from './spawn.js'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

interface Descriptor { command: string; args: string[]; keys: string[]; aliases: string[] }
export function mcpChildEnv(descriptor: Pick<Descriptor, 'keys' | 'aliases'>, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited }
  for (const name of Object.keys(env)) {
    if (/^MAESTRO_MCP_SECRET_/i.test(name) || /^(MAESTRO_DSH_PROVIDER_KEY|OPENAI_API_KEY|MAESTRO_BRIDGE_TOKEN)$/i.test(name)) delete env[name]
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const descriptor = JSON.parse(process.argv[2] ?? '') as Descriptor
  if (typeof descriptor.command !== 'string' || !Array.isArray(descriptor.args) || !Array.isArray(descriptor.keys) || !Array.isArray(descriptor.aliases) || descriptor.keys.length !== descriptor.aliases.length) throw new Error('Invalid MCP descriptor')
  const plan = launchPlan(descriptor.command, descriptor.args)
  const child = spawn(plan.file, plan.args, { ...(plan.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: plan.windowsVerbatimArguments }), env: mcpChildEnv(descriptor, process.env), stdio: 'inherit', shell: false, windowsHide: true })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { child.kill(signal) })
  child.on('error', () => { process.stderr.write('MCP command failed to start\n'); process.exitCode = 1 })
  child.on('exit', (code) => { process.exitCode = code ?? 1 })
}
