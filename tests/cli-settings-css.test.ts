import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const cardSource = readFileSync(new URL('../src/client/MaestroCard.tsx', import.meta.url), 'utf8')
const headerSource = readFileSync(new URL('../src/client/header/CliCatalogChip.tsx', import.meta.url), 'utf8')

function stylesheet(source: string, constant: string): string {
  const match = source.match(new RegExp(`const ${constant} = \u0060([\\s\\S]*?)\u0060`))
  if (match?.[1] === undefined) throw new Error(`Missing ${constant}`)
  return match[1].replaceAll('${BODY_FLAG}', 'data-maestro-cli-header')
}

const cardCss = postcss.parse(stylesheet(cardSource, 'CARD_CSS'))
const headerCss = postcss.parse(stylesheet(headerSource, 'HEADER_CSS'))

function classes(css: postcss.Root): Set<string> {
  const names = new Set<string>()
  css.walkRules(rule => {
    for (const match of rule.selector.matchAll(/\.([a-z][\w-]*)/gi)) names.add(match[1]!)
  })
  return names
}

function declarations(css: postcss.Root, selector: string): Record<string, string> {
  const values: Record<string, string> = {}
  css.walkRules(selector, rule => {
    rule.walkDecls(declaration => { values[declaration.prop] = declaration.value })
  })
  return values
}

describe('CLI settings and header style isolation', () => {
  it('uses disjoint class names for the globally injected styles', () => {
    const cardClasses = classes(cardCss)
    const headerClasses = classes(headerCss)
    expect([...cardClasses].filter(name => headerClasses.has(name))).toEqual([])
    expect(headerClasses.has('dmch-row')).toBe(true)
    expect([...headerClasses].every(name => name.startsWith('dmch-'))).toBe(true)
    expect(headerSource).toContain('className={`dmch-row')
    expect(headerSource).toContain('data-dmc-trigger=""')
    expect(headerSource).toContain(':not([data-dmc-trigger])')
  })

  it('stacks expanded settings below the full-width accordion header', () => {
    expect(declarations(cardCss, '.dmc-row')).toMatchObject({
      display: 'flex', 'flex-direction': 'column', 'align-items': 'stretch', 'min-width': '0',
    })
    expect(declarations(cardCss, '.dmc-rowbtn')).toMatchObject({ display: 'flex', width: '100%' })
    expect(declarations(cardCss, '.dmc-body')).toMatchObject({ display: 'flex', 'flex-direction': 'column' })
  })

  it('puts the dsh model picker and the thinking level on one row', () => {
    const pair = declarations(cardCss, '.dmc-pair')
    expect(pair).toMatchObject({ display: 'grid' })
    // More than one track, or the level would drop under the model again.
    expect(pair['grid-template-columns']).toContain('auto-fit')
    expect(pair['grid-template-columns']).toContain('minmax')
    // The model field spans the row only if it is `wide` — it must not be.
    expect(cardSource).toContain('<Field label="dsh 模型">')
    expect(cardSource).not.toMatch(/dsh 模型"[^>]*\bwide\b/)
    // Both are children of the same pair grid, so they share the row.
    expect(cardSource).toMatch(/className="dmc-pair">\s*<DshModelSelect[\s\S]{0,600}?<SelectField\s+label="思考等级"/)
  })

  it('leaves no explanatory text under the model and thinking-level selects', () => {
    // Each picker keeps only its label: no per-field hint, and no group hint
    // under the pair. The docs (README) carry the detail instead.
    expect(cardSource).not.toContain('从 dsh 已配置的供应商/模型里选')
    expect(cardSource).not.toContain('仅列出 Anthropic 兼容')
    expect(cardSource).not.toContain('MAX_THINKING_TOKENS 传给 claude')
  })

  it('keeps the header menu rows and badges independent of the settings card', () => {
    expect(declarations(headerCss, '.dmch-row')).toMatchObject({ display: 'flex', 'align-items': 'flex-start' })
    expect(declarations(headerCss, '.dmch-badge')).toMatchObject({ 'font-size': '9.5px' })
    expect(declarations(cardCss, '.dmc-badge')).toMatchObject({ height: '16px', 'border-radius': '999px' })
  })
})
