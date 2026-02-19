import * as monaco from 'monaco-editor';
// Monaco v0.56+ では "monaco-editor" が editor API のみを指すため、
// 必要な機能を明示的に登録する（ここでは Unicode Highlighter）。
import 'monaco-editor/esm/vs/features/unicodeHighlighter/register.js';
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution.js';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import {
  JsxEmit,
  javascriptDefaults,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  typescriptDefaults,
} from 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
// Theme imports from local themes directory (copied from monaco-themes package)
import cloudsTheme from '../themes/Clouds.json';
import cloudsMidnightTheme from '../themes/Clouds Midnight.json';
import draculaTheme from '../themes/Dracula.json';
import githubDarkTheme from '../themes/GitHub Dark.json';
import githubLightTheme from '../themes/GitHub Light.json';
import monokaiTheme from '../themes/Monokai.json';
import nightOwlTheme from '../themes/Night Owl.json';
import nordTheme from '../themes/Nord.json';
import solarizedDarkTheme from '../themes/Solarized-dark.json';
import solarizedLightTheme from '../themes/Solarized-light.json';
import tomorrowTheme from '../themes/Tomorrow.json';
import tomorrowNightTheme from '../themes/Tomorrow-Night.json';

// Theme pair type definition
export type ThemePair = {
  id: string;
  label: string;
  light: string;
  dark: string;
};

// Available theme pairs
export const THEME_PAIRS: ThemePair[] = [
  { id: 'default', label: 'Default', light: 'vs', dark: 'vs-dark' },
  { id: 'github', label: 'GitHub', light: 'github-light', dark: 'github-dark' },
  {
    id: 'solarized',
    label: 'Solarized',
    light: 'solarized-light',
    dark: 'solarized-dark',
  },
  {
    id: 'tomorrow',
    label: 'Tomorrow',
    light: 'tomorrow',
    dark: 'tomorrow-night',
  },
  { id: 'clouds', label: 'Clouds', light: 'clouds', dark: 'clouds-midnight' },
  { id: 'monokai', label: 'Monokai', light: 'vs', dark: 'monokai' },
  { id: 'dracula', label: 'Dracula', light: 'vs', dark: 'dracula' },
  { id: 'nord', label: 'Nord', light: 'vs', dark: 'nord' },
  { id: 'night-owl', label: 'Night Owl', light: 'vs', dark: 'night-owl' },
];

// Get theme pair by id
export const getThemePair = (id: string): ThemePair => {
  return THEME_PAIRS.find((pair) => pair.id === id) || THEME_PAIRS[0];
};

// シングルトンとしてのモジュール初期化
let _isInitialized = false;
let _monaco: typeof monaco | null = null;
type MonacoThemeData = monaco.editor.IStandaloneThemeData;

// Register custom themes
const registerThemes = () => {
  if (!_monaco) return;
  _monaco.editor.defineTheme(
    'github-light',
    githubLightTheme as MonacoThemeData,
  );
  _monaco.editor.defineTheme('github-dark', githubDarkTheme as MonacoThemeData);
  _monaco.editor.defineTheme(
    'solarized-light',
    solarizedLightTheme as MonacoThemeData,
  );
  _monaco.editor.defineTheme(
    'solarized-dark',
    solarizedDarkTheme as MonacoThemeData,
  );
  _monaco.editor.defineTheme('tomorrow', tomorrowTheme as MonacoThemeData);
  _monaco.editor.defineTheme(
    'tomorrow-night',
    tomorrowNightTheme as MonacoThemeData,
  );
  _monaco.editor.defineTheme('clouds', cloudsTheme as MonacoThemeData);
  _monaco.editor.defineTheme(
    'clouds-midnight',
    cloudsMidnightTheme as MonacoThemeData,
  );
  _monaco.editor.defineTheme('monokai', monokaiTheme as MonacoThemeData);
  _monaco.editor.defineTheme('dracula', draculaTheme as MonacoThemeData);
  _monaco.editor.defineTheme('nord', nordTheme as MonacoThemeData);
  _monaco.editor.defineTheme('night-owl', nightOwlTheme as MonacoThemeData);
};

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
  typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
    diagnosticCodesToIgnore: [1108, 1375, 1378],
  });
  javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
    diagnosticCodesToIgnore: [1108, 1375, 1378],
  });

  // コンパイラオプションも設定
  typescriptDefaults.setCompilerOptions({
    target: ScriptTarget.Latest,
    allowNonTsExtensions: true,
    moduleResolution: ModuleResolutionKind.NodeJs,
    module: ModuleKind.CommonJS,
    noEmit: true,
    esModuleInterop: true,
    jsx: JsxEmit.React,
    reactNamespace: 'React',
    allowJs: true,
    typeRoots: ['node_modules/@types'],
  });

  typescriptDefaults.setEagerModelSync(true);

  // ログ出力を抑制
  _monaco = monaco;
  _monaco.editor.onDidCreateEditor = () => ({ dispose: () => {} });

  // Register custom themes
  registerThemes();

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

export const createEditor = (
  container: HTMLElement,
  options: monaco.editor.IStandaloneEditorConstructionOptions,
): monaco.editor.IStandaloneCodeEditor => {
  const m = getMonaco();
  return m.editor.create(container, options);
};

export const disposeEditorInstance = (
  instance: monaco.editor.IStandaloneCodeEditor | null,
): void => {
  if (instance) {
    instance.dispose();
  }
};

// モジュールとしてmonacoをエクスポート
export { monaco };
