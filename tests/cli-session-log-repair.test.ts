import { afterAll, describe, expect, it } from 'vitest'
import { isDeepStrictEqual } from 'node:util'
import { link, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { planCliSessionRepair, repairCliSessionLogFile } from '../scripts/repair-cli-session-logs.mjs'
import { decodeSessionLog, sha256 } from '../scripts/session-log-codec.mjs'
import { createOwnedTestFixture, type OwnedTestFixture } from './owned-test-fixture.js'

const originalRows = () => [
  { type: 'session', version: 4, id: 'cli-task-synthetic', createdAt: 1, isSeeded: false, delegationDepth: 0, origin: 'subagent', parentSession: 'synthetic-parent' },
  { type: 'request/context', seq: 0, time: 2, data: { provider: 'synthetic-provider', model: 'synthetic-model' } },
  { type: 'maestro/cli-child', seq: 1, time: 2, ignorable: true, data: {
    version: 1, kind: 'cli-record', executor: 'external-cli', taskId: 'task-synthetic', childSessionId: 'cli-task-synthetic', parentSessionId: 'synthetic-parent',
    source: 'cli:codex', usageId: 'synthetic-usage', accounting: 'native-mirror-of-parent-cli-ledger', parentAndNativeSameSpend: true, nativeInputSemantics: 'uncached',
    recoveredFrom: 'canonical', untouched: { text: 'synthetic only' },
  } },
  { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
  { type: 'assistant/attempt', seq: 3, time: 4, data: { turn: 1, step: 1, stream: [
    { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 30, cacheWriteTokens: 4 } } },
    { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 20, outputTokens: 3, cacheReadTokens: 40, cacheWriteTokens: 5 } } },
  ] } },
]
const jsonl = (rows: any[]) => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n')
const compressed = (rows = originalRows()) => Buffer.concat([
  zstdCompressSync(jsonl(rows.slice(0, 1))),
  ...rows.slice(1).map(row => zstdCompressSync(jsonl([row]))),
])
// A deterministic contract seam for transformation/transaction tests. The
// installed-host suite separately certifies the complete released v4 schema.
const validateRows = (rows: any[]) => {
  if (rows[1]?.type !== 'turn/start') throw new Error('synthetic legacy format')
  expect(rows.slice(1).map(row => row.type)).toEqual([
    'turn/start', 'request/context', 'maestro/cli-child', 'step/start', 'assistant/attempt', 'step/end', 'turn/end',
  ])
  rows.slice(1).forEach((row, index) => expect(row.seq).toBe(index))
}
let owned: OwnedTestFixture | undefined
let fixtureIndex = 0
async function fixture(bytes = compressed()) {
  owned ??= createOwnedTestFixture(await realpath(tmpdir()), 'maestro-cli-migration-test-')
  const directory = join(owned.path, String(++fixtureIndex))
  await mkdir(directory)
  const path = join(directory, 'session.v4.jsonl.zstd')
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  return { directory, path, bytes }
}
afterAll(() => owned?.remove())

function runtime(onAcquire?: () => Promise<void>) {
  const state = { acquired: 0, released: 0, held: false }
  return { state, validateRows, async acquireLease(_dir: string, id: string) {
    expect(id).toBe('cli-task-synthetic')
    state.acquired++; state.held = true
    await onAcquire?.()
    return { async release() { expect(state.held).toBe(true); state.held = false; state.released++ } }
  } }
}

describe('legacy CLI lifecycle migration', () => {
  it.each(['jsonl', 'zstd'])('preserves every original field and final cumulative usage in %s', encoding => {
    const rows = originalRows()
    const raw = encoding === 'jsonl' ? jsonl(rows) : compressed(rows)
    const result = planCliSessionRepair(raw, { validateRows, encoding })
    expect(result.changed).toBe(true)
    expect(result.stats).toMatchObject({ originalEvents: 4, resultEvents: 7, addedEvents: 3,
      usage: { inputTokens: 20, outputTokens: 3, cacheReadTokens: 40, cacheWriteTokens: 5, attempts: 1, messages: 0 } })
    expect(isDeepStrictEqual(result.rows[0], rows[0])).toBe(true)
    for (let i = 1; i < rows.length; i++) {
      const { seq, ...before } = rows[i] as any
      const { seq: nextSeq, ...after } = result.rows[i + 1]
      expect(nextSeq).toBe(seq + 1)
      expect(isDeepStrictEqual(before, after)).toBe(true)
    }
    expect(result.rows.at(-1).data.reason).toEqual({ kind: 'error', error: {
      code: 'LEGACY_CLI_OUTCOME_UNKNOWN', message: 'Legacy CLI outcome unavailable; preserve original assistant/attempt accounting.',
    } })
    const twice = planCliSessionRepair(result.bytes, { validateRows, encoding })
    expect(twice.changed).toBe(false)
    expect(twice.bytes.equals(result.bytes)).toBe(true)
    if (encoding === 'zstd') {
      const before = decodeSessionLog(raw), after = decodeSessionLog(result.bytes)
      expect(result.bytes.subarray(0, after.frames[0].end).equals(raw.subarray(0, before.frames[0].end))).toBe(true)
      expect(after.frames).toHaveLength(2)
    }
  })

  it('requires the host validator and never overrides a rejecting replacement validator', () => {
    expect(() => planCliSessionRepair(compressed())).toThrow('HOST_VALIDATOR_REQUIRED')
    expect(() => planCliSessionRepair(compressed(), { validateRows() { throw new Error('reject replacement') } })).toThrow('reject replacement')
  })

  it.each(['identity', 'marker', 'seeded', 'unknown-event', 'surface-op'])('refuses an unrecognized %s without rewriting it', mode => {
    const rows: any[] = originalRows()
    if (mode === 'identity') rows[2].data.childSessionId = 'different-child'
    if (mode === 'marker') delete rows[2].ignorable
    if (mode === 'seeded') rows[0].isSeeded = true
    if (mode === 'unknown-event') rows[4].type = 'assistant/message'
    if (mode === 'surface-op') rows[4].surfaceOp = { test: true }
    expect(() => planCliSessionRepair(compressed(rows), { validateRows })).toThrow('NOT_RECOGNIZED_LEGACY_CLI_LOG')
  })

  it('refuses torn frames and duplicate keys instead of accepting a prefix', () => {
    const raw = compressed()
    expect(() => planCliSessionRepair(raw.subarray(0, raw.length - 1), { validateRows })).toThrow()
    const rows = originalRows()
    const text = jsonl(rows).toString().replace('"version":4', '"version":4,"version":4')
    expect(() => planCliSessionRepair(Buffer.from(text), { validateRows })).toThrow('DUPLICATE_JSON_KEY')
  })

  it('dry-run does not acquire a writer or create artifacts', async () => {
    const f = await fixture(), rt = runtime()
    const result = await repairCliSessionLogFile(f.path, { runtime: rt })
    expect(result).toMatchObject({ status: 'dry-run', changed: true })
    expect(rt.state.acquired).toBe(0)
    expect(await readdir(f.directory)).toEqual(['session.v4.jsonl.zstd'])
    expect((await readFile(f.path)).equals(f.bytes)).toBe(true)
  })

  it('refuses a stale expected hash before taking the writer lease', async () => {
    const f = await fixture(), rt = runtime()
    await expect(repairCliSessionLogFile(f.path, { runtime: rt, apply: true, expectSha256: '0'.repeat(64) })).rejects.toThrow('EXPECTED_SHA256_REQUIRED_OR_MISMATCH')
    expect(rt.state.acquired).toBe(0)
    expect((await readFile(f.path)).equals(f.bytes)).toBe(true)
  })

  it('refuses a busy writer without creating a backup', async () => {
    const f = await fixture()
    await expect(repairCliSessionLogFile(f.path, { runtime: { validateRows, async acquireLease() { throw new Error('HOST_WRITER_BUSY') } }, apply: true, expectSha256: sha256(f.bytes) })).rejects.toThrow('HOST_WRITER_BUSY')
    expect(await readdir(f.directory)).toEqual(['session.v4.jsonl.zstd'])
  })

  it('publishes once with an exact durable backup, releases the writer, then reruns unchanged', async () => {
    const f = await fixture(), rt = runtime()
    const result = await repairCliSessionLogFile(f.path, { runtime: rt, apply: true, expectSha256: sha256(f.bytes) })
    expect(result).toMatchObject({ status: 'applied', changed: true, backupSha256: sha256(f.bytes) })
    expect((await readFile(result.backupPath)).equals(f.bytes)).toBe(true)
    const fixed = await readFile(f.path)
    expect(sha256(fixed)).toBe(result.resultSha256)
    validateRows(JSON.parse('[' + decodeSessionLog(fixed).plaintext.toString().trim().split('\n').join(',') + ']'))
    expect(rt.state).toEqual({ acquired: 1, released: 1, held: false })
    const again = await repairCliSessionLogFile(f.path, { runtime: rt, apply: true })
    expect(again.status).toBe('unchanged')
    expect(rt.state.acquired).toBe(1)
    expect((await readFile(f.path)).equals(fixed)).toBe(true)
    expect(await readdir(f.directory)).toHaveLength(2)
  })

  it('reuses an identical backup but refuses an existing backup with different bytes', async () => {
    for (const matching of [true, false]) {
      const f = await fixture(), rt = runtime()
      const backup = f.path + '.maestro-cli-original-' + sha256(f.bytes) + '.bak'
      await writeFile(backup, matching ? f.bytes : Buffer.from('synthetic conflicting backup'))
      const result = repairCliSessionLogFile(f.path, { runtime: rt, apply: true, expectSha256: sha256(f.bytes) })
      if (matching) expect((await result).status).toBe('applied')
      else {
        await expect(result).rejects.toThrow('BACKUP_ALREADY_EXISTS_WITH_DIFFERENT_BYTES')
        expect((await readFile(f.path)).equals(f.bytes)).toBe(true)
      }
      expect(rt.state.released).toBe(1)
    }
  })

  it('detects a source change after acquiring the writer and always releases it', async () => {
    const f = await fixture()
    const replacement = Buffer.concat([f.bytes, Buffer.from('synthetic mutation')])
    const rt = runtime(async () => { await writeFile(f.path, replacement) })
    await expect(repairCliSessionLogFile(f.path, { runtime: rt, apply: true, expectSha256: sha256(f.bytes) })).rejects.toThrow('SOURCE_CHANGED')
    expect(rt.state.released).toBe(1)
    expect((await readFile(f.path)).equals(replacement)).toBe(true)
    expect(await readdir(f.directory)).toEqual(['session.v4.jsonl.zstd'])
  })

  it('refuses hard links without modifying either name', async () => {
    const f = await fixture(), rt = runtime()
    const alias = join(f.directory, 'synthetic-link')
    await link(f.path, alias)
    await expect(repairCliSessionLogFile(f.path, { runtime: rt, apply: true, expectSha256: sha256(f.bytes) })).rejects.toThrow('HARD_LINK_REFUSED')
    expect((await readFile(f.path)).equals(f.bytes)).toBe(true)
    expect((await readFile(alias)).equals(f.bytes)).toBe(true)
    expect(rt.state.acquired).toBe(0)
  })
})
