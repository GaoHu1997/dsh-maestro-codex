import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  root: fileURLToPath(new URL('../', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../release-tests/20261101-plugin-only/.vite-native-recovery-cache', import.meta.url)),
  test: { environment: 'node', maxWorkers: 1, include: ['tests/cli-record-projection.test.ts', 'tests/native-recovery.test.ts'] },
})
