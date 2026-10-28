import { describe, expect, it } from 'vitest'
import { launchPlan, windowsQuote } from '../src/spawn.js'
import { findNpmCliJs, npmArgv } from '../src/cli-manager.js'

describe('windowsQuote', () => {
  it('leaves plain tokens bare', () => {
    expect(windowsQuote('claude')).toBe('claude')
    expect(windowsQuote('--model')).toBe('--model')
    expect(windowsQuote('claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
  })

  it('quotes and doubles embedded quotes', () => {
    expect(windowsQuote('a b')).toBe('"a b"')
    expect(windowsQuote('say "hi"')).toBe('"say ""hi"""')
  })
})

describe('launchPlan', () => {
  it('spawns real executables directly', () => {
    const plan = launchPlan('C:\\tools\\codex.exe', ['--version'])
    expect(plan).toEqual({ file: 'C:\\tools\\codex.exe', args: ['--version'] })
  })

  it('routes .cmd shims through cmd.exe with a verbatim quoted line (win32 semantics)', () => {
    if (process.platform !== 'win32') return
    const plan = launchPlan('C:\\npm\\claude.cmd', ['-p', '--output-format', 'stream-json'])
    expect(plan.file).toMatch(/cmd\.exe$/)
    expect(plan.args[0]).toBe('/d')
    expect(plan.args[1]).toBe('/s')
    expect(plan.args[2]).toBe('/c')
    // The verbatim line: outer quote pair, quoted file, bare args (plain tokens stay bare).
    expect(plan.args[3]).toBe('""C:\\npm\\claude.cmd" -p --output-format stream-json"')
    expect(plan.windowsVerbatimArguments).toBe(true)
  })
})

describe('npm argv building', () => {
  it('uses node npm-cli.js when present', () => {
    const argv = npmArgv('install', '@openai/codex', '', 'C:\\node\\npm-cli.js')
    expect(argv).toEqual({ file: process.execPath, args: ['C:\\node\\npm-cli.js', 'install', '-g', '@openai/codex'] })
  })

  it('appends the registry when set', () => {
    const argv = npmArgv('install', '@openai/codex', 'https://registry.npmmirror.com', undefined)
    expect(argv.args).toContain('--registry')
    expect(argv.args).toContain('https://registry.npmmirror.com')
  })

  it('uninstall spells the package', () => {
    const argv = npmArgv('uninstall', '@anthropic-ai/claude-code', '', undefined)
    expect(argv.args).toEqual(['uninstall', '-g', '@anthropic-ai/claude-code'])
  })
})

describe('findNpmCliJs', () => {
  it('finds npm-cli.js next to this Node (or nothing)', () => {
    const result = findNpmCliJs()
    // Either way it must not throw; on a plain node dist it exists.
    if (result !== undefined) expect(result).toMatch(/npm-cli\.js$/)
  })
})
