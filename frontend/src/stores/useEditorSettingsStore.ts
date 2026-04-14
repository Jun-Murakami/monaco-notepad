import { create } from 'zustand';

import { getMonaco, getThemePair } from '../lib/monaco';
import { DEFAULT_EDITOR_FONT_FAMILY, type Settings } from '../types';

import type { editor } from 'monaco-editor';

// デフォルト設定
const DEFAULT_SETTINGS: Settings = {
  fontFamily: DEFAULT_EDITOR_FONT_FAMILY,
  fontSize: 14,
  isDarkMode: false,
  editorTheme: 'default',
  wordWrap: 'off',
  minimap: true,
  windowWidth: 800,
  windowHeight: 600,
  windowX: 0,
  windowY: 0,
  isMaximized: false,
  isDebug: false,
  enableConflictBackup: true,
  markdownPreviewOnLeft: false,
  uiLanguage: 'system',
};

// エディタインスタンスのレジストリ（リアクティブにする必要がないためストア外で管理）
const editorRegistry = new Map<
  string,
  React.RefObject<editor.IStandaloneCodeEditor | null>
>();

interface EditorSettingsState {
  settings: Settings;
  isInitialized: boolean;
}

interface EditorSettingsActions {
  setSettings: (settings: Settings) => void;
  setInitialized: (value: boolean) => void;
}

export const useEditorSettingsStore = create<
  EditorSettingsState & EditorSettingsActions
>((set) => ({
  settings: DEFAULT_SETTINGS,
  isInitialized: false,
  setSettings: (settings) => set({ settings }),
  setInitialized: (isInitialized) => set({ isInitialized }),
}));

// ========================================
// エディタインスタンス レジストリ
// Editor コンポーネントがマウント/アンマウント時に呼び出す
// ========================================

export function registerEditorRef(
  paneId: string,
  ref: React.RefObject<editor.IStandaloneCodeEditor | null>,
) {
  editorRegistry.set(paneId, ref);
}

export function unregisterEditorRef(paneId: string) {
  editorRegistry.delete(paneId);
}

// ========================================
// 命令的 Monaco 同期関数
// useEffect ではなくイベントハンドラから直接呼び出す
// ========================================

/** 設定変更を全登録エディタに適用（テーマはグローバル、オプションは各インスタンスごと） */
export function applySettingsToAllEditors(settings: Settings) {
  const monaco = getMonaco();
  const pair = getThemePair(settings.editorTheme);
  const themeName = settings.isDarkMode ? pair.dark : pair.light;
  monaco.editor.setTheme(themeName);

  for (const ref of editorRegistry.values()) {
    const instance = ref.current;
    if (!instance) continue;
    instance.updateOptions({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      wordWrap: settings.wordWrap === 'on' ? 'on' : 'off',
      minimap: { enabled: settings.minimap },
    });
  }
}

/** 言語変更を特定エディタのモデルに適用 */
export function applyLanguageToEditor(
  editorInstance: editor.IStandaloneCodeEditor | null | undefined,
  language: string,
) {
  if (!editorInstance) return;
  const model = editorInstance.getModel();
  if (!model) return;
  const monaco = getMonaco();
  monaco.editor.setModelLanguage(model, language);
}
