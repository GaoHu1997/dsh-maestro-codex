import { open, lstat, readFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'

// Read-only diagnostics. Never print event payloads or credentials.
const [mode, path, filter = 'session'] = process.argv.slice(2)
if (!path) throw new Error('Usage: node scripts/inspect-session-compat.mjs archive-list|archive-text|log path [filter]')
const stat = await lstat(path)
if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular file, not a link or directory')
if (mode === 'log') {
  const raw = await readFile(path)
  const text = zstdDecompressSync(raw, { maxOutputLength: 512 * 1024 * 1024 }).toString('utf8')
  const rows = text.trimEnd().split('\n').map(line => JSON.parse(line))
  const counts = {}, envelopes = [], maestro = []
  for (const row of rows) {
    const type = typeof row.type === 'string' ? row.type : '(no type)'
    counts[type] = (counts[type] ?? 0) + 1
    if (envelopes.length < 3) envelopes.push({ keys: Object.keys(row), type, seq: row.seq, version: row.version })
    if (type.startsWith('maestro/')) maestro.push({ type, seq: row.seq, ignorable: row.ignorable === true })
  }
  console.log(JSON.stringify({ compressedBytes: raw.length, decodedBytes: Buffer.byteLength(text), sha256: createHash('sha256').update(raw).digest('hex'), rows: rows.length, envelopes, counts, maestro }, null, 2))
} else if (mode === 'archive-list' || mode === 'archive-text') {
  // Read the ordinary ASAR file as an archive, never a virtual filesystem path.
  const file = await open(path, 'r')
  try {
    const prefix = Buffer.alloc(8)
    if ((await file.read(prefix, 0, 8, 0)).bytesRead !== 8) throw new Error('Short ASAR header')
    const size = prefix.readUInt32LE(4)
    if (size < 8 || size > 32 * 1024 * 1024) throw new Error('Invalid ASAR index size')
    const header = Buffer.alloc(size)
    if ((await file.read(header, 0, size, 8)).bytesRead !== size) throw new Error('Short ASAR index')
    const length = header.readUInt32LE(4)
    if (length > size - 8) throw new Error('Invalid ASAR index payload')
    const root = JSON.parse(header.subarray(8, 8 + length).toString('utf8'))
    const entries = []
    function walk(node, base = '') {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        if (name === '..' || name.includes('/') || name.includes('\\') || entry.link) continue
        const key = base ? `${base}/${name}` : name
        if (entry.files) walk(entry, key)
        else if (mode === 'archive-list' ? key.includes(filter) : key === filter) entries.push({ key, ...entry })
      }
    }
    walk(root)
    if (mode === 'archive-list') console.log(JSON.stringify(entries.map(({ key, size, unpacked }) => ({ key, size, unpacked })), null, 2))
    else {
      const entry = entries[0]
      if (entries.length !== 1 || !entry || entry.unpacked) throw new Error('Expected exactly one packed regular entry')
      const start = Number(entry.offset) + 8 + size
      if (!Number.isSafeInteger(start) || start < 8 + size || entry.size > 4 * 1024 * 1024 || start + entry.size > stat.size) throw new Error('Invalid or oversized entry')
      const content = Buffer.alloc(entry.size)
      if ((await file.read(content, 0, content.length, start)).bytesRead !== content.length) throw new Error('Short archive entry')
      console.log(content.toString('utf8'))
    }
  } finally { await file.close() }
} else throw new Error('Unknown read-only diagnostic mode')
