import { afterEach, describe, expect, it, vi } from 'vitest'
import { childEnvironment } from '../src/child-environment.js'
import { runProcess } from '../src/spawn.js'

const parent = {
  PATH: '/runtime/bin', HOME: '/home/operator', CODEX_HOME: '/home/operator/.codex',
  HTTP_PROXY: 'http://proxy.invalid', NODE_USE_ENV_PROXY: '1', LANG: 'zh_CN.UTF-8',
  GITHUB_TOKEN: 'synthetic-github', AWS_SECRET_ACCESS_KEY: 'synthetic-aws',
  custom_password: 'synthetic-password', DSH_PROFILE: 'desktop', dSh_install_dir: '/host',
  ORDINARY: 'keep',
}

afterEach(() => { vi.unstubAllEnvs() })

describe('explicit child environment policy', () => {
  it('scrubs sensitive ambient names and host identity but retains runtime and proxy facts', () => {
    expect(childEnvironment(parent, undefined, 'scrub', 'linux')).toEqual({
      PATH: parent.PATH, HOME: parent.HOME, CODEX_HOME: parent.CODEX_HOME,
      HTTP_PROXY: parent.HTTP_PROXY, NODE_USE_ENV_PROXY: '1', LANG: parent.LANG, ORDINARY: 'keep',
    })
  })

  it('retains generic management inheritance unless a caller explicitly opts into scrub', () => {
    expect(childEnvironment(parent, undefined, 'inherit', 'linux')).toEqual(parent)
  })

  it('restores only explicit task credentials and supports deletion without mutating either input', () => {
    const overlay = { ANTHROPIC_AUTH_TOKEN: 'synthetic-current', MAESTRO_MCP_SECRET_0_0: 'synthetic-bridge', ORDINARY: undefined }
    const actual = childEnvironment(parent, overlay, 'scrub', 'linux')
    expect(actual).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'synthetic-current', MAESTRO_MCP_SECRET_0_0: 'synthetic-bridge' })
    expect(actual).not.toHaveProperty('GITHUB_TOKEN')
    expect(actual).not.toHaveProperty('ORDINARY')
    expect(parent.ORDINARY).toBe('keep')
    expect(overlay.ORDINARY).toBeUndefined()
  })

  it('honours deliberate host-fact forwarding after scrub rather than silently broadening all DSH names', () => {
    const actual = childEnvironment(parent, { DSH_PROFILE: 'explicit' }, 'scrub', 'linux')
    expect(actual.DSH_PROFILE).toBe('explicit')
    expect(actual).not.toHaveProperty('dSh_install_dir')
  })

  it('merges Windows keys case-insensitively, including explicit removals', () => {
    expect(childEnvironment({ Path: 'old', path: 'older', OpenAI_Api_Key: 'stale', ordinary: 'old' },
      { PATH: 'new', OPENAI_API_KEY: 'current', ORDINARY: undefined }, 'scrub', 'win32'))
      .toEqual({ PATH: 'new', OPENAI_API_KEY: 'current' })
  })

  it('treats prototype-shaped variable names as data, not object mutation', () => {
    const explicit = Object.fromEntries([['__proto__', 'synthetic-value'], ['constructor', 'synthetic-constructor']])
    const actual = childEnvironment({}, explicit, 'scrub', 'linux')
    expect(Object.getPrototypeOf(actual)).toBeNull()
    expect(Object.entries(actual)).toEqual(Object.entries(explicit))
  })

  it('does not collapse case-sensitive POSIX environment names', () => {
    expect(childEnvironment({ PATH: 'upper', path: 'lower' }, { PATH: undefined }, 'inherit', 'linux'))
      .toEqual({ path: 'lower' })
  })
})

describe('real delegated process environment', () => {
  it.each(['inherit', 'scrub'] as const)('enforces %s at the real spawn boundary without changing idle semantics', async policy => {
    vi.stubEnv('MAESTRO_TEST_HOST_TOKEN', 'synthetic-unrelated')
    vi.stubEnv('DSH_TEST_HOST_FACT', 'synthetic-host')
    const lines: string[] = []
    const program = `process.stdout.write(JSON.stringify({ambient:process.env.MAESTRO_TEST_HOST_TOKEN??null,host:process.env.DSH_TEST_HOST_FACT??null,current:process.env.MAESTRO_TEST_CURRENT_TOKEN,proxy:process.env.HTTP_PROXY??null})+'\\n')`
    const { outcome } = runProcess({
      file: process.execPath, args: ['-e', program], environmentPolicy: policy,
      env: { MAESTRO_TEST_CURRENT_TOKEN: 'synthetic-explicit', HTTP_PROXY: 'http://synthetic-proxy.invalid' },
      timeoutMs: 10_000, timeoutMode: 'idle', signal: new AbortController().signal,
      onStdoutLine: line => lines.push(line),
    })
    expect(await outcome).toMatchObject({ code: 0, timedOut: false, stderrTail: '' })
    expect(JSON.parse(lines[0]!)).toEqual({
      ambient: policy === 'inherit' ? 'synthetic-unrelated' : null,
      host: policy === 'inherit' ? 'synthetic-host' : null,
      current: 'synthetic-explicit', proxy: 'http://synthetic-proxy.invalid',
    })
  }, 20_000)
})
