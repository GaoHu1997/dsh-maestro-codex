import { readFileSync } from 'node:fs'
import postcss, { type ChildNode } from 'postcss'
import { afterEach, describe, expect, it, vi } from 'vitest'
import graphCss, { stylesheetText as graphText } from '../src/client/board/upstream/client/tasks-graph.module.css.ts'
import canvasCss, { stylesheetText as canvasText } from '../src/client/board/upstream/client/tasks-canvas.module.css.ts'
import windowCss, { stylesheetText as windowText } from '../src/client/board/upstream/client/FloatingWindow.module.css.ts'
import diagnosticCss, { stylesheetText as diagnosticText } from '../src/client/board/upstream/client/context-diagnostics.module.css.ts'
import headerCss, { stylesheetText as headerText } from '../src/client/board/upstream/client/SubagentView.module.css.ts'
import { injectUpstreamStylesheet } from '../src/client/board/upstream/style-runtime.js'
import { styleDocument } from './upstream-fixtures/style-document.js'

const root = new URL('../src/client/board/upstream/client/', import.meta.url)
const cases = [
  { filename: 'tasks-graph.module.css', classes: graphCss, text: graphText },
  { filename: 'tasks-canvas.module.css', classes: canvasCss, text: canvasText },
  { filename: 'FloatingWindow.module.css', classes: windowCss, text: windowText },
  { filename: 'context-diagnostics.module.css', classes: diagnosticCss, text: diagnosticText },
  { filename: 'SubagentView.module.css', classes: headerCss, text: headerText },
]
const spaces = (value: string) => value.replace(/\s+/g, ' ').trim().replace(/\(\s+/g, '(').replace(/\s+\)/g, ')')
function rules(text: string, mapping: Record<string, string> = {}) {
  function visit(node: ChildNode): unknown {
    if (node.type === 'comment') return undefined
    if (node.type === 'decl') return {
      type: node.type, property: node.prop, important: node.important === true,
      value: spaces(node.prop.startsWith('animation')
        ? node.value.replace(/[a-z_-][\w-]*/gi, word => mapping[word] ?? word)
        : node.value === "''" ? '""' : node.value),
    }
    if (node.type === 'rule') return {
      type: node.type,
      selector: spaces(node.selector.replace(/\.[a-z_-][\w-]*/gi, name => `.${mapping[name.slice(1)] ?? name.slice(1)}`))
        .replace(/(\[[\w-]+[~^$*|]?=)["']([a-z_][\w-]*)["'](\])/gi, '$1$2$3')
        .replace(/^from$/, '0%').replace(/^to$/, '100%'),
      nodes: node.nodes.map(visit).filter(value => value !== undefined),
    }
    if (node.type === 'atrule') return {
      type: node.type, name: node.name,
      params: spaces(node.name.endsWith('keyframes') ? mapping[node.params] ?? node.params : node.params),
      nodes: node.nodes?.map(visit).filter(value => value !== undefined),
    }
    throw new Error(`Unexpected CSS node: ${node.type}`)
  }
  return postcss.parse(text).nodes.map(visit).filter(value => value !== undefined)
}
function tokens(text: string): string[] {
  const found = new Set<string>()
  postcss.parse(text).walkDecls(declaration => {
    for (const match of declaration.value.matchAll(/--dsw-[\w-]+/g)) found.add(match[0])
  })
  return [...found].sort()
}

afterEach(() => { vi.unstubAllGlobals() })

describe('compiled upstream CSS Modules', () => {
  for (const test of cases) it(`retains all selectors, declarations, keyframes and tokens: ${test.filename}`, () => {
    const original = readFileSync(new URL(test.filename, root), 'utf8')
    expect(rules(test.text)).toEqual(rules(original, test.classes))
    expect(tokens(test.text)).toEqual(tokens(original))
  })

  it('maps every class referenced by the original graph, tree and card sources', () => {
    for (const filename of ['TasksGraph.tsx', 'TasksTree.tsx', 'tasks-card.tsx', 'tasks-shared.tsx', 'TasksPopovers.tsx', 'JobsDrawer.tsx']) {
      const source = readFileSync(new URL(filename, root), 'utf8')
      for (const [, name] of source.matchAll(/\bcss\.(\w+)/g)) expect(graphCss[name!], `${filename}: ${name}`).toBeTruthy()
      for (const [, name] of source.matchAll(/\bcanvasCss\.(\w+)/g)) expect(canvasCss[name!], `${filename}: ${name}`).toBeTruthy()
    }
    expect(graphText).toContain(`@keyframes ${graphCss['dsh-card-in']}`)
    expect(graphText).toContain('prefers-reduced-motion')
  })

  it('installs inline CSS once and updates it when the host reloads the factory', () => {
    const host = styleDocument()
    vi.stubGlobal('document', host.document)
    injectUpstreamStylesheet('tasks', graphText)
    injectUpstreamStylesheet('tasks', graphText)
    expect(host.styles.size).toBe(1)
    expect(host.styles.get('tasks')?.attributes['data-dsh-maestro-upstream']).toBe('0.28.2')
    injectUpstreamStylesheet('tasks', canvasText)
    expect(host.styles.size).toBe(1)
    expect(host.styles.get('tasks')?.textContent).toBe(canvasText)
  })
})
