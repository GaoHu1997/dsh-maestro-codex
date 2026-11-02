import { describe, expect, it } from 'vitest'
import { RESULT_ACTION_CAP, RESULT_MARKER, RESULT_SCAN_LINES, RESULT_SUMMARY_CAP, parseResultLine } from '../src/result-protocol.js'

const line = (payload: string): string => `${RESULT_MARKER} ${payload}`

describe('parseResultLine', () => {
  it('reads the protocol line at the end of the output', () => {
    const text = ['先看了仓库，改了三处。', line('{"state":"ready","summary":"改完三处"}')].join('\n')
    expect(parseResultLine(text)).toEqual({ state: 'ready', summary: '改完三处', source: 'protocol' })
  })

  it('keeps human_action only when it carries text', () => {
    expect(parseResultLine(line('{"state":"blocked","human_action":"确认线上库能否直连","summary":"卡在权限"}'))).toEqual({
      state: 'blocked',
      humanAction: '确认线上库能否直连',
      summary: '卡在权限',
      source: 'protocol',
    })
    expect(parseResultLine(line('{"state":"ready","human_action":"   "}'))).toEqual({ state: 'ready', source: 'protocol' })
  })

  it('returns undefined when there is no protocol line — never guesses from prose', () => {
    expect(parseResultLine(undefined)).toBeUndefined()
    expect(parseResultLine('')).toBeUndefined()
    expect(parseResultLine('我卡住了，需要你确认一下线上库。')).toBeUndefined()
  })

  it('rejects a line whose state is outside the enum', () => {
    expect(parseResultLine(line('{"state":"done"'))).toBeUndefined()
    expect(parseResultLine(line('{"state":"finished"}'))).toBeUndefined()
    expect(parseResultLine(line('{"summary":"没有 state"}'))).toBeUndefined()
  })

  it('rejects broken JSON and keeps looking further up', () => {
    const text = [
      line('{"state":"waiting","human_action":"先确认数据库"}'),
      '中间是正常输出',
      line('{ 这不是 json'),
    ].join('\n')
    expect(parseResultLine(text)?.humanAction).toBe('先确认数据库')
  })

  it('ignores a protocol line that sits above the scan window', () => {
    const filler = Array.from({ length: RESULT_SCAN_LINES + 5 }, () => '普通日志一行')
    const text = [line('{"state":"ready"}'), ...filler].join('\n')
    expect(parseResultLine(text)).toBeUndefined()
  })

  it('clips long fields to one flattened line', () => {
    const long = '第一行\n第二行'.repeat(200)
    const parsed = parseResultLine(line(JSON.stringify({ state: 'ready', summary: long, human_action: long })))
    expect(parsed?.summary?.includes('\n')).toBe(false)
    expect(parsed?.summary?.length).toBeLessThanOrEqual(RESULT_SUMMARY_CAP + 1)
    expect(parsed?.humanAction?.length).toBeLessThanOrEqual(RESULT_ACTION_CAP + 1)
  })

  it('tolerates surrounding whitespace and a leading blank line', () => {
    expect(parseResultLine(`\n\n   ${line('{"state":"progress"}')}   \n`)).toEqual({ state: 'progress', source: 'protocol' })
  })
})
