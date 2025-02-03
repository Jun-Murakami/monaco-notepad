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
  });

  useEffect(() => {
    const loadSettings = async () => {
      const settings = await LoadSettings();
      const editorSettings: EditorSettings = {
        fontFamily: settings.fontFamily,
        fontSize: settings.fontSize,
        isDarkMode: settings.isDarkMode,
        wordWrap: settings.wordWrap === 'on' ? 'on' : 'off',
        minimap: settings.minimap,
      };
      if (editorSettings.isDarkMode) {
        runtime.WindowSetDarkTheme();
      } else {
        runtime.WindowSetLightTheme();
      }
      setEditorSettings(editorSettings);
    };

    loadSettings();
  }, []);

  useEffect(() => {
    SaveSettings(editorSettings);
  }, [editorSettings]);

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