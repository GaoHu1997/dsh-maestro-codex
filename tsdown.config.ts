import { createRequire } from 'node:module'
import { defineConfig } from 'tsdown'

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

export default defineConfig({
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  // The browser bundle lands beside the tsc host output in lib/; clean must
  // stay off or tsdown would wipe the host half.
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  clean: false,
  sourcemap: true,
  external: [...CLIENT_EXTERNALS],
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
