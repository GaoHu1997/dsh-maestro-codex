import { createHash } from 'node:crypto'
import { isAbsolute, win32 } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

// This is deliberately not a general log migration or replay implementation.
// It changes one omission-safety bit on three known Maestro metadata records.
export const MAESTRO_METADATA_TYPES = Object.freeze([
  'maestro/cli-access', 'maestro/cli-usage', 'maestro/cli-child',
])
const TARGETS = new Set(MAESTRO_METADATA_TYPES)
const MARKER = Buffer.from(',"ignorable":true')
const ZSTD_MAGIC = 0xfd2fb528
const DEFAULT_LIMITS = Object.freeze({
  maxInputBytes: 128 * 1024 * 1024,
  maxDecodedBytes: 256 * 1024 * 1024,
  maxFrames: 100_000,
  maxBlocks: 1_000_000,
  maxLineBytes: 16 * 1024 * 1024,
  maxJsonDepth: 200,
})

export class SessionLogRepairError extends Error {
  constructor(code) {
    // Never attach JSON/zlib parser messages: they can contain session data.
    super(code)
    this.name = 'SessionLogRepairError'
    this.code = code
  }
}
function fail(code) { throw new SessionLogRepairError(code) }
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function limitsOf(options = {}) {
  const result = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(result)) {
    if (options[key] === undefined) continue
    if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > DEFAULT_LIMITS[key]) fail('INVALID_LIMIT')
    result[key] = options[key]
  }
  return result
}
function need(raw, offset, length) {
  if (offset + length > raw.length) fail('TRUNCATED_ZSTD_FRAME')
}
function uint(raw, offset, bytes) {
  need(raw, offset, bytes)
  let value = 0n
  for (let i = bytes - 1; i >= 0; i--) value = (value << 8n) | BigInt(raw[offset + i])
  return value
}

/** Strict standard-frame boundaries; dictionaries/skippable frames are refused, never silently skipped. */
export function scanZstdFrames(raw, options = {}) {
  const limits = limitsOf(options)
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > limits.maxInputBytes) fail('INVALID_INPUT_SIZE')
  const frames = []
  let offset = 0
  let blocks = 0
  while (offset < raw.length) {
    if (frames.length >= limits.maxFrames) fail('TOO_MANY_ZSTD_FRAMES')
    const start = offset
    need(raw, offset, 5)
    if (raw.readUInt32LE(offset) !== ZSTD_MAGIC) fail('UNSUPPORTED_ZSTD_MAGIC')
    const descriptor = raw[offset + 4]
    offset += 5
    if (descriptor & 0x18) fail('ZSTD_RESERVED_BITS')
    const single = Boolean(descriptor & 0x20)
    const checksum = Boolean(descriptor & 4)
    let windowSize
    if (!single) {
      need(raw, offset, 1)
      const window = raw[offset++]
      const base = 2 ** (10 + (window >>> 3))
      windowSize = base + base / 8 * (window & 7)
      if (windowSize > limits.maxDecodedBytes) fail('ZSTD_WINDOW_LIMIT')
    }
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 3]
    if (uint(raw, offset, dictionaryBytes) !== 0n) fail('ZSTD_DICTIONARY_UNSUPPORTED')
    offset += dictionaryBytes
    const sizeFlag = descriptor >>> 6
    const sizeBytes = sizeFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][sizeFlag]
    let contentSize
    if (sizeBytes) {
      let size = uint(raw, offset, sizeBytes)
      if (sizeBytes === 2) size += 256n
      if (size > BigInt(limits.maxDecodedBytes)) fail('DECODED_SIZE_LIMIT')
      contentSize = Number(size)
      offset += sizeBytes
      if (single) windowSize = contentSize
    }
    let last = false
    while (!last) {
      if (++blocks > limits.maxBlocks) fail('TOO_MANY_ZSTD_BLOCKS')
      need(raw, offset, 3)
      const block = raw.readUIntLE(offset, 3)
      offset += 3
      last = Boolean(block & 1)
      const type = (block >>> 1) & 3
      const length = block >>> 3
      if (type === 3) fail('ZSTD_RESERVED_BLOCK')
      if (length > 128 * 1024) fail('ZSTD_BLOCK_SIZE_LIMIT')
      const payload = type === 1 ? 1 : length
      need(raw, offset, payload)
      offset += payload
    }
    if (checksum) { need(raw, offset, 4); offset += 4 }
    frames.push({ start, end: offset, contentSize, windowSize })
  }
  return frames
}

/** Decode every frame independently (one zstdDecompressSync on a concatenation can return only frame one). */
export function decodeSessionLog(raw, options = {}) {
  const limits = limitsOf(options)
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > limits.maxInputBytes) fail('INVALID_INPUT_SIZE')
  const encoding = options.encoding ?? (raw.length >= 4 && raw.readUInt32LE(0) === ZSTD_MAGIC ? 'zstd' : 'jsonl')
  if (encoding === 'jsonl') {
    if (raw.length > limits.maxDecodedBytes) fail('DECODED_SIZE_LIMIT')
    return { encoding, plaintext: raw, frames: [] }
  }
  if (encoding !== 'zstd') fail('UNSUPPORTED_ENCODING')
  const frames = scanZstdFrames(raw, limits)
  const chunks = []
  let size = 0
  for (const frame of frames) {
    let plaintext
    try {
      plaintext = zstdDecompressSync(raw.subarray(frame.start, frame.end), {
        maxOutputLength: Math.max(1, limits.maxDecodedBytes - size),
      })
    } catch { fail('ZSTD_DECODE_FAILED') }
    if (frame.contentSize !== undefined && plaintext.length !== frame.contentSize) fail('ZSTD_CONTENT_SIZE_MISMATCH')
    frame.plainStart = size
    size += plaintext.length
    frame.plainEnd = size
    if (size > limits.maxDecodedBytes) fail('DECODED_SIZE_LIMIT')
    chunks.push(plaintext)
  }
  return { encoding, plaintext: Buffer.concat(chunks, size), frames }
}

// Scan RFC 8259 JSON before parsing it. Reject duplicate keys (including escaped
// aliases), excessive depth and non-finite numbers, without exposing key/data text.
function strictObject(text, maxDepth) {
  let at = 0
  const whitespace = () => { while (at < text.length && /[\x20\t\r\n]/.test(text[at])) at++ }
  const string = () => {
    if (text[at] !== '"') fail('INVALID_JSON')
    const start = at++
    while (at < text.length) {
      const ch = text[at++]
      if (ch === '"') {
        try { return JSON.parse(text.slice(start, at)) } catch { fail('INVALID_JSON') }
      }
      if (ch.charCodeAt(0) < 32) fail('INVALID_JSON')
      if (ch === '\\') {
        const escaped = text[at++]
        if (escaped === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at, at + 4))) fail('INVALID_JSON')
          at += 4
        } else if (!escaped || !'"\\/bfnrt'.includes(escaped)) fail('INVALID_JSON')
      }
    }
    fail('INVALID_JSON')
  }
  const value = (depth) => {
    if (depth > maxDepth) fail('JSON_DEPTH_LIMIT')
    whitespace()
    const ch = text[at]
    if (ch === '"') { string(); return }
    if (ch === '{') {
      at++; whitespace()
      const keys = new Set()
      if (text[at] === '}') { at++; return }
      for (;;) {
        whitespace()
        const key = string()
        if (keys.has(key)) fail('DUPLICATE_JSON_KEY')
        keys.add(key)
        whitespace()
        if (text[at++] !== ':') fail('INVALID_JSON')
        value(depth + 1); whitespace()
        if (text[at] === '}') { at++; return }
        if (text[at++] !== ',') fail('INVALID_JSON')
      }
    }
    if (ch === '[') {
      at++; whitespace()
      if (text[at] === ']') { at++; return }
      for (;;) {
        value(depth + 1); whitespace()
        if (text[at] === ']') { at++; return }
        if (text[at++] !== ',') fail('INVALID_JSON')
      }
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, at)) { at += literal.length; return }
    }
    const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y
    number.lastIndex = at
    const match = number.exec(text)
    if (!match || !Number.isFinite(Number(match[0]))) fail('INVALID_JSON')
    at = number.lastIndex
  }
  value(0); whitespace()
  if (at !== text.length) fail('INVALID_JSON')
  let record
  try { record = JSON.parse(text) } catch { fail('INVALID_JSON') }
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('INVALID_RECORD')
  return { record, close: text.lastIndexOf('}') }
}
const own = (record, key) => Object.hasOwn(record, key)
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
const HEADER_KEYS = new Set(['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth', 'cwd', 'parentSession', 'origin', 'agentPreset'])
const EVENT_KEYS = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable'])
function validateHeader(header) {
  if (Object.keys(header).some(key => !HEADER_KEYS.has(key)) || header.type !== 'session'
    || header.version !== 4 || typeof header.id !== 'string' || !header.id
    || !nonnegative(header.createdAt) || typeof header.isSeeded !== 'boolean'
    || !nonnegative(header.delegationDepth)
    || (own(header, 'cwd') && (typeof header.cwd !== 'string' || !(isAbsolute(header.cwd) || win32.isAbsolute(header.cwd))))
    || (own(header, 'parentSession') && typeof header.parentSession !== 'string')
    || (own(header, 'origin') && header.origin !== 'subagent')
    || (own(header, 'agentPreset') && typeof header.agentPreset !== 'string')) fail('UNSUPPORTED_OR_INVALID_V4_HEADER')
}
function validateEnvelope(event, index) {
  if (Object.keys(event).some(key => !EVENT_KEYS.has(key)) || typeof event.type !== 'string'
    || !nonnegative(event.seq) || event.seq !== index || !Number.isSafeInteger(event.time)
    || !own(event, 'data') || (own(event, 'ignorable') && event.ignorable !== true)) fail('INVALID_EVENT_ENVELOPE')
}
function inspectPlaintext(plaintext, limits) {
  if (plaintext.length === 0 || plaintext[plaintext.length - 1] !== 10) fail('TORN_JSONL_TAIL')
  try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintext) } catch { fail('INVALID_UTF8') }
  const counts = Object.fromEntries(MAESTRO_METADATA_TYPES.map(type => [type, { marked: 0, alreadyMarked: 0 }]))
  const insertions = []
  let offset = 0
  let rows = 0
  let headerEnd = 0
  while (offset < plaintext.length) {
    const end = plaintext.indexOf(10, offset)
    if (end < 0) fail('TORN_JSONL_TAIL')
    if (end - offset > limits.maxLineBytes) fail('JSON_LINE_SIZE_LIMIT')
    const line = plaintext.subarray(offset, end).toString('utf8')
    const { record, close } = strictObject(line, limits.maxJsonDepth)
    if (rows === 0) { validateHeader(record); headerEnd = end + 1 }
    else {
      validateEnvelope(record, rows - 1)
      if (TARGETS.has(record.type)) {
        if (record.ignorable === true) counts[record.type].alreadyMarked++
        else {
          counts[record.type].marked++
          insertions.push(offset + Buffer.byteLength(line.slice(0, close)))
        }
      }
    }
    rows++
    offset = end + 1
  }
  return { counts, insertions, eventCount: rows - 1, headerEnd }
}
function insertMarkers(bytes, positions) {
  if (positions.length === 0) return bytes
  const chunks = []
  let offset = 0
  for (const at of positions) {
    if (at < offset || at >= bytes.length || bytes[at] !== 125) fail('UNSAFE_INSERTION')
    chunks.push(bytes.subarray(offset, at), MARKER)
    offset = at
  }
  chunks.push(bytes.subarray(offset))
  return Buffer.concat(chunks)
}

/** Return replacement bytes and non-sensitive statistics; never print/log its byte buffers. */
export function repairSessionLogBytes(raw, options = {}) {
  const limits = limitsOf(options)
  const decoded = decodeSessionLog(raw, options)
  const inspected = inspectPlaintext(decoded.plaintext, limits)
  if (decoded.encoding === 'zstd' && decoded.frames[0].plainEnd !== inspected.headerEnd) fail('INVALID_ZSTD_HEADER_FRAME')
  const changed = inspected.insertions.length
  let bytes = raw
  if (changed) {
    const expectedPlaintext = insertMarkers(decoded.plaintext, inspected.insertions)
    if (expectedPlaintext.length > limits.maxDecodedBytes) fail('DECODED_SIZE_LIMIT')
    if (decoded.encoding === 'jsonl') bytes = expectedPlaintext
    else {
      const chunks = []
      let next = 0
      for (const frame of decoded.frames) {
        const positions = []
        while (next < inspected.insertions.length && inspected.insertions[next] < frame.plainEnd) {
          positions.push(inspected.insertions[next++] - frame.plainStart)
        }
        if (!positions.length) chunks.push(raw.subarray(frame.start, frame.end))
        else {
          const updated = insertMarkers(decoded.plaintext.subarray(frame.plainStart, frame.plainEnd), positions)
          try { chunks.push(zstdCompressSync(updated)) } catch { fail('ZSTD_ENCODE_FAILED') }
        }
      }
      if (next !== inspected.insertions.length) fail('UNSAFE_INSERTION')
      bytes = Buffer.concat(chunks)
    }
    const checked = decodeSessionLog(bytes, { ...options, encoding: decoded.encoding })
    if (!checked.plaintext.equals(expectedPlaintext)) fail('REENCODE_VERIFICATION_FAILED')
    const verification = inspectPlaintext(checked.plaintext, limits)
    if (verification.insertions.length !== 0 || verification.eventCount !== inspected.eventCount
      || !checked.plaintext.subarray(0, verification.headerEnd).equals(decoded.plaintext.subarray(0, inspected.headerEnd))) fail('REPAIR_VERIFICATION_FAILED')
  }
  return {
    bytes,
    stats: {
      encoding: decoded.encoding,
      inputBytes: raw.length,
      outputBytes: bytes.length,
      frameCount: decoded.frames.length,
      eventCount: inspected.eventCount,
      changed,
      untouchedEventCount: inspected.eventCount - changed,
      targets: inspected.counts,
      headerSha256: sha256(decoded.plaintext.subarray(0, inspected.headerEnd)),
      originalSha256: sha256(raw),
      resultSha256: sha256(bytes),
    },
  }
}
