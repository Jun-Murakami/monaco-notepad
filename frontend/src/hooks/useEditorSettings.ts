import { useCallback, useEffect, useState } from 'react';
import { LoadSettings, SaveSettings } from '../../wailsjs/go/backend/App';
import * as runtime from '../../wailsjs/runtime';
import type { Settings } from '../types';

export const useEditorSettings = () => {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [editorSettings, setEditorSettings] = useState<Settings>({
    fontFamily: 'Consolas, Monaco, "Courier New", monospace',
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
  });
  const [isInitialized, setIsInitialized] = useState(false);

  // 初期設定の読み込み
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await LoadSettings();
        const editorSettings: Settings = {
          fontFamily: settings.fontFamily,
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

  const handleSettingsChange = (newSettings: Settings) => {
    setEditorSettings(newSettings);
    setIsSettingsOpen(false);
    SaveSettings(newSettings);
  };

  const handleSetEditorSettings = useCallback(
    (newSettings: Settings) => {
      setEditorSettings(newSettings);
      if (isInitialized) {
        SaveSettings(newSettings);
      }
    },
    [isInitialized],
  );

  return {
    isSettingsOpen,
    setIsSettingsOpen,
    editorSettings,
    setEditorSettings: handleSetEditorSettings,
    handleSettingsChange,
  };
};
