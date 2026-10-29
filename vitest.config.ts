import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 客户端组件按 tsconfig.client.json 的 `jsx: react-jsx` 编译，但根 tsconfig
  // 不带 jsx 字段，esbuild 会退回 classic 转换并去找 React 全局。单测里显式
  // 指定 automatic，和真实打包行为保持一致。
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
