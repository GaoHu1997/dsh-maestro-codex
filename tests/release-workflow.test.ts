import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

type ReleaseStep = { name?: string; uses?: string; if?: string; run?: string }
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflow = parse(readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')) as {
  on: { push: { tags: string[] }; workflow_dispatch: unknown }
  jobs: { release: { steps: ReleaseStep[] } }
}
const steps = workflow.jobs.release.steps
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
const protectedNames = ['Tag matches package.json', 'Publish to npm', 'Create GitHub Release']
const fixtures: string[] = []
// Git Bash (and the tag check's Node child) needs startup headroom on Windows.
const BASH_TIMEOUT_MS = 15_000
const BASH_TEST_TIMEOUT_MS = BASH_TIMEOUT_MS + 5_000

function step(name: string): ReleaseStep {
  const value = steps.find(item => item.name === name)
  if (!value) throw new Error(`Missing release step: ${name}`)
  return value
}

// Evaluate only the expressions used by this workflow. Unknown terms fail the
// test instead of silently accepting a newly introduced publication condition.
function enabled(condition: string | undefined, eventName: string, ref: string): boolean {
  if (!condition) return true
  const expression = condition.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '')
  const terms = expression.split('&&').map(term => term.trim()).map(term => {
    const event = /^github\.event_name\s*==\s*'([^']+)'$/.exec(term)
    if (event) return eventName === event[1]
    const tag = /^startsWith\(github\.ref,\s*'([^']+)'\)$/.exec(term)
    if (tag) return ref.startsWith(tag[1]!)
    throw new Error(`Unsupported release condition: ${term}`)
  })
  return terms.every(Boolean)
}

function fixture(): string {
  const directory = mkdtempSync(join(root, 'tests', '.release-workflow-'))
  fixtures.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    const rest = relative(join(root, 'tests'), directory)
    if (isAbsolute(rest) || !rest.startsWith('.release-workflow-') || /[\\/]/.test(rest)
      || lstatSync(directory).isSymbolicLink()
      || realpathSync.native(directory).toLowerCase() !== directory.toLowerCase()) {
      throw new Error(`Unsafe release workflow fixture cleanup: ${directory}`)
    }
    rmSync(directory, { recursive: true, force: false })
  }
})

// Linux CI always has Bash. On Windows prefer Git Bash over the unrelated WSL
// launcher; pure condition checks still run if a developer has no Bash installed.
const bashCandidates = process.platform === 'win32'
  ? [
      join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', 'bash.exe'),
      join(process.env.LOCALAPPDATA || 'C:/Users/Default/AppData/Local', 'Programs', 'Git', 'bin', 'bash.exe'),
      ...(process.env.PATH || '').split(delimiter).map(directory => join(directory, 'bash.exe')).filter(existsSync),
    ].filter(existsSync)
  : ['bash']
const bash = bashCandidates.find(candidate => {
  const probe = spawnSync(candidate, ['--noprofile', '--norc', '-c', 'printf maestro-release-bash'], {
    encoding: 'utf8', timeout: BASH_TIMEOUT_MS, windowsHide: true,
  })
  return probe.status === 0 && probe.stdout === 'maestro-release-bash'
})

function runBash(source: string, cwd: string, env: NodeJS.ProcessEnv = {}) {
  if (!bash) throw new Error('Release workflow integration tests require Bash')
  return spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', source], {
    cwd, encoding: 'utf8', timeout: BASH_TIMEOUT_MS, windowsHide: true,
    env: { ...process.env, BASH_ENV: '', ENV: '', ...env },
  })
}

function release(viewExit: number, createExit: number, uploadExit = 0, secondAsset = false, editExit = 0) {
  const directory = fixture()
  mkdirSync(join(directory, 'dist'))
  const asset = `dist/dsh-maestro-codex-${pkg.version}.tgz`
  writeFileSync(join(directory, asset), 'controlled tarball fixture')
  if (secondAsset) writeFileSync(join(directory, 'dist', 'second.tgz'), 'second controlled fixture')
  const calls = join(directory, 'gh-calls')
  // A shell function intercepts every gh invocation. No real CLI, network,
  // credentials, registry or GitHub repository can be touched by these tests.
  const fake = `gh() {
    printf '%s\\0' "$@" >> "$GH_CALLS"
    printf '\\0' >> "$GH_CALLS"
    case "$2" in
      view) return "$FAKE_VIEW_EXIT" ;;
      create) return "$FAKE_CREATE_EXIT" ;;
      upload) return "$FAKE_UPLOAD_EXIT" ;;
      edit) return "$FAKE_EDIT_EXIT" ;;
      *) return 127 ;;
    esac
  }
`
  const result = runBash(fake + step('Create GitHub Release').run, directory, {
    GH_CALLS: calls.replaceAll('\\', '/'), GITHUB_REF_NAME: `v${pkg.version}`,
    FAKE_VIEW_EXIT: String(viewExit), FAKE_CREATE_EXIT: String(createExit), FAKE_UPLOAD_EXIT: String(uploadExit), FAKE_EDIT_EXIT: String(editExit), GH_TOKEN: '',
  })
  const invocations = existsSync(calls)
    ? readFileSync(calls, 'utf8').split('\0\0').filter(Boolean).map(call => call.split('\0'))
    : []
  return { result, invocations, asset }
}

describe('release publication boundaries', () => {
  it('has only v-tag pushes as an automatic trigger and keeps manual verification', () => {
    expect(workflow.on.push.tags).toEqual(['v*'])
    expect(Object.hasOwn(workflow.on, 'workflow_dispatch')).toBe(true)
    for (const name of ['Install', 'Typecheck', 'Test', 'Build', 'Pack']) {
      expect(enabled(step(name).if, 'workflow_dispatch', `refs/tags/v${pkg.version}`)).toBe(true)
    }
  })

  it.each(protectedNames)('requires both a tag and an actual push event for %s', name => {
    expect(step(name).if).toBe("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')")
  })

  it.each([
    ['workflow_dispatch', 'refs/heads/master', false],
    ['workflow_dispatch', `refs/tags/v${pkg.version}`, false],
    ['push', 'refs/heads/master', false],
    ['push', 'refs/tags/not-a-release', false],
    ['pull_request', `refs/tags/v${pkg.version}`, false],
    ['push', `refs/tags/v${pkg.version}`, true],
  ] as const)('gates all publication steps for %s %s', (event, ref, expected) => {
    for (const name of protectedNames) expect(enabled(step(name).if, event, ref)).toBe(expected)
  })
})

describe.skipIf(!bash)('actual release Bash commands with isolated fixtures', () => {
  it.each([
    [`v${pkg.version}`, 0],
    ['v999.999.999', 1],
    [`v${pkg.version}-unexpected`, 1],
  ] as const)('checks the actual package version against tag %s', (tag, status) => {
    const directory = fixture()
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: pkg.version }))
    const executable = process.execPath.replaceAll('\\', '/').replaceAll("'", "'\\''")
    const result = runBash(`node() { '${executable}' "$@"; }\n` + step('Tag matches package.json').run, directory, {
      GITHUB_REF_NAME: tag,
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(status)
  }, BASH_TEST_TIMEOUT_MS)

  it('passes the complete create command and does not upload after success', () => {
    const { result, invocations, asset } = release(127, 0)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(invocations).toEqual([
      ['release', 'view', `v${pkg.version}`],
      [
        'release', 'create', `v${pkg.version}`, '--verify-tag', '--title', `v${pkg.version}`,
        '--notes-file', `.github/releases/v${pkg.version}.md`, asset,
      ],
    ])
  }, BASH_TEST_TIMEOUT_MS)

  it('uploads the same tarball with clobber and rewrites the notes when the release already exists', () => {
    const { result, invocations, asset } = release(0, 0)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(invocations).toHaveLength(3)
    expect(invocations[1]).toEqual(['release', 'upload', `v${pkg.version}`, asset, '--clobber'])
    expect(invocations[2]).toEqual(['release', 'edit', `v${pkg.version}`, '--notes-file', `.github/releases/v${pkg.version}.md`])
  }, BASH_TEST_TIMEOUT_MS)

  it('propagates failure when the existing release upload fails', () => {
    const { result, invocations } = release(0, 0, 7)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(7)
    expect(invocations).toHaveLength(2)
  }, BASH_TEST_TIMEOUT_MS)

  it('propagates failure when rewriting the notes of an existing release fails', () => {
    const { result, invocations } = release(0, 0, 0, false, 9)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(9)
    expect(invocations).toHaveLength(3)
    expect(invocations[2]?.[1]).toBe('edit')
  }, BASH_TEST_TIMEOUT_MS)

  it('expands every tarball without a stray backslash argument', () => {
    const { result, invocations, asset } = release(127, 0, 0, true)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const create = invocations.find(call => call[1] === 'create')
    expect(create?.slice(-2)).toEqual([asset, 'dist/second.tgz'])
  }, BASH_TEST_TIMEOUT_MS)
})
