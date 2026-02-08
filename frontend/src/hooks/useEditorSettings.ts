import { useEffect, useState } from 'react';
import { LoadSettings, SaveSettings } from '../../wailsjs/go/backend/App';
import * as runtime from '../../wailsjs/runtime';
import type { Settings } from '../types';

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
	}, [editorSettings, isInitialized]);

	const handleSettingsChange = (newSettings: Settings) => {
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
