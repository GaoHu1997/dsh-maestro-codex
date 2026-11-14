import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { SUPPORTED_LEASE_VERSIONS } from '../scripts/lib/session-artifact-runtime.mjs'

const hostExe = process.env.DSH_SESSION_FORMAT_HOST_EXE ?? 'D:/devlop/DeepSeek Harness/DeepSeek Harness.exe'
const hostRoot = process.env.DSH_SESSION_FORMAT_HOST_ROOT ?? 'D:/devlop/DeepSeek Harness/resources/app.asar/dsh'
const enabled = process.env.DSH_SESSION_FORMAT_HOST_EXE !== undefined || existsSync(hostExe)
const repo = fileURLToPath(new URL('../', import.meta.url))
const runner = fileURLToPath(new URL('./session-artifact-runtime-runner.mjs', import.meta.url))
const runHost = promisify(execFile)

// Optional installed-host integration. Native locks are exercised only against
// an isolated repository temporary directory; no user session is opened or changed.
describe.skipIf(!enabled)('installed host artifact runtime', () => {
  it('validates full v4 artifacts and enforces the verified writer lease boundary', async () => {
    const spawnedAt = Date.now()
    if (process.env.DSH_HOST_TEST_TRACE === '1') console.info(JSON.stringify({ phase: 'spawn-start', at: spawnedAt, hostExe }))
    // Do not block Node's event loop while Electron closes native handles:
    // spawnSync can report ETIMEDOUT even after the child exits successfully.
    // execFile still rejects real failures and retains the same bounded timeout.
    const result = await runHost(hostExe, [runner], {
      cwd: repo,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_SESSION_FORMAT_HOST_ROOT: hostRoot },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true,
    })
    if (process.env.DSH_HOST_TEST_TRACE === '1') console.info(JSON.stringify({ phase: 'spawn-returned', at: Date.now(),
      elapsed: Date.now() - spawnedAt, stdout: result.stdout, stderr: result.stderr }))
    const report = JSON.parse(result.stdout.trim()) as {
      version: string, platform: string, leaseProtocolVerified: boolean, completed: string[], userSessionsUntouched: boolean
    }
    expect(report.leaseProtocolVerified).toBe(SUPPORTED_LEASE_VERSIONS.includes(report.version))
    expect(report.userSessionsUntouched).toBe(true)
    expect(report.completed).toEqual([
      'full-v4-lifecycle', 'real-context-outside-turn-rejected', 'turn-local-step-reset',
      'invalid-step-rejected', 'ignorable-extension-admission', 'unseeded-marker-rejected',
      ...(report.leaseProtocolVerified ? [
        'independent-native-writer-blocks-adapter', 'adapter-blocks-independent-native-writer',
        'adapter-release-idempotent-and-native-reacquires', 'adapter-reacquires-after-native-close',
      ] : ['unverified-write-lease-refused-before-writes']),
    ])
    console.info(`host ${report.version} ${report.platform}: ${report.completed.join(', ')}`)
  }, 40_000)
})
