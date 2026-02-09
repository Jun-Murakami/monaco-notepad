import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { LoadSettings, SaveSettings } from '../../../wailsjs/go/backend/App';
import * as runtime from '../../../wailsjs/runtime';
import type { Settings } from '../../types';
import { useEditorSettings } from '../useEditorSettings';

// モックの設定
vi.mock('../../../wailsjs/go/backend/App', () => ({
  LoadSettings: vi.fn(),
  SaveSettings: vi.fn(),
}));

vi.mock('../../../wailsjs/runtime', () => ({
  WindowSetPosition: vi.fn(),
  WindowSetSize: vi.fn(),
  WindowMaximise: vi.fn(),
  WindowSetDarkTheme: vi.fn(),
  WindowSetLightTheme: vi.fn(),
  Environment: vi.fn(),
}));

describe('useEditorSettings フック', () => {
  const mockSettings: Settings = {
    fontFamily: 'Test Font',
    fontSize: 16,
    isDarkMode: true,
    wordWrap: 'on',
    minimap: false,
    windowWidth: 1000,
    windowHeight: 800,
    windowX: 100,
    windowY: 100,
    isMaximized: true,
    isDebug: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (LoadSettings as unknown as Mock).mockResolvedValue(mockSettings);
    (runtime.Environment as unknown as Mock).mockResolvedValue({
      platform: 'windows',
    });
  });

  describe('初期化処理', () => {
    it('設定が正常に読み込まれること', async () => {
      const { result } = renderHook(() => useEditorSettings());

      // 初期値の確認
      expect(result.current.editorSettings).toEqual({
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

      // 非同期処理の完了を待つ
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(result.current.editorSettings).toEqual(mockSettings);
      expect(LoadSettings).toHaveBeenCalled();
      expect(runtime.WindowSetPosition).toHaveBeenCalledWith(
        mockSettings.windowX,
        mockSettings.windowY,
      );
      expect(runtime.WindowSetSize).toHaveBeenCalledWith(
        mockSettings.windowWidth,
        mockSettings.windowHeight,
      );
      expect(runtime.WindowMaximise).toHaveBeenCalled();
      expect(runtime.WindowSetDarkTheme).toHaveBeenCalled();
    });

    it('設定の読み込みに失敗した場合、デフォルト値が使用されること', async () => {
      (LoadSettings as unknown as Mock).mockRejectedValue(
        new Error('読み込みエラー'),
      );

      const { result } = renderHook(() => useEditorSettings());

      // 非同期処理の完了を待つ
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(result.current.editorSettings).toEqual({
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
    });
  });

  describe('設定の変更処理', () => {
    it('設定が変更された場合、新しい設定が保存されること', async () => {
      const { result } = renderHook(() => useEditorSettings());

      // 非同期処理の完了を待つ
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(result.current.editorSettings).toEqual(mockSettings);

      const newSettings: Settings = {
        ...mockSettings,
        fontSize: 18,
        isDarkMode: false,
      };

      await act(async () => {
        result.current.handleSettingsChange(newSettings);
      });

      expect(result.current.editorSettings).toEqual(newSettings);
      expect(result.current.isSettingsOpen).toBe(false);
      expect(SaveSettings).toHaveBeenCalledWith(newSettings);
    });
  });

  describe('設定ダイアログの制御', () => {
    it('ダイアログの開閉状態が正しく制御されること', async () => {
      const { result } = renderHook(() => useEditorSettings());

      expect(result.current.isSettingsOpen).toBe(false);

      await act(async () => {
        result.current.setIsSettingsOpen(true);
      });

      expect(result.current.isSettingsOpen).toBe(true);

      await act(async () => {
        result.current.setIsSettingsOpen(false);
      });

      expect(result.current.isSettingsOpen).toBe(false);
    });
  });
});
