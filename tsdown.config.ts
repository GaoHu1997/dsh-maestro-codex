import { createRequire } from 'node:module'
import { defineConfig, type UserConfig } from 'tsdown'
import ts from 'typescript'
import { upstreamCssPlugin } from './scripts/build-upstream-css.mjs'

/**
 * Plugin id stamped into the loader handoff. Derived from package.json so the
 * bundle's registration id always equals the installed package name — the web
 * shell rejects a bundle whose `__ModuleLoader__.load` id differs from the
 * loader entry's package.
 */
const PLUGIN_ID: string = createRequire(import.meta.url)('./package.json').name

/**
 * Browser platform words shared by the shell's frozen module table: these stay
 * external so the factory's `require` resolves them from the table at runtime.
 */
const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

// The public ClientContext imports the ESM-only Cordis type. In .d.cts output,
// declare its ESM resolution explicitly so CJS/Node16 consumers do not hit
// TS1541. NodeNext in TS 5.9 also accepts this honest type-only dependency.
// Transform the generated declaration, never replace the source API with a stub.
export function cjsDeclarationTypeImports(code: string, fileName = 'client.d.cts'): string {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let changed = false
  const statements = source.statements.map(node => {
    if (!ts.isImportDeclaration(node) || !node.importClause
      || !ts.isStringLiteral(node.moduleSpecifier)
      || node.moduleSpecifier.text !== '@deepseek-ai/cordis') return node
    changed = true
    const attributes = node.attributes?.elements.filter(attribute => attribute.name.text !== 'resolution-mode') ?? []
    return ts.factory.updateImportDeclaration(node, node.modifiers,
      ts.factory.updateImportClause(node.importClause, true, node.importClause.name, node.importClause.namedBindings),
      node.moduleSpecifier, ts.factory.createImportAttributes([
        ...attributes,
        ts.factory.createImportAttribute(ts.factory.createStringLiteral('resolution-mode'), ts.factory.createStringLiteral('import')),
      ]))
  })
  if (!changed) return code
  return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(ts.factory.updateSourceFile(source, statements))
}

// rolldown-plugin-dts 0.15 also matches Rolldown's virtual runtime.js. Its
// emitDtsOnly transform replaces JS with an empty module, destroying helpers.
// Exclude only non-file virtual modules while keeping all original source filters.
export async function excludeDtsVirtualModules(plugins: UserConfig['plugins']): Promise<UserConfig['plugins']> {
  const plugin = await plugins
  if (Array.isArray(plugin)) return Promise.all(plugin.map(excludeDtsVirtualModules))
  if (!plugin || typeof plugin !== 'object' || plugin.name !== 'rolldown-plugin-dts:generate'
    || !('transform' in plugin)) return plugin
  const transform = plugin.transform
  const idFilter = transform && typeof transform === 'object' ? transform.filter?.id : undefined
  if (!transform || typeof transform !== 'object' || !idFilter || typeof idFilter !== 'object'
    || !('exclude' in idFilter) || !Array.isArray(idFilter.exclude)) {
    throw new Error('DTS generator needs a filtered transform hook for the Rolldown runtime guard')
  }
  return {
    ...plugin,
    transform: {
      ...transform,
      filter: { ...transform.filter, id: { ...idFilter, exclude: [...idFilter.exclude, /^\x00/] } },
    },
  }
}

const cjsDeclarationImportsPlugin: NonNullable<UserConfig['plugins']> = {
  name: 'maestro-client-cjs-type-imports',
  generateBundle(_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (output.type === 'chunk' && output.fileName.endsWith('.d.cts')) {
        output.code = cjsDeclarationTypeImports(output.code, output.fileName)
      }
    }
  },
}

export default defineConfig({
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  // The browser bundle lands beside the tsc host output in lib/; clean must
  // stay off or tsdown would wipe the host half.
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: { tsconfig: 'tsconfig.client-declarations.json', cjsDefault: false },
  clean: false,
  sourcemap: true,
  plugins: [upstreamCssPlugin()],
  external: [...CLIENT_EXTERNALS],
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  async inputOptions(options, _format, { cjsDts }) {
    // tsdown 0.14 supplies legacy define/inject at the top level. rolldown 1.x
    // requires transform.define/inject. Mutate defaults as tsdown re-merges them.
    const legacy = options as typeof options & {
      define?: Record<string, string>
      inject?: Record<string, string | [string, string]>
    }
    const { define, inject } = legacy
    delete legacy.define
    delete legacy.inject
    options.transform = {
      ...options.transform,
      define: { ...define, ...options.transform?.define },
      inject: { ...inject, ...options.transform?.inject },
    }
    if (cjsDts) options.plugins = await excludeDtsVirtualModules(options.plugins)
    return options
  },
  outputOptions(_options, _format, { cjsDts }) {
    // Declarations describe actual CJS exports, not executable loader scripts.
    if (cjsDts) return {
      // The generator emits a separate *.d entry and deletes the original JS
      // placeholder before writing. Its temporary name cannot overwrite client.js.
      entryFileNames: chunk => chunk.name.endsWith('.d') ? 'client.d.cts' : '[name].dts-placeholder.js',
      // Rolldown 1.x treats the emitted declaration as a secondary chunk.
      chunkFileNames: chunk => chunk.name === 'client.d' ? 'client.d.cts' : '[name]-[hash].d.cts',
      sourcemap: false,
      plugins: [cjsDeclarationImportsPlugin],
    }
    return {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    }
  },
})
