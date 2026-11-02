import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PROMPT_CAP, PROMPT_FRAGMENTS, PROMPTS_VERSION, PromptBook, baseOfDefault } from '../src/prompts.js'

function fileOf(): string {
  return join(mkdtempSync(join(tmpdir(), 'maestro-prompts-')), 'prompts.json')
}

describe('PromptBook', () => {
  it('starts from the shipped text with nothing marked as edited', () => {
    const book = new PromptBook()
    const entries = book.list()
    expect(entries.map(entry => entry.id)).toEqual(PROMPT_FRAGMENTS.map(fragment => fragment.id))
    expect(entries.every(entry => !entry.edited && !entry.stale)).toBe(true)
    expect(book.text('resultProtocol')).toBe(PROMPT_FRAGMENTS.find(fragment => fragment.id === 'resultProtocol')?.defaultText)
  })

  it('takes an override and keeps the base fingerprint it replaced', async () => {
    const file = fileOf()
    const book = new PromptBook({ file })
    await book.override('routingHint', '需要外部 CLI 时调用 dispatch_cli_task。')
    expect(book.text('routingHint')).toBe('需要外部 CLI 时调用 dispatch_cli_task。')
    const entry = book.list().find(item => item.id === 'routingHint')
    expect(entry?.edited).toBe(true)
    expect(entry?.stale).toBe(false)
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { version: number; overrides: Record<string, { base: string }> }
    expect(stored.version).toBe(PROMPTS_VERSION)
    expect(stored.overrides['routingHint']?.base).toBe(baseOfDefault('routingHint'))
  })

  it('flags a stale override after the shipped default moves on', async () => {
    const file = fileOf()
    writeFileSync(file, JSON.stringify({
      version: PROMPTS_VERSION,
      overrides: { replyPrefix: { text: '接着干。', base: 'deadbeefdeadbeef', at: 1 } },
    }), 'utf8')
    const book = new PromptBook({ file })
    await book.load()
    expect(book.list().find(item => item.id === 'replyPrefix')?.stale).toBe(true)
    expect(book.text('replyPrefix')).toBe('接着干。')
  })

  it('treats blank text as a reset back to the shipped default', async () => {
    const book = new PromptBook()
    await book.override('resultProtocol', '自定义')
    await book.override('resultProtocol', '   ')
    expect(book.list().find(item => item.id === 'resultProtocol')?.edited).toBe(false)
    expect(book.text('resultProtocol')).toBe(PROMPT_FRAGMENTS.find(fragment => fragment.id === 'resultProtocol')?.defaultText)
  })

  it('refuses text longer than the cap without changing state', async () => {
    const book = new PromptBook()
    await expect(book.override('resultProtocol', 'x'.repeat(PROMPT_CAP + 1))).rejects.toThrow(`不能超过 ${PROMPT_CAP} 字`)
    expect(book.list().find(item => item.id === 'resultProtocol')?.edited).toBe(false)
  })

  it('warns and falls back to shipped text on an unreadable file', async () => {
    const file = fileOf()
    writeFileSync(file, '{ nope', 'utf8')
    const onWarn = vi.fn()
    const book = new PromptBook({ file, onWarn })
    await book.load()
    expect(book.list().every(entry => !entry.edited)).toBe(true)
    expect(onWarn).toHaveBeenCalled()
  })
})

describe('shipped defaults', () => {
  it('ships the routing and reply fragments empty, so the generated hint stays single-source', () => {
    const book = new PromptBook()
    expect(book.text('routingHint')).toBe('')
    expect(book.text('replyPrefix')).toBe('')
    expect(book.text('resultProtocol')).toContain('MAESTRO_RESULT')
  })
})
