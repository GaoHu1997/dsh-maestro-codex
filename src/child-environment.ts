/** Child environment policy, independent of timeout and subprocess transport. */
export type ChildEnvironmentPolicy = 'inherit' | 'scrub'
export type ChildEnvironment = Readonly<Record<string, string | undefined>>

/** Same name-based safety baseline as DSH; explicit task entries merge afterwards. */
export const SENSITIVE_CHILD_ENV = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * Build a fresh environment. Generic management commands retain inheritance;
 * delegated CLIs opt into scrub. Undefined explicit values are deletion markers.
 * Windows merges are case-insensitive so an old spelling cannot win accidentally.
 * This is an environment boundary, not a filesystem sandbox or credential vault.
 */
export function childEnvironment(
  inherited: ChildEnvironment,
  explicit: ChildEnvironment | undefined,
  policy: ChildEnvironmentPolicy,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = Object.create(null)
  const names = new Map<string, string>()
  const normalized = (name: string): string => platform === 'win32' ? name.toUpperCase() : name
  const set = (name: string, value: string | undefined): void => {
    const identity = normalized(name)
    const previous = names.get(identity)
    if (previous !== undefined) delete env[previous]
    names.delete(identity)
    if (value !== undefined) {
      env[name] = value
      names.set(identity, name)
    }
  }
  for (const [name, value] of Object.entries(inherited)) {
    if (policy === 'scrub' && (SENSITIVE_CHILD_ENV.test(name) || name.toUpperCase().startsWith('DSH_'))) continue
    set(name, value)
  }
  for (const [name, value] of Object.entries(explicit ?? {})) set(name, value)
  return env
}
