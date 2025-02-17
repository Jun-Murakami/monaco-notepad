import { useState, useEffect, useCallback } from 'react';
import { LoadSettings, SaveSettings } from '../../wailsjs/go/backend/App';
import type { Settings } from '../types';
import * as runtime from '../../wailsjs/runtime';

export const useEditorSettings = () => {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [editorSettings, setEditorSettings] = useState<Settings>({
    fontFamily: 'Consolas, Monaco, "Courier New", monospace',
    fontSize: 14,
    isDarkMode: false,
    wordWrap: 'off',
    minimap: true,
    windowWidth: 800,
    windowHeight: 600,
    windowX: 0,
    windowY: 0,
    isMaximized: false,
    isDebug: false,
  })
  const [localEditorSettings, setLocalEditorSettings] = useState<Settings>({ ...editorSettings });

  const loadSettings = useCallback(async () => {
    try {
      const settings = await LoadSettings();
      const editorSettings: Settings = {
        fontFamily: settings.fontFamily,
        fontSize: settings.fontSize,
        isDarkMode: settings.isDarkMode,
        wordWrap: settings.wordWrap,
        minimap: settings.minimap,
        windowWidth: settings.windowWidth,
        windowHeight: settings.windowHeight,
        windowX: settings.windowX,
        windowY: settings.windowY,
        isMaximized: settings.isMaximized,
        isDebug: settings.isDebug,
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
      setLocalEditorSettings(editorSettings);
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }, []);

  // 初期設定の読み込み
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleSettingsChange = (newSettings: Settings) => {
    setEditorSettings(newSettings);
    SaveSettings(newSettings);
    setIsSettingsOpen(false);
  };

  return {
    isSettingsOpen,
    setIsSettingsOpen,
    editorSettings,
    setEditorSettings,
    localEditorSettings,
    setLocalEditorSettings,
    handleSettingsChange,
  };
};