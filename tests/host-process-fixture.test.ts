import { type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runHostProcess, type HostProcessOptions, type HostProcessResult } from './host-process-fixture'

const repo = fileURLToPath(new URL('../', import.meta.url))
const largeInput = JSON.stringify({ code: 'x'.repeat(4 * 1024 * 1024), suite: 'synthetic' })
const consumeInput = 'process.stdin.resume(); process.stdin.on("end", () => {'

/** Real Node children only. Always reap our child even when testing the old buggy helper. */
async function observeRun(script: string, overrides: Partial<HostProcessOptions> = {}, command = process.execPath) {
  let child: ChildProcess | undefined
  let closed = false
  let closeObserved: Promise<void> = Promise.resolve()
  let stdinError: Error | undefined
  let result: HostProcessResult | undefined
  let failure: unknown
  let rejected = false
  const promise = runHostProcess(command, ['-e', script], {
    cwd: repo, env: { SystemRoot: process.env.SystemRoot ?? '' },
    timeout: 5_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, input: '{}',
    ...overrides,
    onChild(value) {
      child = value
      closeObserved = new Promise<void>(resolve => value.once('close', () => { closed = true; resolve() }))
      value.stdin?.once('error', error => { stdinError = error })
      overrides.onChild?.(value)
    },
  })
  try { result = await promise } catch (error) { rejected = true; failure = error }
  const closedAtSettlement = closed
  // This safety cleanup is deliberately after recording the regression observation.
  if (!closed) child?.kill('SIGKILL')
  await closeObserved
  let alive = false
  if (child?.pid !== undefined) {
    try { process.kill(child.pid, 0); alive = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  expect(alive).toBe(false)
  return { result, rejected, failure, stdinError, closedAtSettlement, child }
}

function errorCode(error: unknown): unknown { return (error as NodeJS.ErrnoException | undefined)?.code }

describe('test-only host process fixture with real Node children', () => {
  it('delivers the entire input and resolves only after close', async () => {
    const run = await observeRun('let s=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", x=>s+=x); process.stdin.on("end", ()=>{ const r=JSON.parse(s); console.log(JSON.stringify({suite:r.suite,bytes:r.code.length})); });', { input: largeInput })
    expect(run.rejected).toBe(false)
    expect(run.closedAtSettlement).toBe(true)
    expect(run.result?.exitCode).toBe(0)
    expect(JSON.parse(run.result!.stdout)).toEqual({ suite: 'synthetic', bytes: 4 * 1024 * 1024 })
  }, 15_000)

  it('reaps a blocked stdin writer during teardown and preserves its first stdin error', async () => {
    const run = await observeRun('process.stdin.destroy(); setInterval(()=>{},1000);', { input: largeInput })
    expect(run.rejected).toBe(true)
    expect(['EOF', 'EPIPE', 'ECONNRESET']).toContain(errorCode(run.failure))
    expect(run.failure).toBe(run.stdinError)
    expect(run.closedAtSettlement).toBe(true)
  }, 15_000)

  it('does not accept successful JSON from an early exit with unconsumed stdin', async () => {
    const run = await observeRun('console.log(JSON.stringify({ok:true})); process.exit(0);', { input: largeInput })
    expect(run.rejected).toBe(true)
    expect(['EOF', 'EPIPE', 'ECONNRESET']).toContain(errorCode(run.failure))
    expect(run.failure).toBe(run.stdinError)
    expect(run.closedAtSettlement).toBe(true)
  }, 15_000)

  it('retains a nonzero exit even when stdout contains valid JSON', async () => {
    const run = await observeRun(`${consumeInput} console.log(JSON.stringify({ok:true})); process.exitCode=7; });`)
    expect(run.rejected).toBe(true)
    expect(errorCode(run.failure)).toBe(7)
    expect(run.closedAtSettlement).toBe(true)
  }, 15_000)

  it('rejects a bounded timeout and returns only after close', async () => {
    const run = await observeRun('process.stdin.resume(); setInterval(()=>{},1000);', { timeout: 300 })
    expect(run.rejected).toBe(true)
    expect(run.closedAtSettlement).toBe(true)
  }, 15_000)

  it('waits for failed spawn close and preserves ENOENT', async () => {
    const missing = process.platform === 'win32' ? 'D:/__dsh_synthetic_absent__/node-does-not-exist.exe' : '/__dsh_synthetic_absent__/node-does-not-exist'
    const run = await observeRun('', {}, missing)
    expect(run.rejected).toBe(true)
    expect(errorCode(run.failure)).toBe('ENOENT')
    expect(run.closedAtSettlement).toBe(true)
  }, 15_000)

  it('reaps a real child and rethrows the same observer failure', async () => {
    const original = new Error('synthetic observer refusal')
    const run = await observeRun('setInterval(()=>{},1000);', { onChild() { throw original } })
    expect(run.rejected).toBe(true)
    expect(run.failure).toBe(original)
    expect(run.closedAtSettlement).toBe(true)
  }, 15_000)

  it('rejects output overflow rather than returning truncated success', async () => {
    const run = await observeRun(`${consumeInput} process.stdout.write("x".repeat(65536)); });`, { maxBuffer: 1024, timeout: 10_000 })
    expect(run.rejected).toBe(true)
    expect(errorCode(run.failure)).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    expect(run.closedAtSettlement).toBe(true)
  }, 15_000)
})
