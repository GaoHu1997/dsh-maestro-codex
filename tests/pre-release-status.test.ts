import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../scripts/maestro-status.mjs'

const status = () => ({ enabled: true, tasks: { working: 0, 'working/queued': 0, 'person/answer': 0, 'person/review': 0, 'person/blocked': 0, 'person/failed': 0, idle: 0 }, needsPerson: 0, problems: [], pendingEffects: 0 })
const response = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body })

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => { vi.restoreAllMocks() })

describe('status HTTP 200 is not sufficient evidence of health', () => {
  it.each([
    {}, [], { problems: 'bad-shape' }, null,
    { ...status(), tasks: [] },
    { ...status(), tasks: { ...status().tasks, working: -1 } },
    { ...status(), tasks: { ...status().tasks, working: '1' } },
    { ...status(), tasks: { ...status().tasks, working: 1.5 } },
    { ...status(), needsPerson: -1 },
    { ...status(), pendingEffects: null },
    { ...status(), enabled: 'true' },
    { ...status(), problems: [null] },
    { ...status(), problems: [{ name: 'bridge', level: 'not-a-level' }] },
    { ...status(), problems: [{ name: 123, level: 'error' }] },
    { ...status(), problems: [{ name: 'bridge', level: 'error', message: { private: 'SYNTHETIC_ONLY' } }] },
    { ...status(), tasks: {} },
    { ...status(), tasks: { ...status().tasks, 'person/review': undefined } },
    { ...status(), tasks: { ...status().tasks, idle: Number.MAX_SAFE_INTEGER + 1 } },
  ].map(body => ({ body })))('rejects malformed status $body with a friendly read failure', async ({ body }) => {
    await expect(main([], response(body))).resolves.toBe(1)
    expect(process.stdout.write).not.toHaveBeenCalled()
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('状态响应结构无效'))
    expect(process.stderr.write).not.toHaveBeenCalledWith(expect.stringContaining('SYNTHETIC_ONLY'))
  })

  it('validates JSON mode too, instead of printing a malformed success payload', async () => {
    await expect(main(['--json'], response({}))).resolves.toBe(1)
    expect(process.stdout.write).not.toHaveBeenCalled()
  })

  it('keeps the valid healthy response exit code and human output', async () => {
    await expect(main([], response(status()))).resolves.toBe(0)
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('健康：正常'))
  })

  it.each(['error', 'degraded'])('keeps actionable %s health as exit 2', async level => {
    const body = { ...status(), problems: [{ name: 'bridge', level, message: 'synthetic unavailable bridge' }] }
    await expect(main([], response(body))).resolves.toBe(2)
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('健康：1 条问题'))
  })

  it('keeps a valid disabled-plugin status readable in JSON mode', async () => {
    const body = { ...status(), enabled: false }
    await expect(main(['--json'], response(body))).resolves.toBe(0)
    expect(process.stdout.write).toHaveBeenCalledWith(`${JSON.stringify(body, undefined, 2)}\n`)
  })
})
