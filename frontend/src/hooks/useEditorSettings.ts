import { useState, useEffect } from 'react';
import { LoadSettings, SaveSettings } from '../../wailsjs/go/main/App';
import { EditorSettings } from '../types';
import * as runtime from '../../wailsjs/runtime';

export const useEditorSettings = () => {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [editorSettings, setEditorSettings] = useState<EditorSettings>({
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
  });
  const [isInitialized, setIsInitialized] = useState(false);

  // 初期設定の読み込み
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await LoadSettings();
        const editorSettings: EditorSettings = {
          fontFamily: settings.fontFamily,
          fontSize: settings.fontSize,
          isDarkMode: settings.isDarkMode,
          wordWrap: settings.wordWrap === 'on' ? 'on' : 'off',
          minimap: settings.minimap,
          windowWidth: settings.windowWidth,
          windowHeight: settings.windowHeight,
          windowX: settings.windowX,
          windowY: settings.windowY,
          isMaximized: settings.isMaximized,
        };

        // ウィンドウの位置とサイズを復元
        runtime.WindowSetPosition(settings.windowX, settings.windowY);
        runtime.WindowSetSize(settings.windowWidth, settings.windowHeight);
        if (settings.isMaximized) {
          runtime.WindowMaximise();
        }

        if (editorSettings.isDarkMode) {
          runtime.WindowSetDarkTheme();
        } else {
          runtime.WindowSetLightTheme();
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


  // エディター設定の保存（ウィンドウサイズ・位置以外）
  useEffect(() => {
    if (isInitialized) {
      SaveSettings(editorSettings);
    }
  }, [
    editorSettings.fontFamily,
    editorSettings.fontSize,
    editorSettings.isDarkMode,
    editorSettings.wordWrap,
    editorSettings.minimap,
    isInitialized
  ]);

  const handleSettingsChange = (newSettings: EditorSettings) => {
    setEditorSettings(newSettings);
    setIsSettingsOpen(false);
  };

  return {
    isSettingsOpen,
    setIsSettingsOpen,
    editorSettings,
    setEditorSettings,
    handleSettingsChange,
  };
};