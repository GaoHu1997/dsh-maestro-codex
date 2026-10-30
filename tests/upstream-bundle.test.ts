import { createElement } from 'react'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { build } from 'tsdown'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import clientConfig from '../tsdown.config.js'
import * as primitives from './upstream-fixtures/host-ui-primitives.js'
import { styleDocument } from './upstream-fixtures/style-document.js'

let directory: string
let source: string
beforeAll(async () => {
  const temporaryRoot = path.resolve('.tmp')
  await mkdir(temporaryRoot, { recursive: true })
  directory = await mkdtemp(path.join(temporaryRoot, 'upstream-bundle-'))
  await build({
    ...clientConfig,
    config: false,
    entry: { upstream: 'src/client/board/upstream/index.ts' },
    outDir: directory,
    tsconfig: 'tsconfig.client.json',
    sourcemap: false,
    silent: true,
    report: false,
  })
  source = await readFile(path.join(directory, 'client.js'), 'utf8')
}, 30000)
afterAll(async () => {
  if (directory === undefined) return
  const target = path.resolve(directory)
  const expectedRoot = `${path.resolve('.tmp')}${path.sep}upstream-bundle-`
  if (!target.startsWith(expectedRoot)) throw new Error(`Unexpected temporary bundle directory: ${target}`)
  await rm(target, { recursive: true, force: true })
})

describe('tsdown 0.14 host factory', () => {
  it('embeds the CSS in client.js and exports the original renderers using host React', async () => {
    const host = styleDocument()
    const imports = new Set<string>()
    let factory: ((require: (name: string) => unknown) => Record<string, unknown>) | undefined
    let id: string | undefined
    const context = vm.createContext({
      document: host.document,
      window: { __ModuleLoader__: { load(entry: { id: string; factory: typeof factory }) { id = entry.id; factory = entry.factory } } },
      performance,
      setTimeout,
      clearTimeout,
    })
    vm.runInContext(source, context)
    expect(id).toBe('dsh-maestro-codex')
    const requireHost = (name: string): unknown => {
      imports.add(name)
      if (name === 'react') return React
      if (name === 'react/jsx-runtime') return jsxRuntime
      if (name === 'react-dom') return ReactDOM
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
      throw new Error(`Unexpected bundled dependency: ${name}`)
    }
    const exports = factory!(requireHost)
    for (const name of ['TasksGraph', 'TasksTree', 'AnchoredPopover', 'AgentNodePopover', 'WorkflowNodePopover', 'JobsDrawer', 'JobOutputWindow', 'buildTasksModel']) expect(typeof exports[name], name).toBe('function')
    expect(imports).toContain('react')
    expect(imports).toContain('react/jsx-runtime')
    expect(imports).toContain('@deepseek-ai/dsh-client-ui-primitives')
    expect(source).not.toContain('react.development.js')
    expect(source).not.toContain('ReactCurrentDispatcher')
    expect(host.styles.size).toBe(4)
    for (const style of host.styles.values()) expect(style.textContent).toContain('--dsw-')
    factory!(requireHost)
    expect(host.styles.size).toBe(4)
    expect(await readdir(directory)).toEqual(['client.js'])
    const component = exports['TasksGraph'] as typeof import('../src/client/board/upstream/index.js').TasksGraph
    expect(renderToStaticMarkup(createElement(component, {
      nodes: [{ kind: 'agent', id: 'root', label: '共享宿主 React', state: 'running', activity: 'running', current: true, depth: 0 }],
      rootId: 'root', folded: true, mode: 'graph', onNodeInfo() {}, onWorkflowInfo() {}, onOpenTask() {},
      onToggleFold() {}, onExpandGroup() {}, onFoldNode() {}, onModeChange() {},
    }))).toContain('共享宿主 React')
  })
})
