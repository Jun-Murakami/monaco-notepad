import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      all: true,
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/test/**/*',
        'src/types/**/*',
        'src/lib/monaco.ts',  // Monaco Editorの設定ファイルを除外
      ],
    },
    deps: {
      optimizer: {
        web: {
          include: ['@mui/*'],  // MUIコンポーネントの最適化を含める（文字列形式で指定）
        }
      },
      interopDefault: true
    },
    setupFiles: ['./src/test/setup.ts']
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'monaco-editor': path.resolve(__dirname, './node_modules/monaco-editor/esm/vs/editor/editor.api.js'),
    },
  },
}); 