import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { constants, zstdCompressSync } from 'node:zlib'
import { link, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeSessionLog, repairSessionLogBytes, scanZstdFrames, sha256 } from '../scripts/session-log-codec.mjs'
import { parseRepairArgs, repairSessionLogFile } from '../scripts/repair-maestro-session-logs.mjs'

const SECRET = 'SYNTHETIC_ONLY_NEVER_PRINT_THIS_VALUE'
const header = '{"type":"session","version":4,"id":"synthetic-session","createdAt":1,"isSeeded":false,"delegationDepth":0}\r\n'
const rows = [
  '{"type":"turn/start","seq":0,"time":1,"data":{}}\n',
  ` { "type":"maestro/cli-access", "seq":1,"time":2,"data":{"token":"${SECRET}","text":"中文","ignorable":false,"number":9.007199254740993e15} }\r\n`,
  '{"type":"maestro/cli-usage","seq":2,"time":3,"data":{"value":1.00e+2}}\n',
  '{"type":"maestro/cli-child","seq":3,"time":4,"data":{"version":1}}\n',
  '{"type":"another/unknown-required","seq":4,"time":5,"data":{"unchanged":true}}\n',
  '{"type":"turn/end","seq":5,"time":6,"data":{}}\n',
]
const original = Buffer.from(header + rows.join(''))
const mark = (line: string) => {
  const at = line.lastIndexOf('}')
  return line.slice(0, at) + ',"ignorable":true' + line.slice(at)
}
const expectedPlain = Buffer.from(header + rows.map((row, i) => i >= 1 && i <= 3 ? mark(row) : row).join(''))
const compress = (bytes: Buffer) => zstdCompressSync(bytes)
const encoded = () => Buffer.concat([compress(Buffer.from(header)), compress(Buffer.from(rows[0])), compress(Buffer.from(rows.slice(1).join('')))])
const directories: string[] = []
async function fixture(bytes = original, filename = 'session.v4.jsonl') {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'maestro-log-repair-test-'))
  directories.push(directory)
  const path = join(directory, filename)
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  return { directory, path }
}
async function vacantPort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('synthetic listener failed')
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('bounded byte-preserving Maestro metadata codec', () => {
  it('marks exactly three root envelopes without reserializing header/core/data/numeric spellings', () => {
    const result = repairSessionLogBytes(original)
    expect(result.bytes.equals(expectedPlain)).toBe(true)
    expect(result.stats.changed).toBe(3)
    expect(result.stats.eventCount).toBe(rows.length)
    expect(result.stats.targets['maestro/cli-access'].marked).toBe(1)
    expect(result.stats.headerSha256).toBe(sha256(Buffer.from(header)))
    expect(result.bytes.toString().includes(rows[4])).toBe(true)
    expect(JSON.stringify(result.stats)).not.toContain(SECRET)
    expect(JSON.parse(result.bytes.toString().split('\n')[2]).data.ignorable).toBe(false)
  })

  it('reads all concatenated frames and preserves unchanged header/core compressed frames', () => {
    const raw = encoded()
    const result = repairSessionLogBytes(raw, { encoding: 'zstd' })
    const output = decodeSessionLog(result.bytes, { encoding: 'zstd' })
    expect(output.plaintext.equals(expectedPlain)).toBe(true)
    expect(result.stats.frameCount).toBe(3)
    expect(result.stats.eventCount).toBe(6)
    const before = scanZstdFrames(raw)
    const after = scanZstdFrames(result.bytes)
    for (const i of [0, 1]) {
      expect(result.bytes.subarray(after[i].start, after[i].end).equals(raw.subarray(before[i].start, before[i].end))).toBe(true)
    }
  })

  it('handles UTF-8 and JSON records split across standard frames, including insertion at a frame boundary', () => {
    const body = Buffer.from(rows.join(''))
    const insideUtf8 = body.indexOf(Buffer.from('中文')) + 1
    const boundary = Buffer.byteLength(rows[0] + rows[1].slice(0, rows[1].lastIndexOf('}')))
    const raw = Buffer.concat([compress(Buffer.from(header)), compress(body.subarray(0, insideUtf8)), compress(body.subarray(insideUtf8, boundary)), compress(body.subarray(boundary))])
    expect(decodeSessionLog(repairSessionLogBytes(raw).bytes).plaintext.equals(expectedPlain)).toBe(true)
  })

  it('is byte-for-byte idempotent for both encodings', () => {
    for (const raw of [original, encoded()]) {
      const once = repairSessionLogBytes(raw)
      const twice = repairSessionLogBytes(once.bytes)
      expect(twice.stats.changed).toBe(0)
      expect(twice.stats.targets['maestro/cli-child'].alreadyMarked).toBe(1)
      expect(twice.bytes.equals(once.bytes)).toBe(true)
    }
  })

  it('retains a completely unrelated required event without promising it will become readable', () => {
    const raw = Buffer.from(header + '{"type":"other/required","seq":0,"time":1,"data":null}\n')
    const result = repairSessionLogBytes(raw)
    expect(result.stats.changed).toBe(0)
    expect(result.bytes.equals(raw)).toBe(true)
  })

  it('refuses every truncated final frame rather than accepting the complete prefix', () => {
    const first = compress(Buffer.from(header))
    const last = compress(Buffer.from(rows.join('')))
    for (const cut of [1, 2, 5, Math.floor(last.length / 2), last.length - 1]) {
      expect(() => repairSessionLogBytes(Buffer.concat([first, last.subarray(0, cut)]))).toThrow()
    }
  })

  it('refuses checksum corruption and trailing garbage', () => {
    const frame = zstdCompressSync(Buffer.from(rows.join('')), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
    frame[frame.length - 1] ^= 1
    expect(() => repairSessionLogBytes(Buffer.concat([compress(Buffer.from(header)), frame]))).toThrow('ZSTD_DECODE_FAILED')
    expect(() => repairSessionLogBytes(Buffer.concat([encoded(), Buffer.from('garbage')]))).toThrow()
  })

  it('refuses reserved block types, dictionaries, and skippable-frame magic', () => {
    expect(() => scanZstdFrames(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 1, 7, 0, 0]))).toThrow('ZSTD_RESERVED_BLOCK')
    expect(() => scanZstdFrames(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x21, 1]))).toThrow('ZSTD_DICTIONARY_UNSUPPORTED')
    expect(() => scanZstdFrames(Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]))).toThrow('UNSUPPORTED_ZSTD_MAGIC')
  })

  it('refuses a compressed header frame that contains event rows', () => {
    expect(() => repairSessionLogBytes(compress(original))).toThrow('INVALID_ZSTD_HEADER_FRAME')
  })

  it('refuses bad UTF-8 and incomplete final JSONL lines without exposing text', () => {
    expect(() => repairSessionLogBytes(Buffer.concat([Buffer.from(header), Buffer.from([0xff, 10])]))).toThrow('INVALID_UTF8')
    expect(() => repairSessionLogBytes(original.subarray(0, original.length - 1))).toThrow('TORN_JSONL_TAIL')
    expect(() => repairSessionLogBytes(Buffer.from(header + `{"${SECRET}": broken}\n`))).toThrow('INVALID_JSON')
  })

  it.each([
    '{"type":"maestro/cli-access","seq":1,"time":1,"data":{}}',
    '{"type":"maestro/cli-access","seq":0,"time":1}',
    '{"type":"maestro/cli-access","seq":0,"time":1,"data":{},"ignorable":false}',
    '{"type":"maestro/cli-access","seq":0,"time":1,"data":{},"ignorable":null}',
    '{"type":"maestro/cli-access","seq":0,"time":1.5,"data":{}}',
    '{"type":"maestro/cli-access","seq":0,"time":1,"data":{},"extra":0}',
  ])('refuses an invalid event envelope: case %#', (row) => {
    expect(() => repairSessionLogBytes(Buffer.from(header + row + '\n'))).toThrow('INVALID_EVENT_ENVELOPE')
  })

  it('refuses duplicate/escaped keys, invalid JSON, nonfinite numbers, and excessive depth', () => {
    const bad = [
      '{"type":"maestro/cli-access","type":"other","seq":0,"time":1,"data":{}}',
      '{"type":"maestro/cli-access","seq":0,"time":1,"data":{"a":1,"\\u0061":2}}',
    ]
    for (const row of bad) expect(() => repairSessionLogBytes(Buffer.from(header + row + '\n'))).toThrow('DUPLICATE_JSON_KEY')
    expect(() => repairSessionLogBytes(Buffer.from(header + '{"type":"x","seq":0,"time":1,"data":1e999}\n'))).toThrow('INVALID_JSON')
    expect(() => repairSessionLogBytes(original, { maxJsonDepth: 1 })).toThrow('JSON_DEPTH_LIMIT')
  })

  it('refuses unsupported headers and enforces configured bounds without partial output', () => {
    expect(() => repairSessionLogBytes(Buffer.from(header.replace('"version":4', '"version":3')))).toThrow('UNSUPPORTED_OR_INVALID_V4_HEADER')
    expect(() => repairSessionLogBytes(encoded(), { maxFrames: 1 })).toThrow('TOO_MANY_ZSTD_FRAMES')
    expect(() => repairSessionLogBytes(original, { maxLineBytes: 8 })).toThrow('JSON_LINE_SIZE_LIMIT')
    expect(() => repairSessionLogBytes(original, { maxInputBytes: 8 })).toThrow('INVALID_INPUT_SIZE')
  })
})

describe('offline file repair with exclusive verified backups', () => {
  it('defaults to dry-run, creates no artifacts, and reports no synthetic secret', async () => {
    const { path, directory } = await fixture()
    const result = await repairSessionLogFile(path)
    expect(result.status).toBe('dry-run')
    expect(result.changed).toBe(3)
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect((await readFile(path)).equals(original)).toBe(true)
    expect(await readdir(directory)).toEqual(['session.v4.jsonl'])
  })

  it('requires both a matching expected hash and explicit full-shutdown confirmation', async () => {
    const { path, directory } = await fixture()
    await expect(repairSessionLogFile(path, { apply: true })).rejects.toThrow('EXPECTED_SHA256_REQUIRED_OR_MISMATCH')
    await expect(repairSessionLogFile(path, { apply: true, expectSha256: sha256(original) })).rejects.toThrow('EXPLICIT_OFFLINE_CONFIRMATION_REQUIRED')
    expect(await readdir(directory)).toHaveLength(1)
  })

  it('refuses a listening port before creating any backup or replacement', async () => {
    const { path, directory } = await fixture()
    const server = createServer(socket => socket.destroy())
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('synthetic listener failed')
    try {
      await expect(repairSessionLogFile(path, { apply: true, expectSha256: sha256(original), confirmDshFullyExited: true, ports: [address.port] })).rejects.toThrow('DSH_PORT_IS_LISTENING')
      expect(await readdir(directory)).toHaveLength(1)
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })

  it.each(['jsonl', 'jsonl.zst', 'jsonl.zstd'])('atomically applies to synthetic %s, preserves a byte-exact backup, and repeats as a no-op', async (extension) => {
    const raw = extension === 'jsonl' ? original : encoded()
    const { path, directory } = await fixture(raw, `session.v4.${extension}`)
    const options = { apply: true, expectSha256: sha256(raw), confirmDshFullyExited: true, ports: [await vacantPort()] }
    const result = await repairSessionLogFile(path, options)
    expect(result.status).toBe('applied')
    expect((await readFile(result.backupPath)).equals(raw)).toBe(true)
    expect(result.backupSha256).toBe(sha256(raw))
    const final = await readFile(path)
    expect(decodeSessionLog(final).plaintext.equals(expectedPlain)).toBe(true)
    expect((await repairSessionLogFile(path, options)).status).toBe('unchanged')
    expect((await readFile(path)).equals(final)).toBe(true)
    expect(await readdir(directory)).toHaveLength(2)
  })

  it('never overwrites an existing backup even if its bytes differ', async () => {
    const { path, directory } = await fixture()
    const backup = `${path}.maestro-original-${sha256(original)}.bak`
    await writeFile(backup, 'sentinel', { flag: 'wx', mode: 0o600 })
    await expect(repairSessionLogFile(path, { apply: true, expectSha256: sha256(original), confirmDshFullyExited: true, ports: [await vacantPort()] })).rejects.toThrow('BACKUP_ALREADY_EXISTS')
    expect(await readFile(backup, 'utf8')).toBe('sentinel')
    expect((await readFile(path)).equals(original)).toBe(true)
    expect(await readdir(directory)).toHaveLength(2)
  })

  it('refuses path links/junctions and hard-linked log files', async () => {
    const { path, directory } = await fixture()
    const alias = join(directory, 'alias')
    await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(repairSessionLogFile(join(alias, 'session.v4.jsonl'))).rejects.toThrow('LINK_REFUSED')
    await link(path, join(directory, 'hard.jsonl'))
    await expect(repairSessionLogFile(path)).rejects.toThrow('HARD_LINK_REFUSED')
  })

  it('runs the CLI as a default read-only command with redacted success and failure output', { timeout: 25_000 }, async () => {
    const { path, directory } = await fixture()
    const script = fileURLToPath(new URL('../scripts/repair-maestro-session-logs.mjs', import.meta.url))
    const run = promisify(execFile)
    // Two real Node processes share a busy Windows worker pool; keep each bounded.
    const success = await run(process.execPath, [script, path], { timeout: 10_000, windowsHide: true })
    expect(JSON.parse(success.stdout).status).toBe('dry-run')
    expect(success.stdout + success.stderr).not.toContain(SECRET)
    expect(await readdir(directory)).toHaveLength(1)
    const broken = await fixture(Buffer.from(header + `{"${SECRET}": broken}\n`))
    try {
      await run(process.execPath, [script, broken.path], { timeout: 10_000, windowsHide: true })
      throw new Error('invalid synthetic log was accepted')
    } catch (error: any) {
      expect(error.code).toBe(1)
      expect(error.stdout + error.stderr).not.toContain(SECRET)
      expect(JSON.parse(error.stderr).code).toBe('INVALID_JSON')
    }
  })

  it('parses dry-run by default and never removes the current GUI port from CLI checks', () => {
    expect(parseRepairArgs(['/absolute/synthetic.jsonl']).options.apply).toBe(false)
    expect(parseRepairArgs(['--port', '12345', '/absolute/synthetic.jsonl']).options.ports).toEqual([14983, 12345])
    expect(() => parseRepairArgs(['--apply', '--dry-run', '/absolute/synthetic.jsonl'])).toThrow('INVALID_ARGUMENTS')
  })
})
