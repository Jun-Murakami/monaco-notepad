import { useCallback, useEffect, useState } from 'react';
import {
  GetSystemLocale,
  LoadSettings,
  SaveSettings,
} from '../../wailsjs/go/backend/App';
import * as runtime from '../../wailsjs/runtime';
import { changeLanguage } from '../i18n';
import { DEFAULT_EDITOR_FONT_FAMILY, type Settings } from '../types';

export const useEditorSettings = () => {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [editorSettings, setEditorSettings] = useState<Settings>({
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
  });
  const [isInitialized, setIsInitialized] = useState(false);

  // 初期設定の読み込み
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await LoadSettings();

        // 言語設定の解決
        let resolvedLanguage: 'en' | 'ja';
        if (settings.uiLanguage === 'system' || !settings.uiLanguage) {
          const systemLocale = await GetSystemLocale();
          resolvedLanguage = systemLocale.startsWith('ja') ? 'ja' : 'en';
        } else {
          resolvedLanguage = settings.uiLanguage as 'en' | 'ja';
        }

        // i18nの言語を設定
        await changeLanguage(resolvedLanguage);

        const editorSettings: Settings = {
          fontFamily: settings.fontFamily || DEFAULT_EDITOR_FONT_FAMILY,
          fontSize: settings.fontSize,
          isDarkMode: settings.isDarkMode,
          editorTheme: settings.editorTheme || 'default',
          wordWrap: settings.wordWrap,
          minimap: settings.minimap,
          windowWidth: settings.windowWidth,
          windowHeight: settings.windowHeight,
          windowX: settings.windowX,
          windowY: settings.windowY,
          isMaximized: settings.isMaximized,
          isDebug: settings.isDebug,
          enableConflictBackup: settings.enableConflictBackup ?? true,
          markdownPreviewOnLeft: settings.markdownPreviewOnLeft ?? false,
          sidebarWidth: settings.sidebarWidth,
          splitPaneSize: settings.splitPaneSize,
          markdownPreviewPaneSize: settings.markdownPreviewPaneSize,
          markdownPreviewVisible: settings.markdownPreviewVisible,
          isSplit: settings.isSplit,
          uiLanguage:
            (settings.uiLanguage as Settings['uiLanguage']) || 'system',
        };

        // ウィンドウの位置とサイズを復元
        runtime.WindowSetPosition(settings.windowX, settings.windowY);
        runtime.WindowSetSize(settings.windowWidth, settings.windowHeight);
        if (settings.isMaximized) {
          runtime.WindowMaximise();
        }

        const envinronment = await runtime.Environment();
        if (envinronment.platform === 'windows') {
          if (editorSettings.isDarkMode) {
            runtime.WindowSetDarkTheme();
          } else {
            runtime.WindowSetLightTheme();
          }
        }
        setEditorSettings(editorSettings);
        setIsInitialized(true);
      } catch (error) {
        console.error('Failed to load settings:', error);
        setIsInitialized(true);
      }
    };

    loadSettings();
  }, []);

  const handleSettingsChange = async (newSettings: Settings) => {
    // 言語が変更された場合はi18nも更新
    if (newSettings.uiLanguage !== editorSettings.uiLanguage) {
      let resolvedLanguage: 'en' | 'ja';
      if (newSettings.uiLanguage === 'system') {
        const systemLocale = await GetSystemLocale();
        resolvedLanguage = systemLocale.startsWith('ja') ? 'ja' : 'en';
      } else {
        resolvedLanguage = newSettings.uiLanguage as 'en' | 'ja';
      }
      await changeLanguage(resolvedLanguage);
    }

    setEditorSettings(newSettings);
    setIsSettingsOpen(false);
    SaveSettings(newSettings);
  };

  const handleSetEditorSettings = useCallback(
    async (newSettings: Settings) => {
      // 言語が変更された場合はi18nも更新
      if (newSettings.uiLanguage !== editorSettings.uiLanguage) {
        let resolvedLanguage: 'en' | 'ja';
        if (newSettings.uiLanguage === 'system') {
          const systemLocale = await GetSystemLocale();
          resolvedLanguage = systemLocale.startsWith('ja') ? 'ja' : 'en';
        } else {
          resolvedLanguage = newSettings.uiLanguage as 'en' | 'ja';
        }
        await changeLanguage(resolvedLanguage);
      }

      setEditorSettings(newSettings);
      if (isInitialized) {
        SaveSettings(newSettings);
      }
    },
    [isInitialized, editorSettings.uiLanguage],
  );

  return {
    isSettingsOpen,
    setIsSettingsOpen,
    editorSettings,
    setEditorSettings: handleSetEditorSettings,
    handleSettingsChange,
  };
};
