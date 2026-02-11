import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
import { AppBar } from '../AppBar';

describe('AppBar', () => {
  const defaultProps = {
    platform: 'win32',
    onNew: vi.fn(),
    onOpen: vi.fn(),
    onSave: vi.fn(),
  };

  it('3つのボタンが表示されること', () => {
    render(<AppBar {...defaultProps} />);

    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Save as')).toBeInTheDocument();
  });

  it('各ボタンのクリックイベントが正しく動作すること', () => {
    render(<AppBar {...defaultProps} />);

    fireEvent.click(screen.getByText('New'));
    expect(defaultProps.onNew).toHaveBeenCalled();

    fireEvent.click(screen.getByText('Open'));
    expect(defaultProps.onOpen).toHaveBeenCalled();

    fireEvent.click(screen.getByText('Save as'));
    expect(defaultProps.onSave).toHaveBeenCalled();
  });

  it('プラットフォームに応じて正しいキーボードショートカットが表示されること', () => {
    const { unmount } = render(<AppBar {...defaultProps} platform="darwin" />);
    expect(
      screen.getByRole('button', { name: 'New (Command + N)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open (Command + O)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save as (Command + S)' }),
    ).toBeInTheDocument();
    unmount();

    render(<AppBar {...defaultProps} platform="win32" />);
    expect(
      screen.getByRole('button', { name: 'New (Ctrl + N)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open (Ctrl + O)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save as (Ctrl + S)' }),
    ).toBeInTheDocument();
  });
});
