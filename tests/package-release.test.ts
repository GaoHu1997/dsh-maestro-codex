import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { UserConfig } from 'tsdown'
import clientConfig, { cjsDeclarationTypeImports, excludeDtsVirtualModules } from '../tsdown.config.js'
import { cleanBuildOutputs } from '../scripts/clean-build.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = clientConfig as UserConfig
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const fixtures: string[] = []
function fixture() {
  const path = mkdtempSync(join(root, 'tests', '.package-release-clean-'))
  fixtures.push(path)
  return path
}

afterEach(() => {
  for (const path of fixtures.splice(0)) {
    const rest = relative(join(root, 'tests'), path)
    if (isAbsolute(rest) || !rest.startsWith('.package-release-clean-') || /[\\/]/.test(rest)) {
      throw new Error(`Unsafe fixture cleanup: ${path}`)
    }
    if (lstatSync(path).isSymbolicLink() || realpathSync.native(path).toLowerCase() !== path.toLowerCase()) {
      throw new Error(`Redirected fixture cleanup: ${path}`)
    }
    rmSync(path, { recursive: true, force: false })
  }
})

describe('release export and build configuration', () => {
  it('keeps the host contract and connects client types to the real CJS entry', async () => {
    expect(pkg.main).toBe('lib/index.js')
    expect(pkg.types).toBe('lib/index.d.ts')
    expect(pkg.exports['.']).toEqual({ types: './lib/index.d.ts', default: './lib/index.js' })
    expect(pkg.exports['./client']).toEqual({ types: './lib/client.d.cts', default: './lib/client.js' })
    expect(config.entry).toEqual({ client: 'src/client/index.ts' })
    expect(config.format).toBe('cjs')
    expect(config.platform).toBe('browser')
    expect(config.dts).toEqual({ tsconfig: 'tsconfig.client-declarations.json', cjsDefault: false })
    if (typeof config.outputOptions !== 'function') throw new Error('Expected separate JS/DTS output options')
    const declaration = await config.outputOptions({}, 'cjs', { cjsDts: true })
    expect(declaration).toMatchObject({ sourcemap: false })
    if (!declaration || typeof declaration.entryFileNames !== 'function') throw new Error('Expected generated declaration entry naming')
    expect(declaration.entryFileNames({ name: 'client.d' })).toBe('client.d.cts')
    expect(declaration.entryFileNames({ name: 'client' })).toBe('[name].dts-placeholder.js')
    if (typeof declaration.chunkFileNames !== 'function') throw new Error('Expected emitted declaration chunk naming')
    expect(declaration.chunkFileNames({ name: 'client.d' })).toBe('client.d.cts')
    expect(declaration && declaration.plugins).toHaveLength(1)
    expect(declaration && Object.hasOwn(declaration, 'banner')).toBe(false)
    expect(declaration && Object.hasOwn(declaration, 'intro')).toBe(false)
    expect(declaration && Object.hasOwn(declaration, 'footer')).toBe(false)
    const javascript = await config.outputOptions({}, 'cjs', { cjsDts: false })
    expect(javascript).toMatchObject({
      entryFileNames: 'client.js',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    })
    expect(javascript && javascript.banner).toContain('window.__ModuleLoader__.load')
    expect(javascript && javascript.banner).toContain(JSON.stringify(pkg.name))
  })

  it('uses an emitting client declaration config without changing host/typecheck settings', () => {
    const host = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'))
    const client = JSON.parse(readFileSync(join(root, 'tsconfig.client.json'), 'utf8'))
    const declarations = JSON.parse(readFileSync(join(root, 'tsconfig.client-declarations.json'), 'utf8'))
    expect(host.compilerOptions.outDir).toBe('lib')
    expect(host.exclude).toContain('src/client/**')
    expect(client.compilerOptions.noEmit).toBe(true)
    expect(declarations.extends).toBe('./tsconfig.client.json')
    expect(declarations.include).toEqual(['src/client/index.ts'])
    expect(declarations.compilerOptions).toMatchObject({
      noEmit: false, declaration: true, emitDeclarationOnly: true, noEmitOnError: true,
    })
    expect(pkg.scripts.build).toBe('node scripts/clean-build.mjs && tsc -p tsconfig.json && tsdown')
    expect(config.outDir).toBe('lib')
    expect(config.clean).toBe(false)
  })

  it.each(['import type', 'import'])('resolves generated CJS type dependencies on an ESM peer (%s)', syntax => {
    // Two-file compiler fixture only, not the project graph or a release stub.
    const path = fixture()
    const declarationPath = join(path, 'client.d.cts')
    writeFileSync(join(path, 'peer.d.mts'), 'export interface Context { id: string }\n')
    const code = `${syntax} { Context } from '@deepseek-ai/cordis';\nexport declare function apply(ctx: Context): void;\n`
    const options: ts.CompilerOptions = {
      module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16,
      target: ts.ScriptTarget.ES2022, strict: true, skipLibCheck: false, noEmit: true,
      types: [], baseUrl: path, paths: { '@deepseek-ai/cordis': ['./peer.d.mts'] },
    }
    writeFileSync(declarationPath, code)
    // Node16 forbids the ambiguous ESM type dependency; NodeNext in TS 5.9
    // supports require(ESM), so both modes are checked after the explicit fix.
    const before = ts.getPreEmitDiagnostics(ts.createProgram([declarationPath], options))
    expect(before.some(diagnostic => diagnostic.code === 1541 || diagnostic.code === 1479)).toBe(true)
    const transformed = cjsDeclarationTypeImports(code)
    expect(transformed).toContain('"resolution-mode": "import"')
    expect(transformed).toContain('import type { Context }')
    expect(transformed).toContain('apply(ctx: Context): void')
    writeFileSync(declarationPath, transformed)
    for (const mode of [ts.ModuleKind.Node16, ts.ModuleKind.NodeNext]) {
      const after = ts.getPreEmitDiagnostics(ts.createProgram([declarationPath], {
        ...options, module: mode,
        moduleResolution: mode === ts.ModuleKind.Node16 ? ts.ModuleResolutionKind.Node16 : ts.ModuleResolutionKind.NodeNext,
      }))
      expect(after.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
    }
  }, 15_000)

  it('migrates legacy define/inject before tsdown re-merges defaults and preserves transforms', async () => {
    if (typeof config.inputOptions !== 'function') throw new Error('Expected legacy define/inject adapter')
    const defaults = {
      input: 'virtual.ts',
      define: { 'process.env.NODE_ENV': '"production"', SHARED: '"legacy"' },
      inject: { LEGACY: 'old-module', SHARED: 'old-module' },
      transform: {
        target: 'es2022', define: { SHARED: '"current"', PRESENT: 'true' },
        inject: { SHARED: 'current-module', PRESENT: ['present-module', 'value'] as [string, string] },
      },
    }
    const result = await config.inputOptions(defaults, 'cjs', { cjsDts: false })
    const merged = { ...defaults, ...result }
    expect(Object.hasOwn(defaults, 'define')).toBe(false)
    expect(Object.hasOwn(merged, 'define')).toBe(false)
    expect(Object.hasOwn(defaults, 'inject')).toBe(false)
    expect(Object.hasOwn(merged, 'inject')).toBe(false)
    expect(merged.transform).toEqual({
      target: 'es2022',
      define: { 'process.env.NODE_ENV': '"production"', SHARED: '"current"', PRESENT: 'true' },
      inject: { LEGACY: 'old-module', SHARED: 'current-module', PRESENT: ['present-module', 'value'] },
    })
  })

  it('excludes virtual runtime modules from DTS generation without altering source transforms', async () => {
    const sourceHandler = () => 'export { }'
    const generate = {
      name: 'rolldown-plugin-dts:generate',
      transform: {
        order: 'pre' as const,
        filter: { id: { include: [/\.js$/, /\.ts$/], exclude: [/node_modules/] } },
        handler: sourceHandler,
      },
    }
    const unrelated = { name: 'other-plugin', transform: sourceHandler }
    const plugins = await excludeDtsVirtualModules([false, [Promise.resolve(generate), unrelated]])
    if (!Array.isArray(plugins) || !Array.isArray(plugins[1])) throw new Error('Expected nested plugin options')
    const guarded = plugins[1][0]
    expect(plugins[0]).toBe(false)
    expect(plugins[1][1]).toBe(unrelated)
    expect(guarded.transform.handler).toBe(sourceHandler)
    expect(guarded.transform.order).toBe('pre')
    expect(guarded.transform.filter.id.include).toEqual(generate.transform.filter.id.include)
    expect(guarded.transform.filter.id.exclude.some((pattern: RegExp) => pattern.test('\0rolldown/runtime.js'))).toBe(true)
    expect(guarded.transform.filter.id.exclude.some((pattern: RegExp) => pattern.test('/plugin/src/client/index.ts'))).toBe(false)
    expect(generate.transform.filter.id.exclude).toEqual([/node_modules/])
  })
})

describe('controlled build cleanup', () => {
  it('removes stale outputs before either build half while leaving source intact', () => {
    const path = fixture()
    mkdirSync(join(path, 'src'))
    mkdirSync(join(path, 'lib', 'nested'), { recursive: true })
    writeFileSync(join(path, 'src', 'keep.ts'), 'export const keep = true\n')
    writeFileSync(join(path, 'lib', 'job-mirror.js'), 'stale')
    writeFileSync(join(path, 'lib', 'job-mirror.d.ts'), 'stale')
    writeFileSync(join(path, 'lib', 'nested', 'old.js'), 'stale')
    expect(cleanBuildOutputs(path)).toEqual({ target: join(path, 'lib'), removed: true })
    expect(existsSync(join(path, 'lib'))).toBe(false)
    expect(readFileSync(join(path, 'src', 'keep.ts'), 'utf8')).toBe('export const keep = true\n')
    expect(cleanBuildOutputs(path).removed).toBe(false)
  })

  it('rejects relative/outside roots and CLI path arguments without touching live lib', () => {
    expect(() => cleanBuildOutputs('.')).toThrow('absolute')
    expect(() => cleanBuildOutputs(parse(root).root)).toThrow('outside the plugin')
    expect(() => cleanBuildOutputs(dirname(root))).toThrow(/^Build root is outside the plugin:/)
    expect(() => cleanBuildOutputs(resolve(root, '../not-this-plugin'))).toThrow(/^Build root is outside the plugin:/)
    expect(() => execFileSync(process.execPath, [join(root, 'scripts', 'clean-build.mjs'), '..'], {
      encoding: 'utf8', stdio: 'pipe',
    })).toThrow()
  })

  it('rejects a non-directory output before writing', () => {
    const path = fixture()
    writeFileSync(join(path, 'lib'), 'not output')
    expect(() => cleanBuildOutputs(path)).toThrow()
    expect(readFileSync(join(path, 'lib'), 'utf8')).toBe('not output')
  })

  it('rejects a linked output root without following a Windows junction', () => {
    const path = fixture()
    mkdirSync(join(path, 'protected'))
    writeFileSync(join(path, 'protected', 'keep'), 'untouched')
    symlinkSync(join(path, 'protected'), join(path, 'lib'), 'junction')
    expect(() => cleanBuildOutputs(path)).toThrow()
    expect(readFileSync(join(path, 'protected', 'keep'), 'utf8')).toBe('untouched')
  })

  it('validates every child before deleting anything', () => {
    const path = fixture()
    mkdirSync(join(path, 'protected'))
    mkdirSync(join(path, 'lib'))
    writeFileSync(join(path, 'protected', 'keep'), 'untouched')
    writeFileSync(join(path, 'lib', 'old.js'), 'stale')
    symlinkSync(join(path, 'protected'), join(path, 'lib', 'redirect'), 'junction')
    expect(() => cleanBuildOutputs(path)).toThrow()
    expect(readFileSync(join(path, 'protected', 'keep'), 'utf8')).toBe('untouched')
    expect(readFileSync(join(path, 'lib', 'old.js'), 'utf8')).toBe('stale')
  })

  it('rejects a linked plugin-root component even when no lib exists', () => {
    const path = fixture()
    mkdirSync(join(path, 'protected'))
    symlinkSync(join(path, 'protected'), join(path, 'redirect'), 'junction')
    expect(() => cleanBuildOutputs(join(path, 'redirect'))).toThrow()
    expect(existsSync(join(path, 'protected'))).toBe(true)
  })
})

describe('release delivery whitelist', () => {
  it('ships advertised user docs and the self-contained status script, not historical/dev trees', () => {
    const added = [
      'docs/cli-safety.md', 'docs/task-board.md', 'docs/session-history-recovery-guide.md',
      'docs/reliability.md', 'scripts/maestro-status.mjs',
    ]
    expect(pkg.files).toEqual([
      'lib', '!lib/**/*.map', 'cordis.patch.yml', 'README.md', 'LICENSE', 'icon.svg',
      'locale/*.json', ...added, 'THIRD_PARTY_NOTICES',
    ])
    for (const path of added) {
      expect(pkg.files).toContain(path)
      expect(lstatSync(join(root, path)).isFile()).toBe(true)
    }
    expect(pkg.files).not.toContain('docs')
    expect(pkg.files).not.toContain('scripts')
    expect(pkg.files).not.toContain('release-tests')
    expect(pkg.files).not.toContain('src')
    expect(pkg.files).not.toContain('docs/session-history-recovery.md')
    expect(pkg.files).toContain('!lib/**/*.map')
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    expect(readme).toContain('docs/session-history-recovery-guide.md')
    expect(readme).not.toContain('](<docs/session-history-recovery.md>)')
  })

  it('confirms status has no local/package imports or require dependencies', () => {
    const source = readFileSync(join(root, 'scripts', 'maestro-status.mjs'), 'utf8')
    const ast = ts.createSourceFile('maestro-status.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const dependencies: string[] = []
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)
        || (ts.isExportDeclaration(node) && node.moduleSpecifier)) dependencies.push(node.getText(ast))
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) dependencies.push(node.getText(ast))
      ts.forEachChild(node, visit)
    }
    visit(ast)
    expect(dependencies).toEqual([])
    expect(source).toContain('fetch(')
    expect(source).toContain('AbortSignal.timeout(')
  })
})
