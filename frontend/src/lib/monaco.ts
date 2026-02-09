import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

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
    getWorker(_moduleId: string, label: string) {
      if (label === 'json') {
        return new jsonWorker();
      }
      if (label === 'css' || label === 'scss' || label === 'less') {
        return new cssWorker();
      }
      if (label === 'html' || label === 'handlebars' || label === 'razor') {
        return new htmlWorker();
      }
      if (label === 'typescript' || label === 'javascript') {
        return new tsWorker();
      }
      return new editorWorker();
    },
  };

  // TypeScriptの設定
  monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
    diagnosticCodesToIgnore: [1108, 1375, 1378],
  });
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
    diagnosticCodesToIgnore: [1108, 1375, 1378],
  });

  // コンパイラオプションも設定
  monaco.typescript.typescriptDefaults.setCompilerOptions({
    target: monaco.typescript.ScriptTarget.Latest,
    allowNonTsExtensions: true,
    moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
    module: monaco.typescript.ModuleKind.CommonJS,
    noEmit: true,
    esModuleInterop: true,
    jsx: monaco.typescript.JsxEmit.React,
    reactNamespace: 'React',
    allowJs: true,
    typeRoots: ['node_modules/@types'],
  });

  monaco.typescript.typescriptDefaults.setEagerModelSync(true);

  // ログ出力を抑制
  _monaco = monaco;
  _monaco.editor.setTheme = () => Promise.resolve();
  _monaco.editor.onDidCreateEditor = () => ({ dispose: () => {} });

  _isInitialized = true;
};

// モナコエディタのインスタンスを取得
export const getMonaco = () => {
  if (!_isInitialized) {
    initializeMonaco();
  }
  if (!_monaco) {
    throw new Error('Monaco editor failed to initialize');
  }
  return _monaco;
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

export const getLanguageByExtension = (
  extension: string,
): LanguageInfo | null => {
  const languages = getSupportedLanguages();
  return (
    languages.find((language) => language.extensions?.includes(extension)) ||
    null
  );
};

export const getExtensionByLanguage = (language: string): string | null => {
  const languages = getSupportedLanguages();
  return (
    languages
      .find((lang) => lang.id === language)
      ?.extensions?.[0]?.substring(1) || null
  );
};

// エディタインスタンスのシングルトン
let _editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;

export const getOrCreateEditor = (
  container: HTMLElement,
  options: monaco.editor.IStandaloneEditorConstructionOptions,
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
