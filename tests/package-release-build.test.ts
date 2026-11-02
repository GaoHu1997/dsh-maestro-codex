import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { build } from 'tsdown'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import * as primitives from './upstream-fixtures/host-ui-primitives.js'
import { styleDocument } from './upstream-fixtures/style-document.js'
import { upstreamCssFiles } from '../scripts/build-upstream-css.mjs'
import clientConfig from '../tsdown.config.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
let fixture: string | undefined
let library: string

beforeAll(async () => {
  fixture = mkdtempSync(join(root, 'tests', '.package-release-dts-build-'))
  const packageRoot = join(fixture, 'node_modules', pkg.name)
  library = join(packageRoot, 'lib')
  mkdirSync(library, { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify(pkg))
  writeFileSync(join(fixture, 'package.json'), '{"type":"module"}\n')
  // Only output location changes: build the actual production client entry,
  // including real TypeScript declarations, CSS, CJS loader and source map.
  await build({ ...clientConfig, config: false, outDir: library, report: false })
}, 60_000)

afterAll(() => {
  if (fixture === undefined) return
  const rest = relative(join(root, 'tests'), fixture)
  if (isAbsolute(rest) || !rest.startsWith('.package-release-dts-build-') || rest.includes(sep)
    || lstatSync(fixture).isSymbolicLink()
    || realpathSync.native(fixture).toLowerCase() !== fixture.toLowerCase()) {
    throw new Error(`Unsafe declaration fixture cleanup: ${fixture}`)
  }
  rmSync(fixture, { recursive: true, force: false })
})

describe('real packaged client declaration build', () => {
  it('keeps runtime helpers and resolves the generated CJS API in a strict NodeNext consumer', () => {
    expect(readdirSync(library).sort()).toEqual(['client.d.cts', 'client.js', 'client.js.map'])
    const declaration = readFileSync(join(library, 'client.d.cts'), 'utf8')
    expect(declaration).not.toContain('window.__ModuleLoader__')
    expect(declaration).not.toContain('var module =')
    expect(declaration).toContain('"resolution-mode": "import"')
    const ast = ts.createSourceFile('client.d.cts', declaration, ts.ScriptTarget.Latest, true)
    const relativeImports = ast.statements.filter(ts.isImportDeclaration)
      .filter(node => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('.'))
    expect(relativeImports.map(node => node.getText(ast))).toEqual([])

    const host = styleDocument()
    let registration: { id: string; factory: (require: (name: string) => unknown) => Record<string, unknown> } | undefined
    vm.runInNewContext(readFileSync(join(library, 'client.js'), 'utf8'), {
      document: host.document, performance, setTimeout, clearTimeout,
      window: { __ModuleLoader__: { load(entry: typeof registration) { registration = entry } } },
    })
    expect(registration?.id).toBe(pkg.name)
    expect(typeof registration?.factory).toBe('function')
    const exports = registration!.factory(name => {
      if (name === 'react') return React
      if (name === 'react/jsx-runtime') return jsxRuntime
      if (name === 'react-dom') return ReactDOM
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
      throw new Error(`Unexpected client factory import: ${name}`)
    })
    expect(Object.keys(exports).sort()).toEqual(['PLUGIN_ENTRY_ID', 'PLUGIN_PACKAGE', 'apply', 'inject', 'name'])
    expect(exports.PLUGIN_ENTRY_ID).toBe(pkg.name)
    expect(exports.PLUGIN_PACKAGE).toBe(pkg.name)
    expect(exports.name).toBe(pkg.name)
    expect(exports.inject).toEqual(['slots', 'configForms'])
    expect(typeof exports.apply).toBe('function')
    // Production explicitly imports all CSS modules, including SubagentView;
    // the narrower upstream renderer fixture intentionally reaches only four.
    const upstreamStyles = [...host.styles.values()].filter(style => style.attributes['data-dsh-maestro-upstream'] === '0.28.2')
    expect(upstreamStyles.map(style => style.id).sort()).toEqual(upstreamCssFiles.map(filename => `dsh-maestro-upstream-${filename.replaceAll('.', '-')}`).sort())
    for (const style of upstreamStyles) expect(style.textContent).toContain('--dsw-')

    const consumer = join(fixture!, 'consumer.mts')
    writeFileSync(consumer, `import * as client from 'dsh-maestro-codex/client';
const entry: 'dsh-maestro-codex' = client.PLUGIN_ENTRY_ID;
const packageName: 'dsh-maestro-codex' = client.PLUGIN_PACKAGE;
const name: 'dsh-maestro-codex' = client.name;
const slots: string[] = client.inject;
const apply: (ctx: Parameters<typeof client.apply>[0]) => void = client.apply;
type IsAny<T> = 0 extends (1 & T) ? true : false;
const contextIsNotAny: IsAny<Parameters<typeof client.apply>[0]> = false;
// @ts-expect-error The real Cordis-based context cannot be a string or an any stub.
client.apply('not a context');
`)
    const program = ts.createProgram([consumer], {
      target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true,
      skipLibCheck: false, noEmit: true, types: [],
    })
    const errors = ts.getPreEmitDiagnostics(program)
    expect(errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n'))).toEqual([])
  }, 30_000)
})
