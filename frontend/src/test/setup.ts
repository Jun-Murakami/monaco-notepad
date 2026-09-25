// jest-dom のマッチャー（toBeInTheDocument など）を Vitest の expect に登録し、型も拡張する
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';

import { initI18n } from '../i18n';
import { useCurrentNoteStore } from '../stores/useCurrentNoteStore';
import { useFileNotesStore } from '../stores/useFileNotesStore';
import { useNotesStore } from '../stores/useNotesStore';
import { useSplitEditorStore } from '../stores/useSplitEditorStore';

initI18n('en');

// Zustand のグローバルストアはテスト間で状態が漏れるので、毎テスト後に初期化する。
afterEach(() => {
  useCurrentNoteStore.getState().resetCurrentNote();
  useNotesStore.getState().reset();
  useFileNotesStore.getState().reset();
  useSplitEditorStore.getState().reset();
});

const originalGetComputedStyle = window.getComputedStyle;
Object.defineProperty(window, 'getComputedStyle', {
  configurable: true,
  value: (element: Element, _pseudo?: string | null) =>
    originalGetComputedStyle(element),
});

// monaco-editorのモックを設定
vi.mock('monaco-editor', () => ({
  default: {},
  languages: {
    getLanguages: () => [],
    typescript: {
      typescriptDefaults: {
        setEagerModelSync: () => {},
      },
    },
  },
  editor: {
    create: () => ({
      dispose: () => {},
      getModel: () => ({ isDisposed: () => false }),
      updateOptions: () => {},
    }),
    setTheme: () => Promise.resolve(),
    onDidCreateEditor: () => ({ dispose: () => {} }),
  },
}));

// Unicode Highlighter の副作用importをテスト環境で無効化
vi.mock('monaco-editor/features/unicodeHighlighter/register', () => ({}));

// monaco-editorのワーカーモジュールをモック
vi.mock('monaco-editor/editor/editor.worker?worker', () => ({
  default: {},
}));
vi.mock('monaco-editor/languages/features/json/json.worker?worker', () => ({
  default: {},
}));
vi.mock('monaco-editor/languages/features/css/css.worker?worker', () => ({
  default: {},
}));
vi.mock('monaco-editor/languages/features/html/html.worker?worker', () => ({
  default: {},
}));
vi.mock('monaco-editor/languages/features/typescript/ts.worker?worker', () => ({
  default: {},
}));
vi.mock('monaco-editor/languages/features/typescript/register', () => ({
  javascriptDefaults: {
    setDiagnosticsOptions: () => {},
  },
  typescriptDefaults: {
    setDiagnosticsOptions: () => {},
    setCompilerOptions: () => {},
    setEagerModelSync: () => {},
  },
  ScriptTarget: {
    Latest: 99,
  },
  ModuleResolutionKind: {
    NodeJs: 2,
  },
  ModuleKind: {
    CommonJS: 1,
  },
  JsxEmit: {
    React: 2,
  },
}));

// lib/monaco.ts のモック
vi.mock('../lib/monaco', () => ({
  getMonaco: () => ({
    editor: {
      create: () => ({
        dispose: () => {},
        getModel: () => ({ isDisposed: () => false }),
        updateOptions: () => {},
        setModel: () => {},
        getValue: () => '',
        setValue: () => {},
        onDidChangeModelContent: () => ({ dispose: () => {} }),
        addCommand: () => {},
        focus: () => {},
      }),
      setTheme: () => {},
      defineTheme: () => {},
      getModel: () => null,
      createModel: () => ({
        dispose: () => {},
        isDisposed: () => false,
      }),
      setModelLanguage: () => {},
    },
    languages: {
      getLanguages: () => [],
    },
    Uri: {
      parse: (uri: string) => ({ toString: () => uri }),
    },
  }),
  getOrCreateEditor: () => ({
    dispose: () => {},
    getModel: () => ({ isDisposed: () => false }),
    updateOptions: () => {},
    setModel: () => {},
    getValue: () => '',
    setValue: () => {},
    onDidChangeModelContent: () => ({ dispose: () => {} }),
    addCommand: () => {},
    focus: () => {},
  }),
  disposeEditor: () => {},
  getSupportedLanguages: () => [],
  getLanguageByExtension: () => null,
  getExtensionByLanguage: () => null,
  THEME_PAIRS: [
    { id: 'default', label: 'Default', light: 'vs', dark: 'vs-dark' },
    {
      id: 'github',
      label: 'GitHub',
      light: 'github-light',
      dark: 'github-dark',
    },
  ],
  getThemePair: (_id: string) => ({
    id: 'default',
    label: 'Default',
    light: 'vs',
    dark: 'vs-dark',
  }),
  monaco: {},
}));
