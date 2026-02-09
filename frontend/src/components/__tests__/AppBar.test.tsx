import { fireEvent, render, screen } from '@testing-library/react';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
import { useDriveSync } from '../../hooks/useDriveSync';
import type { LanguageInfo } from '../../lib/monaco';
import type { FileNote, Note } from '../../types';
import { AppBar } from '../AppBar';

type DriveSyncReturn = {
  syncStatus: 'synced' | 'syncing' | 'logging in' | 'offline';
  isHoveringSync: boolean;
  setIsHoveringSync: (value: boolean) => void;
  isHoverLocked: boolean;
  handleGoogleAuth: () => Promise<void>;
  handleLogout: () => Promise<void>;
  handleSync: () => Promise<void>;
};

// useDriveSyncのモック
vi.mock('../../hooks/useDriveSync', () => ({
  useDriveSync: vi.fn(),
}));

describe('AppBar', () => {
  const mockLanguages: LanguageInfo[] = [
    { id: 'typescript', extensions: ['.ts'], aliases: ['TypeScript'] },
    { id: 'javascript', extensions: ['.js'], aliases: ['JavaScript'] },
  ];

  const mockNote: Note = {
    id: '1',
    title: 'Test Note',
    content: 'Test Content',
    contentHeader: null,
    language: 'typescript',
    modifiedTime: new Date().toISOString(),
    archived: false,
  };

  const mockFileNote: FileNote = {
    id: '2',
    filePath: '/path/to/file.ts',
    fileName: 'file.ts',
    content: 'Test Content',
    originalContent: 'Test Content',
    language: 'typescript',
    modifiedTime: new Date().toISOString(),
  };

  const defaultProps = {
    currentNote: mockNote,
    languages: mockLanguages,
    platform: 'win32',
    onTitleChange: vi.fn(),
    onLanguageChange: vi.fn(),
    onSettings: vi.fn(),
    onNew: vi.fn(),
    onOpen: vi.fn(),
    onSave: vi.fn(),
    showMessage: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (useDriveSync as unknown as Mock<() => DriveSyncReturn>).mockReturnValue({
      syncStatus: 'offline',
      isHoveringSync: false,
      setIsHoveringSync: vi.fn(),
      isHoverLocked: false,
      handleGoogleAuth: vi.fn(),
      handleLogout: vi.fn(),
      handleSync: vi.fn(),
    });
  });

  it('基本的なUIコンポーネントが表示されること', () => {
    render(<AppBar {...defaultProps} />);

    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Save as')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByText('TypeScript')).toBeInTheDocument();
  });

  it('ノートのタイトルが正しく表示され、編集可能であること', () => {
    render(<AppBar {...defaultProps} />);

    const titleInput = screen.getByLabelText('Title');
    expect(titleInput).toHaveValue('Test Note');

    fireEvent.change(titleInput, { target: { value: 'New Title' } });
    expect(defaultProps.onTitleChange).toHaveBeenCalledWith('New Title');
  });

  it('ファイルノートの場合、パスが表示され編集不可であること', () => {
    render(<AppBar {...defaultProps} currentNote={mockFileNote} />);

    const filePathInput = screen.getByLabelText('File Path');
    expect(filePathInput).toHaveValue('/path/to/file.ts');
    expect(filePathInput).toBeDisabled();
  });

  it('言語選択が正しく動作すること', () => {
    render(<AppBar {...defaultProps} />);

    const languageSelect = screen.getByText('TypeScript');
    fireEvent.mouseDown(languageSelect);

    const javascriptOption = screen.getByText('JavaScript');
    fireEvent.click(javascriptOption);

    expect(defaultProps.onLanguageChange).toHaveBeenCalledWith('javascript');
  });

  it('各ボタンのクリックイベントが正しく動作すること', () => {
    render(<AppBar {...defaultProps} />);

    fireEvent.click(screen.getByText('New'));
    expect(defaultProps.onNew).toHaveBeenCalled();

    fireEvent.click(screen.getByText('Open'));
    expect(defaultProps.onOpen).toHaveBeenCalled();

    fireEvent.click(screen.getByText('Save as'));
    expect(defaultProps.onSave).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(defaultProps.onSettings).toHaveBeenCalled();
  });

  it('Google Drive同期ボタンが正しく表示されること', () => {
    render(<AppBar {...defaultProps} />);

    expect(
      screen.getByRole('button', { name: 'Connect to Google Drive' }),
    ).toBeInTheDocument();
  });

  it('同期状態が"synced"の場合、同期完了アイコンが表示されること', () => {
    (useDriveSync as unknown as Mock<() => DriveSyncReturn>).mockReturnValue({
      syncStatus: 'synced',
      isHoveringSync: false,
      setIsHoveringSync: vi.fn(),
      isHoverLocked: false,
      handleGoogleAuth: vi.fn(),
      handleLogout: vi.fn(),
      handleSync: vi.fn(),
    });

    render(<AppBar {...defaultProps} />);
    expect(
      screen.getByRole('button', { name: 'Sync now!' }),
    ).toBeInTheDocument();
  });

  it('同期状態が"syncing"の場合、進行状況インジケータが表示されること', () => {
    (useDriveSync as unknown as Mock<() => DriveSyncReturn>).mockReturnValue({
      syncStatus: 'syncing',
      isHoveringSync: false,
      setIsHoveringSync: vi.fn(),
      isHoverLocked: false,
      handleGoogleAuth: vi.fn(),
      handleLogout: vi.fn(),
      handleSync: vi.fn(),
    });

    render(<AppBar {...defaultProps} />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('プラットフォームに応じて正しいキーボードショートカットが表示されること', () => {
    render(<AppBar {...defaultProps} platform="darwin" />);
    expect(
      screen.getByRole('button', { name: 'New (Command + N)' }),
    ).toBeInTheDocument();

    render(<AppBar {...defaultProps} platform="win32" />);
    expect(
      screen.getByRole('button', { name: 'New (Ctrl + N)' }),
    ).toBeInTheDocument();
  });
});
