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
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
