import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';
import { SettingsDialog } from '../SettingsDialog';
import { Settings, DEFAULT_EDITOR_SETTINGS } from '../../types';
import * as runtime from '../../../wailsjs/runtime';

// runtimeのモック
vi.mock('../../../wailsjs/runtime', () => ({
  WindowSetDarkTheme: vi.fn(),
  WindowSetLightTheme: vi.fn(),
}));

describe('SettingsDialog', () => {
  const mockSettings: Settings = {
    ...DEFAULT_EDITOR_SETTINGS,
    fontFamily: 'Test Font',
    fontSize: 14,
    isDarkMode: false,
    wordWrap: 'off',
    minimap: true,
    isDebug: false,
    windowWidth: 800,
    windowHeight: 600,
    windowX: 0,
    windowY: 0,
    isMaximized: false,
  };

  const defaultProps = {
    open: true,
    settings: mockSettings,
    onClose: vi.fn(),
    onSave: vi.fn(),
    onChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('設定値が正しく表示されること', () => {
    render(<SettingsDialog {...defaultProps} />);

    expect(screen.getByLabelText('Font Family')).toHaveValue(mockSettings.fontFamily);
    const fontSizeSelect = screen.getByText('14px');
    expect(fontSizeSelect).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Light Mode/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Word Wrap/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Minimap/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Debug Mode/i })).not.toBeChecked();
  });

  it('フォントファミリーの変更が正しく動作すること', () => {
    render(<SettingsDialog {...defaultProps} />);

    const input = screen.getByLabelText('Font Family');
    fireEvent.change(input, { target: { value: 'New Font' } });

    expect(defaultProps.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        fontFamily: 'New Font',
      })
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
      })
    );
  });

  it('ダークモードの切り替えが正しく動作すること', () => {
    render(<SettingsDialog {...defaultProps} />);

    const switch_ = screen.getByRole('checkbox', { name: /Light Mode/i });
    fireEvent.click(switch_);

    expect(runtime.WindowSetDarkTheme).toHaveBeenCalled();
    expect(defaultProps.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        isDarkMode: true,
      })
    );
  });

  it('ワードラップの切り替えが正しく動作すること', () => {
    render(<SettingsDialog {...defaultProps} />);

    const switch_ = screen.getByRole('checkbox', { name: /Word Wrap/i });
    fireEvent.click(switch_);

    expect(defaultProps.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        wordWrap: 'on',
      })
    );
  });

  it('デフォルト設定へのリセットが正しく動作すること', () => {
    render(<SettingsDialog {...defaultProps} />);

    const resetButton = screen.getByRole('button', { name: /Reset to Default/i });
    fireEvent.click(resetButton);

    expect(defaultProps.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        ...DEFAULT_EDITOR_SETTINGS,
      })
    );
  });

  it('キャンセルボタンが正しく動作すること', () => {
    render(<SettingsDialog {...defaultProps} />);

    const cancelButton = screen.getByRole('button', { name: /Cancel/i });
    fireEvent.click(cancelButton);

    expect(defaultProps.onChange).toHaveBeenCalledWith(mockSettings);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('保存ボタンが正しく動作すること', () => {
    render(<SettingsDialog {...defaultProps} />);

    // 設定を変更
    const input = screen.getByLabelText('Font Family');
    fireEvent.change(input, { target: { value: 'New Font' } });

    // 保存
    const saveButton = screen.getByRole('button', { name: /Save/i });
    fireEvent.click(saveButton);

    expect(defaultProps.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        fontFamily: 'New Font',
      })
    );
  });
});
