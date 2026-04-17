import { useCallback, useEffect } from 'react';

import {
  GetSystemLocale,
  IsWindowPositionValid,
  LoadSettings,
  SaveSettings,
} from '../../wailsjs/go/backend/App';
import * as runtime from '../../wailsjs/runtime';
import { changeLanguage } from '../i18n';
import {
  applySettingsToAllEditors,
  useEditorSettingsStore,
} from '../stores/useEditorSettingsStore';
import { DEFAULT_EDITOR_FONT_FAMILY, type Settings } from '../types';

export const useEditorSettings = () => {
  const settings = useEditorSettingsStore((s) => s.settings);
  const isInitialized = useEditorSettingsStore((s) => s.isInitialized);
  const setSettings = useEditorSettingsStore((s) => s.setSettings);
  const setInitialized = useEditorSettingsStore((s) => s.setInitialized);

  // 初期設定の読み込み
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const loaded = await LoadSettings();

        // 言語設定の解決
        let resolvedLanguage: 'en' | 'ja';
        if (loaded.uiLanguage === 'system' || !loaded.uiLanguage) {
          const systemLocale = await GetSystemLocale();
          resolvedLanguage = systemLocale.startsWith('ja') ? 'ja' : 'en';
        } else {
          resolvedLanguage = loaded.uiLanguage as 'en' | 'ja';
        }

        // i18nの言語を設定
        await changeLanguage(resolvedLanguage);

        const editorSettings: Settings = {
          fontFamily: loaded.fontFamily || DEFAULT_EDITOR_FONT_FAMILY,
          fontSize: loaded.fontSize,
          isDarkMode: loaded.isDarkMode,
          editorTheme: loaded.editorTheme || 'default',
          wordWrap: loaded.wordWrap,
          minimap: loaded.minimap,
          windowWidth: loaded.windowWidth,
          windowHeight: loaded.windowHeight,
          windowX: loaded.windowX,
          windowY: loaded.windowY,
          isMaximized: loaded.isMaximized,
          isDebug: loaded.isDebug,
          enableConflictBackup: loaded.enableConflictBackup ?? true,
          markdownPreviewOnLeft: loaded.markdownPreviewOnLeft ?? false,
          sidebarWidth: loaded.sidebarWidth,
          splitPaneSize: loaded.splitPaneSize,
          markdownPreviewPaneSize: loaded.markdownPreviewPaneSize,
          markdownPreviewVisible: loaded.markdownPreviewVisible,
          isSplit: loaded.isSplit,
          uiLanguage: (loaded.uiLanguage as Settings['uiLanguage']) || 'system',
        };

        // ウィンドウの位置とサイズを復元
        const isValid = await IsWindowPositionValid(
          loaded.windowX,
          loaded.windowY,
          loaded.windowWidth,
          loaded.windowHeight,
        );
        if (isValid) {
          runtime.WindowSetPosition(loaded.windowX, loaded.windowY);
          runtime.WindowSetSize(loaded.windowWidth, loaded.windowHeight);
          if (loaded.isMaximized) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            runtime.WindowMaximise();
          }
        } else {
          runtime.WindowSetSize(loaded.windowWidth, loaded.windowHeight);
          runtime.WindowCenter();
          if (loaded.isMaximized) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            runtime.WindowMaximise();
          }
        }

        const envinronment = await runtime.Environment();
        if (envinronment.platform === 'windows') {
          if (editorSettings.isDarkMode) {
            runtime.WindowSetDarkTheme();
          } else {
            runtime.WindowSetLightTheme();
          }
        }
        setSettings(editorSettings);
        setInitialized(true);

        // 初期設定をエディタに適用（エディタがまだマウントされていない場合は何もしない）
        applySettingsToAllEditors(editorSettings);
      } catch (error) {
        console.error('Failed to load settings:', error);
        setInitialized(true);
      }
    };

    loadSettings();
  }, [setSettings, setInitialized]);

  // 設定変更ハンドラ（SettingsDialogのonChange、即時反映・即時保存）
  const handleSetEditorSettings = useCallback(
    async (newSettings: Settings) => {
      // 言語が変更された場合はi18nも更新
      if (newSettings.uiLanguage !== settings.uiLanguage) {
        let resolvedLanguage: 'en' | 'ja';
        if (newSettings.uiLanguage === 'system') {
          const systemLocale = await GetSystemLocale();
          resolvedLanguage = systemLocale.startsWith('ja') ? 'ja' : 'en';
        } else {
          resolvedLanguage = newSettings.uiLanguage as 'en' | 'ja';
        }
        await changeLanguage(resolvedLanguage);
      }

      setSettings(newSettings);
      if (isInitialized) {
        SaveSettings(newSettings);
      }

      // ハンドラから直接Monacoに適用（useEffect不要）
      applySettingsToAllEditors(newSettings);
    },
    [isInitialized, settings.uiLanguage, setSettings],
  );

  return {
    editorSettings: settings,
    setEditorSettings: handleSetEditorSettings,
  };
};
