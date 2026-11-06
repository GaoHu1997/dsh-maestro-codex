import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const hostExe = process.env.DSH_SESSION_FORMAT_HOST_EXE ?? 'D:/devlop/DeepSeek Harness/DeepSeek Harness.exe'
const hostRoot = process.env.DSH_SESSION_FORMAT_HOST_ROOT ?? 'D:/devlop/DeepSeek Harness/resources/app.asar/dsh'
const enabled = process.env.DSH_SESSION_FORMAT_HOST_EXE !== undefined || existsSync(hostExe)
const repo = fileURLToPath(new URL('../', import.meta.url))
const runner = fileURLToPath(new URL('./session-artifact-runtime-runner.mjs', import.meta.url))

// Optional installed-host integration. Native locks are exercised only against
// an isolated repository temporary directory; no user session is opened or changed.
describe.skipIf(!enabled)('installed host artifact runtime', () => {
  it('validates full v4 artifacts and shares the native writer lease protocol', () => {
    const spawnedAt = Date.now()
    if (process.env.DSH_HOST_TEST_TRACE === '1') console.info(JSON.stringify({ phase: 'spawn-start', at: spawnedAt, hostExe }))
    const result = spawnSync(hostExe, [runner], {
      cwd: repo,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_SESSION_FORMAT_HOST_ROOT: hostRoot },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    })
    if (process.env.DSH_HOST_TEST_TRACE === '1') console.info(JSON.stringify({ phase: 'spawn-returned', at: Date.now(),
      elapsed: Date.now() - spawnedAt, error: result.error?.message, status: result.status, signal: result.signal,
      stdout: result.stdout, stderr: result.stderr }))
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    const report = JSON.parse(result.stdout.trim()) as {
      version: string, platform: string, completed: string[], userSessionsUntouched: boolean
    }
    expect(['0.2.1-rc.5', '0.2.2-rc.1']).toContain(report.version)
    expect(report.userSessionsUntouched).toBe(true)
    expect(report.completed).toEqual([
      'full-v4-lifecycle', 'real-context-outside-turn-rejected', 'turn-local-step-reset',
      'invalid-step-rejected', 'ignorable-extension-admission', 'unseeded-marker-rejected',
      'independent-native-writer-blocks-adapter', 'adapter-blocks-independent-native-writer',
      'adapter-release-idempotent-and-native-reacquires', 'adapter-reacquires-after-native-close',
    ])
    console.info(`host ${report.version} ${report.platform}: ${report.completed.join(', ')}`)
  }, 40_000)
})
