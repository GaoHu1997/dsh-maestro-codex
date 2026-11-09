import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { codexMcpArgs } from '../src/channels/codex.js'
import { launchPlan, runProcess } from '../src/spawn.js'

type Cli = 'codex' | 'grok'
type Layout = 'global' | 'local'
const entries: Record<Cli, readonly string[]> = {
  codex: ['@openai', 'codex', 'bin', 'codex.js'],
  grok: ['@xai-official', 'grok', 'bin', 'grok'],
}
const cases = (['codex', 'grok'] as const).flatMap(cli => (['global', 'local'] as const).map(layout => ({ cli, layout })))

// Independent copy of the standard npm cmd-shim bootstrap. Only the package
// entry changes between a global prefix and node_modules/.bin.
function npmShim(relativeEntry: string): string {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeEntry}" %*`,
  ].join('\r\n')
}

const ECHO_ENTRY = 'const args = process.argv.slice(2); process.stdout.write(JSON.stringify({ args, utf8: args.map(arg => Buffer.from(arg, "utf8").toString("hex")) }) + "\\n")'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture(options: {
  cli?: Cli
  layout?: Layout
  fileName?: string
  separator?: '\\' | '/'
  transformShim?: (shim: string) => string
} = {}): { dir: string; file: string; entry: string; alternateEntry: string } {
  const cli = options.cli ?? 'codex'
  const layout = options.layout ?? 'global'
  const root = mkdtempSync(path.join(tmpdir(), 'maestro npm 中文 '))
  dirs.push(root)
  const dir = layout === 'global' ? path.join(root, 'npm global 中文') : path.join(root, 'node_modules', '.bin')
  const relative = layout === 'global' ? ['node_modules', ...entries[cli]] : ['..', ...entries[cli]]
  const alternate = layout === 'global' ? ['..', ...entries[cli]] : ['node_modules', ...entries[cli]]
  const file = path.join(dir, options.fileName ?? `${cli}.cmd`)
  const entry = path.resolve(dir, ...relative)
  const alternateEntry = path.resolve(dir, ...alternate)
  const shim = npmShim(relative.join(options.separator ?? '\\'))
  mkdirSync(dir, { recursive: true })
  mkdirSync(path.dirname(entry), { recursive: true })
  writeFileSync(file, options.transformShim?.(shim) ?? shim)
  writeFileSync(entry, ECHO_ENTRY)
  return { dir, file, entry, alternateEntry }
}

function expectCmdLauncher(file: string): void {
  const plan = launchPlan(file, ['--version'])
  expect(plan.file).toMatch(/cmd\.exe$/i)
  expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
  expect(plan.args[3]).toContain(`"${file}"`)
  expect(plan.windowsVerbatimArguments).toBe(true)
}

describe.skipIf(process.platform !== 'win32')('Windows npm Codex and Grok launch', () => {
  it.each(cases)('uses the declared $layout $cli entry and sibling Node when available', ({ cli, layout }) => {
    const { dir, file, entry } = fixture({ cli, layout })
    const node = path.join(dir, 'node.exe')
    writeFileSync(node, '')
    expect(launchPlan(file, ['--version'])).toEqual({ file: node, args: [entry, '--version'] })
  })

  it.each(cases)('uses Node on PATH for $layout $cli, never the desktop Electron executable', ({ cli, layout }) => {
    const { file, entry } = fixture({ cli, layout })
    expect(launchPlan(file, ['--version'])).toEqual({ file: 'node.exe', args: [entry, '--version'] })
  })

  it.each(cases)('does not confuse existing local/global entries for $layout $cli', ({ cli, layout }) => {
    const { file, entry, alternateEntry } = fixture({ cli, layout })
    mkdirSync(path.dirname(alternateEntry), { recursive: true })
    writeFileSync(alternateEntry, 'throw new Error("wrong entry")')
    expect(launchPlan(file, ['--version'])).toEqual({ file: 'node.exe', args: [entry, '--version'] })
  })

  it.each(cases)('does not redirect a broken $layout $cli shim to a different installation', ({ cli, layout }) => {
    const { file, entry, alternateEntry } = fixture({ cli, layout })
    unlinkSync(entry)
    expect(entry).not.toBe(alternateEntry)
    expect(existsSync(entry)).toBe(false)
    expect(() => statSync(entry)).toThrow()
    mkdirSync(path.dirname(alternateEntry), { recursive: true })
    writeFileSync(alternateEntry, ECHO_ENTRY)
    expect(existsSync(entry)).toBe(false)
    expect(statSync(alternateEntry).isFile()).toBe(true)
    expectCmdLauncher(file)
  })

  it.each(cases)('recognizes npm case, blank-line and slash variants for $layout $cli', ({ cli, layout }) => {
    const { file, entry } = fixture({ cli, layout, separator: '/', transformShim: shim => `\uFEFF\r\n${shim.toLowerCase()}\r\n` })
    expect(launchPlan(file, ['--version'])).toEqual({ file: 'node.exe', args: [entry, '--version'] })
  })

  const customizations: { name: string; transform: (shim: string) => string }[] = [
    { name: 'plain custom launcher', transform: () => '@echo off\r\necho custom launcher %*' },
    { name: 'pre-launch hook', transform: shim => shim.replace('SETLOCAL', 'SETLOCAL\r\necho custom setup >NUL') },
    { name: 'post-launch hook', transform: shim => `${shim}\r\necho custom teardown >NUL` },
    { name: 'custom Node fallback', transform: shim => shim.replace('SET "_prog=node"', 'SET "_prog=custom-node"') },
    { name: 'significant trailing SET whitespace', transform: shim => shim.replace('SET dp0=%~dp0', 'SET dp0=%~dp0 ') },
    { name: 'additional launcher arguments', transform: shim => shim.replace(' %*', ' --custom %*') },
  ]
  it.each(cases.flatMap(testCase => customizations.map(custom => ({ ...testCase, ...custom }))))(
    'keeps $layout $cli $name on the original cmd path', ({ cli, layout, transform }) => {
      expectCmdLauncher(fixture({ cli, layout, transformShim: transform }).file)
    },
  )

  it.each(cases)('does not reinterpret a $layout $cli .bat or differently named launcher', ({ cli, layout }) => {
    expectCmdLauncher(fixture({ cli, layout, fileName: `${cli}.bat` }).file)
    expectCmdLauncher(fixture({ cli, layout, fileName: `custom-${cli}.cmd` }).file)
  })

  it.each(cases.flatMap(testCase => (['path', 'sibling'] as const).map(node => ({ ...testCase, node }))))(
    'preserves argv and UTF-8 bytes in a real $layout $cli child using $node Node', async ({ cli, layout, node }) => {
      const { dir, file } = fixture({ cli, layout })
      if (node === 'sibling') copyFileSync(process.execPath, path.join(dir, 'node.exe'))
      const mcp = {
        name: 'obsidian_mcp', command: 'npx',
        args: ['-y', '@huangyihe/obsidian-mcp', 'D:\\vault 中文\\with spaces\\', '%MAESTRO_QUOTE_PROBE%', '', '!literal! & ^ | < > ( )'],
        env: { OBSIDIAN_VAULT_PATH: 'unused', OBSIDIAN_API_TOKEN: 'unused', OBSIDIAN_API_PORT: '27123' },
      }
      const args = [
        'exec', '--json', ...codexMcpArgs([mcp]),
        '--nested-json', JSON.stringify({ mcp, nested: { value: JSON.stringify({ quote: 'say "中文"', path: 'D:\\中文 文件夹\\', empty: '' }) } }),
        '-c', 'model_providers.test.base_url="https://example.test/v1?a=1&b=2"',
        'D:\\中文 文件夹\\with spaces\\', '%MAESTRO_QUOTE_PROBE%', 'prefix%MAESTRO_QUOTE_PROBE%suffix',
        '!literal! & ^ | < > ( )', 'embedded "quotes" and trailing\\', '-', '',
      ]
      const lines: string[] = []
      const { outcome } = runProcess({
        file, args, env: { PATH: path.dirname(process.execPath), MAESTRO_QUOTE_PROBE: 'must-not-expand' },
        timeoutMs: 10_000, signal: new AbortController().signal,
        onStdoutLine: line => { lines.push(line) },
      })
      const result = await outcome
      expect(result.stderrTail).toBe('')
      expect(result.code).toBe(0)
      expect(result.timedOut).toBe(false)
      expect(lines).toHaveLength(1)
      const echoed = JSON.parse(lines[0] ?? '') as { args: string[]; utf8: string[] }
      expect(echoed.args).toEqual(args)
      expect(echoed.utf8).toEqual(args.map(arg => Buffer.from(arg, 'utf8').toString('hex')))
    }, 15_000,
  )
})
