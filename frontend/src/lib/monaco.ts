import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_, label) {
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

function ensureFirstBackSlash(str: string) {
  return str.length > 0 && str.charAt(0) !== '/' ? `/${str}` : str;
}

function uriFromPath(_path: string) {
  const pathName = _path.replace(/\\/g, '/');
  return encodeURI(`file://${ensureFirstBackSlash(pathName)}`);
}

loader.config({
  paths: {
    vs: '/node_modules/monaco-editor/min/vs',
  },
  monaco,
});

export interface LanguageInfo {
  id: string;
  extensions?: string[];
  aliases?: string[];
  mimetypes?: string[];
  filenames?: string[];
}

// 言語情報の取得
export const getSupportedLanguages = (): LanguageInfo[] => {
  return monaco.languages.getLanguages();
};

// 拡張子から言語を取得
export const getLanguageByExtension = (extension: string): LanguageInfo | null => {
  const languages = getSupportedLanguages();
  return languages.find((language) => language.extensions?.includes(extension)) || null;
};

// 言語から拡張子を取得
export const getExtensionByLanguage = (language: string): string | null => {
  const languages = getSupportedLanguages();
  return languages.find((lang) => lang.id === language)?.extensions?.[0]?.substring(1) || null;
};

// モジュールとしてmonacoをエクスポート
export { monaco }; 