import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { codexMcpArgs } from '../src/channels/codex.js'
import { launchPlan, runProcess } from '../src/spawn.js'

// Same argument-forwarding line emitted by npm for @openai/codex.
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n')

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture(shim = NPM_SHIM): { dir: string; file: string; entry: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'maestro Codex 中文 '))
  dirs.push(dir)
  const file = path.join(dir, 'codex.cmd')
  const entry = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  mkdirSync(path.dirname(entry), { recursive: true })
  writeFileSync(file, shim)
  writeFileSync(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n")')
  return { dir, file, entry }
}

describe.skipIf(process.platform !== 'win32')('Windows npm Codex launch', () => {
  it('uses the npm JS entry and the sibling Node executable when available', () => {
    const { dir, file, entry } = fixture()
    const node = path.join(dir, 'node.exe')
    writeFileSync(node, '')
    expect(launchPlan(file, ['--version'])).toEqual({ file: node, args: [entry, '--version'] })
  })

  it('falls back to Node on PATH rather than the desktop Electron executable', () => {
    const { file, entry } = fixture()
    expect(launchPlan(file, ['--version'])).toEqual({ file: 'node.exe', args: [entry, '--version'] })
  })

  it('keeps custom Codex batch launchers on the original cmd path', () => {
    const { file } = fixture('@echo off\r\necho custom launcher %*')
    expect(launchPlan(file, ['--version']).file).toMatch(/cmd\.exe$/i)
  })

  it('preserves nested MCP TOML/JSON and shell metacharacters in a real child process', async () => {
    const { file } = fixture()
    const args = [
      'exec', '--json',
      ...codexMcpArgs([{
        name: 'obsidian_mcp', command: 'npx',
        args: ['-y', '@huangyihe/obsidian-mcp', 'D:\\vault 中文\\with spaces\\', '%MAESTRO_QUOTE_PROBE%', '!literal! & ^ | < > ( )'],
        env: { OBSIDIAN_VAULT_PATH: 'unused', OBSIDIAN_API_TOKEN: 'unused', OBSIDIAN_API_PORT: '27123' },
      }]),
      '-c', 'model_providers.test.base_url="https://example.test/v1?a=1&b=2"', '-', '',
    ]
    const lines: string[] = []
    const { outcome } = runProcess({
      file, args, env: { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env['PATH'] ?? ''}`, MAESTRO_QUOTE_PROBE: 'must-not-expand' },
      timeoutMs: 5_000, signal: new AbortController().signal,
      onStdoutLine: line => { lines.push(line) },
    })
    const result = await outcome
    expect(result.stderrTail).toBe('')
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(JSON.parse(lines.join('\n'))).toEqual(args)
  })
})
