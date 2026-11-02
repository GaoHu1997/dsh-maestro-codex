import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- .mjs has no type declarations
import { renderStatus } from '../scripts/maestro-status.mjs'

const run = promisify(execFile)
const script = fileURLToPath(new URL('../scripts/maestro-status.mjs', import.meta.url))

describe('renderStatus', () => {
  it('summarises the counters a person actually reads', () => {
    const text = renderStatus({ tasks: { working: 2, 'working/queued': 1 }, needsPerson: 3, problems: [], pendingEffects: 0 })
    expect(text).toContain('2 个在跑')
    expect(text).toContain('1 个排队')
    expect(text).toContain('3 个在等人')
    expect(text).toContain('健康：正常')
    expect(text).not.toContain('未结清')
  })

  it('lists health problems and pending effect rows', () => {
    const text = renderStatus({
      tasks: {},
      needsPerson: 0,
      problems: [{ name: 'effects', level: 'error', message: '连续失败 3 次' }],
      pendingEffects: 2,
    })
    expect(text).toContain('健康：1 条问题')
    expect(text).toContain('effects（error）：连续失败 3 次')
    expect(text).toContain('未结清的副作用行：2')
  })
})

describe('maestro-status script', () => {
  it('prints usage for --help and exits clean', async () => {
    const { stdout } = await run(process.execPath, [script, '--help'])
    expect(stdout).toContain('maestro status')
    expect(stdout).toContain('--json')
  })

  it('exits 1 when the web server is not listening', async () => {
    await expect(run(process.execPath, [script, '--url', 'http://127.0.0.1:9'])).rejects.toMatchObject({ code: 1 })
  })
})
