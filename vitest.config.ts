import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { upstreamCssPlugin } from './scripts/build-upstream-css.mjs'

export default defineConfig({
  plugins: [upstreamCssPlugin({ injectIntoEntry: false })],
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./tests/upstream-fixtures/host-ui-primitives.tsx', import.meta.url)),
    },
  },
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  test: {
    environment: 'node',
    // Real Node/PowerShell/Git Bash launches contend for the same host resources.
    // Bound concurrency, not the default timeout of ordinary unit tests.
    maxWorkers: 2,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
})
