import { vi } from 'vitest';

// monaco-editorのモックを設定
vi.mock('monaco-editor', () => ({
  default: {},
  languages: {
    getLanguages: () => [],
    typescript: {
      typescriptDefaults: {
        setEagerModelSync: () => { }
      }
    }
  },
  editor: {
    create: () => ({
      dispose: () => { },
      getModel: () => ({ isDisposed: () => false }),
      updateOptions: () => { }
    }),
    setTheme: () => Promise.resolve(),
    onDidCreateEditor: () => ({ dispose: () => { } })
  }
}));

// monaco-editorのワーカーモジュールをモック
vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({ default: {} }));
vi.mock('monaco-editor/esm/vs/language/json/json.worker?worker', () => ({ default: {} }));
vi.mock('monaco-editor/esm/vs/language/css/css.worker?worker', () => ({ default: {} }));
vi.mock('monaco-editor/esm/vs/language/html/html.worker?worker', () => ({ default: {} }));
vi.mock('monaco-editor/esm/vs/language/typescript/ts.worker?worker', () => ({ default: {} })); 