import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('monaco-editor/esm/vs/editor/editor.worker') ||
            id.includes('monaco-editor/esm/vs/language/typescript/ts.worker')
          ) {
            return 'monaco-workers';
          }
          if (id.includes('monaco-editor')) {
            return 'monaco-editor';
          }
          if (id.includes('@mui/x-data-grid')) {
            return 'mui-data-grid';
          }
          if (id.includes('mermaid')) {
            return 'mermaid';
          }
          if (
            id.includes('react-markdown') ||
            id.includes('rehype') ||
            id.includes('remark')
          ) {
            return 'markdown';
          }
        },
      },
    },
  },
  optimizeDeps: {
    include: [
      'monaco-editor',
      'monaco-editor/esm/vs/editor/editor.worker',
      'monaco-editor/esm/vs/language/typescript/ts.worker',
    ],
    exclude: ['fsevents'],
  },
  server: {
    fs: {
      strict: true,
      allow: ['..'],
    },
    hmr: {
      host: 'localhost',
    },
  },
});
