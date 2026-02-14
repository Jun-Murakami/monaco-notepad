import { vi } from 'vitest';
import { initI18n } from '../i18n';

initI18n('en');

const originalGetComputedStyle = window.getComputedStyle;
Object.defineProperty(window, 'getComputedStyle', {
  configurable: true,
  value: (element: Element, pseudo?: string | null) =>
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

// monaco-editorのワーカーモジュールをモック
vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({
  default: {},
}));
vi.mock('monaco-editor/esm/vs/language/json/json.worker?worker', () => ({
  default: {},
}));
vi.mock('monaco-editor/esm/vs/language/css/css.worker?worker', () => ({
  default: {},
}));
vi.mock('monaco-editor/esm/vs/language/html/html.worker?worker', () => ({
  default: {},
}));
vi.mock('monaco-editor/esm/vs/language/typescript/ts.worker?worker', () => ({
  default: {},
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
  getThemePair: (id: string) => ({
    id: 'default',
    label: 'Default',
    light: 'vs',
    dark: 'vs-dark',
  }),
  monaco: {},
}));
