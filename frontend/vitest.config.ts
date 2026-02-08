import { defineConfig, type Plugin } from 'vitest/config';
import path from 'node:path';

// Vite plugin to handle ?worker imports in test environment
function workerImportPlugin(): Plugin {
  return {
    name: 'mock-worker-imports',
    enforce: 'pre',
    resolveId(id) {
      if (id.endsWith('?worker')) {
        return `\0mock-worker:${id}`;
      }
    },
    load(id) {
      if (id.startsWith('\0mock-worker:')) {
        return 'export default class MockWorker { postMessage() {} terminate() {} }';
      }
    },
  };
}

export default defineConfig({
  plugins: [workerImportPlugin()],
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
        'src/lib/monaco.ts',
      ],
    },
    deps: {
      optimizer: {
        web: {
          include: ['@mui/*'],
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