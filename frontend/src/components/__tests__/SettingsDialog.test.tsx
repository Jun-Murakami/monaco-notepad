import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';

import * as runtime from '../../../wailsjs/runtime';
import { DEFAULT_EDITOR_SETTINGS } from '../../types';
import { SettingsDialog } from '../SettingsDialog';

import type { Settings } from '../../types';

// runtimeのモック
vi.mock('../../../wailsjs/runtime', () => ({
  WindowSetDarkTheme: vi.fn(),
  WindowSetLightTheme: vi.fn(),
}));

describe('SettingsDialog', () => {
  const mockSettings: Settings = {
    fontFamily: 'Test Font',
    fontSize: 14,
    isDarkMode: false,
    editorTheme: 'default',
    wordWrap: 'off',
    minimap: true,
    isDebug: false,
    enableConflictBackup: true,
    markdownPreviewOnLeft: false,
    windowWidth: 800,
    windowHeight: 600,
    windowX: 0,
    windowY: 0,
    isMaximized: false,
    ...DEFAULT_EDITOR_SETTINGS,
  };

  const defaultProps = {
    open: true,
    settings: mockSettings,
    onClose: vi.fn(),
    onChange: vi.fn(),
    onOpenAbout: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('設定値が正しく表示されること', () => {
    render(<SettingsDialog {...defaultProps} />);

    expect(screen.getByLabelText('Font Family')).toHaveValue(
      mockSettings.fontFamily,
    );
    const fontSizeSelect = screen.getByText('14px');
    expect(fontSizeSelect).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: /Light Mode/i }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('switch', { name: /Word Wrap/i }),
    ).not.toBeChecked();
    expect(screen.getByRole('switch', { name: /Minimap/i })).toBeChecked();
    expect(
      screen.getByRole('switch', { name: /Debug Mode/i }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('switch', { name: /Conflict Backup/i }),
    ).toBeChecked();
  });

  it('フォントファミリーの変更が正しく動作すること', () => {
    render(<SettingsDialog {...defaultProps} />);

    const input = screen.getByLabelText('Font Family');
    fireEvent.change(input, { target: { value: 'New Font' } });

    expect(defaultProps.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        fontFamily: 'New Font',
      }),
    );
  });

  it('フォントサイズの変更が正しく動作すること', () => {
    render(<SettingsDialog {...defaultProps} />);

    const select = screen.getByText('14px');
    fireEvent.mouseDown(select);
    const option = screen.getByText('16px');
    fireEvent.click(option);

    expect(defaultProps.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        fontSize: 16,
      }),
    );
  });

  it('ダークモードの切り替えが正しく動作すること', () => {
    render(<SettingsDialog {...defaultProps} />);

    const switch_ = screen.getByRole('switch', { name: /Light Mode/i });
    fireEvent.click(switch_);

    expect(runtime.WindowSetDarkTheme).toHaveBeenCalled();
    expect(defaultProps.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        isDarkMode: true,
      }),
    );
  });

  it('ワードラップの切り替えが正しく動作すること', () => {
    render(<SettingsDialog {...defaultProps} />);

    const switch_ = screen.getByRole('switch', { name: /Word Wrap/i });
    fireEvent.click(switch_);

    expect(defaultProps.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        wordWrap: 'on',
      }),
    );
  });

  it('競合バックアップ設定の切り替えが正しく動作すること', () => {
    render(<SettingsDialog {...defaultProps} />);

    const switch_ = screen.getByRole('switch', { name: /Conflict Backup/i });
    fireEvent.click(switch_);

    expect(defaultProps.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        enableConflictBackup: false,
      }),
    );
  });

  it('デフォルト設定へのリセットが正しく動作すること', () => {
    render(<SettingsDialog {...defaultProps} />);

    const resetButton = screen.getByRole('button', {
      name: /Reset to Default/i,
    });
    fireEvent.click(resetButton);

    expect(defaultProps.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        ...DEFAULT_EDITOR_SETTINGS,
      }),
    );
  });

  it('閉じるボタンが正しく動作すること', () => {
    render(<SettingsDialog {...defaultProps} />);

    const closeButton = screen.getByRole('button', { name: /Close/i });
    fireEvent.click(closeButton);

    expect(defaultProps.onClose).toHaveBeenCalled();
  });
});
