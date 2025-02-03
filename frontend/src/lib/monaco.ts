import * as monaco from 'monaco-editor';

// シングルトンとしてのモジュール初期化
let _isInitialized = false;
let _monaco: typeof monaco | null = null;

// Monaco Editorの初期化
const initializeMonaco = () => {
  if (_isInitialized) {
    return;
  }

  // Web Workerの設定
  self.MonacoEnvironment = {
    getWorker(_: string, label: string) {
      if (label === 'typescript' || label === 'javascript') {
        return new Worker(
          new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url),
          { type: 'module' }
        );
      }
      return new Worker(
        new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
        { type: 'module' }
      );
    }
  };

  _monaco = monaco;
  _isInitialized = true;
};

// モナコエディタのインスタンスを取得
export const getMonaco = () => {
  if (!_isInitialized) {
    initializeMonaco();
  }
  return _monaco!;
};

// 言語情報の型定義
export interface LanguageInfo {
  id: string;
  extensions?: string[];
  aliases?: string[];
  mimetypes?: string[];
  filenames?: string[];
  firstLine?: string;
}

// 遅延初期化のためのシングルトン
let _supportedLanguages: LanguageInfo[] | null = null;

export const getSupportedLanguages = (): LanguageInfo[] => {
  if (!_supportedLanguages) {
    _supportedLanguages = getMonaco().languages.getLanguages();
  }
  return _supportedLanguages;
};

export const getLanguageByExtension = (extension: string): LanguageInfo | null => {
  const languages = getSupportedLanguages();
  return languages.find((language) => language.extensions?.includes(extension)) || null;
};

export const getExtensionByLanguage = (language: string): string | null => {
  const languages = getSupportedLanguages();
  return languages.find((lang) => lang.id === language)?.extensions?.[0]?.substring(1) || null;
};

// エディタインスタンスのシングルトン
let _editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;

export const getOrCreateEditor = (
  container: HTMLElement,
  options: monaco.editor.IStandaloneEditorConstructionOptions
): monaco.editor.IStandaloneCodeEditor => {
  const m = getMonaco();
  if (!_editorInstance || _editorInstance.getModel()?.isDisposed()) {
    _editorInstance = m.editor.create(container, options);
  } else {
    _editorInstance.updateOptions(options);
  }
  return _editorInstance;
};

export const disposeEditor = () => {
  if (_editorInstance) {
    _editorInstance.dispose();
    _editorInstance = null;
  }
};

// モジュールとしてmonacoをエクスポート
export { monaco }; 