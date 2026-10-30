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

  it('keeps the header menu rows and badges independent of the settings card', () => {
    expect(declarations(headerCss, '.dmch-row')).toMatchObject({ display: 'flex', 'align-items': 'flex-start' })
    expect(declarations(headerCss, '.dmch-badge')).toMatchObject({ 'font-size': '9.5px' })
    expect(declarations(cardCss, '.dmc-badge')).toMatchObject({ height: '16px', 'border-radius': '999px' })
  })
})
