import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { beforeAll, describe, expect, it } from 'vitest'

/** Optional installed-host integration; all cases run when the host is present.
 * Configure both values for another installation. No host/user files are written.
 * Persistence ownership is simulated; this certifies the released v4 lifecycle,
 * real SDK append/seed and restore API, not the production persistence backend. */
const hostExe = process.env.DSH_SESSION_FORMAT_HOST_EXE ?? 'D:/devlop/DeepSeek Harness/DeepSeek Harness.exe'
const hostRoot = process.env.DSH_SESSION_FORMAT_HOST_ROOT ?? 'D:/devlop/DeepSeek Harness/resources/app.asar/dsh'
const repo = fileURLToPath(new URL('../', import.meta.url))
const runner = fileURLToPath(new URL('./host-session-format-runner.mjs', import.meta.url))
const enabled = process.env.DSH_SESSION_FORMAT_HOST_EXE !== undefined || existsSync(hostExe)

describe.skipIf(!enabled)('released host v4 CLI child lifecycle', () => {
  let code = ''
  beforeAll(async () => {
    const root = path.join(hostRoot, 'node_modules')
    const result = await build({
      stdin: { contents: [
        "export * from './src/child-session.ts'",
        "export * from './src/native-recovery.ts'",
        "export { applyCliRecordEvent, initCliRecordState } from './src/cli-record-projection.ts'",
      ].join('\n'), resolveDir: repo, sourcefile: 'host-format-entry.ts', loader: 'ts' },
      bundle: true, write: false, platform: 'node', format: 'esm',
      plugins: [{ name: 'real-host-sdk', setup(builder) {
        builder.onResolve({ filter: /^@deepseek-ai\// }, args => ({
          path: pathToFileURL(path.join(root, args.path, 'lib/index.js')).href, external: true,
        }))
      } }],
    })
    code = result.outputFiles[0]!.text
  })

  it.each(['producer', 'retry', 'recovery'])('validates %s output using the installed codec and Session', suite => {
    const spawnedAt = Date.now()
    if (process.env.DSH_HOST_TEST_TRACE === '1') console.info(JSON.stringify({ phase: 'spawn-start', suite, at: spawnedAt, hostExe }))
    const result = spawnSync(hostExe, [runner], {
      cwd: repo, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_SESSION_FORMAT_HOST_ROOT: hostRoot },
      input: JSON.stringify({ code, suite }), encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    })
    if (process.env.DSH_HOST_TEST_TRACE === '1') console.info(JSON.stringify({ phase: 'spawn-returned', suite,
      at: Date.now(), elapsed: Date.now() - spawnedAt, error: result.error?.message, status: result.status, signal: result.signal,
      stdout: result.stdout, stderr: result.stderr }))
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    const report = JSON.parse(result.stdout.trim()) as { suite: string; versions: Record<string, string>; completed: string[] }
    expect(report.suite).toBe(suite)
    expect(report.versions['dsh-session']).toBeTruthy()
    expect(report.versions['dsh-session-format-v3-to-v4']).toBeTruthy()
    expect(report.completed.length).toBeGreaterThanOrEqual(suite === 'retry' ? 7 : 9)
    console.info(`host ${report.versions['dsh-session']}: ${report.completed.join(', ')}`)
  }, 90_000)
})
