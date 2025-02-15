import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useInitialize } from '../useInitialize';
import { ListNotes, NotifyFrontendReady, LoadFileNotes } from '../../../wailsjs/go/backend/App';
import * as runtime from '../../../wailsjs/runtime';
import { Note, FileNote } from '../../types';

// Monaco Editorのモック
vi.mock('../../lib/monaco', () => ({
  getSupportedLanguages: vi.fn().mockReturnValue([
    { id: 'plaintext', extensions: ['.txt'], aliases: ['Plain Text'] },
    { id: 'javascript', extensions: ['.js'], aliases: ['JavaScript'] },
  ]),
}));

// モックの設定
vi.mock('../../../wailsjs/go/backend/App', () => ({
  ListNotes: vi.fn(),
  NotifyFrontendReady: vi.fn(),
  LoadFileNotes: vi.fn(),
}));

vi.mock('../../../wailsjs/runtime', () => ({
  EventsOn: vi.fn().mockReturnValue(() => { }),
  EventsOff: vi.fn(),
  Environment: vi.fn(),
}));

// テスト用のモックデータ
const mockNote: Note = {
  id: '1',
  title: 'Test Note',
  content: 'Test Content',
  contentHeader: null,
  language: 'plaintext',
  modifiedTime: new Date().toISOString(),
  archived: false,
};

const mockFileNote: FileNote = {
  id: '2',
  filePath: '/path/to/file.txt',
  fileName: 'file.txt',
  content: 'File Content',
  originalContent: 'File Content',
  language: 'plaintext',
  modifiedTime: new Date().toISOString(),
};

describe('useInitialize', () => {
  // モック関数の準備
  const mockSetNotes = vi.fn();
  const mockSetFileNotes = vi.fn();
  const mockHandleNewNote = vi.fn();
  const mockHandleSelecAnyNote = vi.fn();
  const mockHandleSaveFile = vi.fn();
  const mockHandleOpenFile = vi.fn();
  const mockHandleCloseFile = vi.fn();
  const mockIsFileModified = vi.fn();
  const mockHandleArchiveNote = vi.fn();
  const mockHandleSaveAsFile = vi.fn();
  const mockHandleSelectNextAnyNote = vi.fn();
  const mockHandleSelectPreviousAnyNote = vi.fn();
  const mockSetCurrentFileNote = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // 環境設定のモック
    (runtime.Environment as any).mockResolvedValue({ platform: 'windows' });
    // ノートリストのモック
    (ListNotes as any).mockResolvedValue([mockNote]);
    // ファイルノートリストのモック
    (LoadFileNotes as any).mockResolvedValue([mockFileNote]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('初期化時に必要なデータを読み込むこと', async () => {
    const rendered = renderHook(() => useInitialize(
      mockSetNotes,
      mockSetFileNotes,
      mockHandleNewNote,
      mockHandleSelecAnyNote,
      null,
      mockSetCurrentFileNote,
      mockHandleSaveFile,
      mockHandleOpenFile,
      mockHandleCloseFile,
      mockIsFileModified,
      null,
      mockHandleArchiveNote,
      mockHandleSaveAsFile,
      mockHandleSelectNextAnyNote,
      mockHandleSelectPreviousAnyNote,
    ));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // プラットフォーム情報が取得されていること
    expect(runtime.Environment).toHaveBeenCalled();
    // ノートリストが読み込まれていること
    expect(ListNotes).toHaveBeenCalled();
    // ファイルノートリストが読み込まれていること
    expect(LoadFileNotes).toHaveBeenCalled();
    // ノートリストがセットされていること
    expect(mockSetNotes).toHaveBeenCalledWith([{
      ...mockNote,
      modifiedTime: mockNote.modifiedTime.toString(),
    }]);
    // ファイルノートリストがセットされていること
    expect(mockSetFileNotes).toHaveBeenCalledWith([{
      ...mockFileNote,
      modifiedTime: mockFileNote.modifiedTime.toString(),
    }]);
    // サポートされている言語一覧が取得されていること
    expect(rendered.result.current.languages).toEqual([
      { id: 'plaintext', extensions: ['.txt'], aliases: ['Plain Text'] },
      { id: 'javascript', extensions: ['.js'], aliases: ['JavaScript'] },
    ]);
    // プラットフォーム情報が設定されていること
    expect(rendered.result.current.platform).toBe('windows');
  });

  it('バックエンド準備完了イベントを処理すること', async () => {
    renderHook(() => useInitialize(
      mockSetNotes,
      mockSetFileNotes,
      mockHandleNewNote,
      mockHandleSelecAnyNote,
      null,
      mockSetCurrentFileNote,
      mockHandleSaveFile,
      mockHandleOpenFile,
      mockHandleCloseFile,
      mockIsFileModified,
      null,
      mockHandleArchiveNote,
      mockHandleSaveAsFile,
      mockHandleSelectNextAnyNote,
      mockHandleSelectPreviousAnyNote,
    ));

    // イベントリスナーが登録されていることを確認
    expect(runtime.EventsOn).toHaveBeenCalledWith('backend:ready', expect.any(Function));

    // イベントをシミュレート
    const eventHandler = (runtime.EventsOn as any).mock.calls.find(
      (call: [string, (...args: any[]) => void]) => call[0] === 'backend:ready'
    )[1];
    await act(async () => {
      eventHandler();
    });

    // NotifyFrontendReadyが呼ばれていることを確認
    expect(NotifyFrontendReady).toHaveBeenCalled();
  });

  it('グローバルキーボードショートカットが機能すること', async () => {
    renderHook(() => useInitialize(
      mockSetNotes,
      mockSetFileNotes,
      mockHandleNewNote,
      mockHandleSelecAnyNote,
      null,
      mockSetCurrentFileNote,
      mockHandleSaveFile,
      mockHandleOpenFile,
      mockHandleCloseFile,
      mockIsFileModified,
      null,
      mockHandleArchiveNote,
      mockHandleSaveAsFile,
      mockHandleSelectNextAnyNote,
      mockHandleSelectPreviousAnyNote,
    ));

    await vi.runAllTimersAsync();

    // 新規ノート作成 (Ctrl+N)
    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'n',
        ctrlKey: true,
      });
      window.dispatchEvent(event);
    });
    expect(mockSetCurrentFileNote).toHaveBeenCalledWith(null);
    expect(mockHandleNewNote).toHaveBeenCalled();

    // ファイルを開く (Ctrl+O)
    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'o',
        ctrlKey: true,
      });
      window.dispatchEvent(event);
    });
    expect(mockHandleOpenFile).toHaveBeenCalled();

    // 次のノートに移動 (Ctrl+Tab)
    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'tab',
        ctrlKey: true,
      });
      window.dispatchEvent(event);
    });
    expect(mockHandleSelectNextAnyNote).toHaveBeenCalled();

    // 前のノートに移動 (Ctrl+Shift+Tab)
    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'tab',
        ctrlKey: true,
        shiftKey: true,
      });
      window.dispatchEvent(event);
    });
    expect(mockHandleSelectPreviousAnyNote).toHaveBeenCalled();
  });

  it('ノートリストが空の場合に新規ノートを作成すること', async () => {
    (ListNotes as any).mockResolvedValue(null);

    renderHook(() => useInitialize(
      mockSetNotes,
      mockSetFileNotes,
      mockHandleNewNote,
      mockHandleSelecAnyNote,
      null,
      mockSetCurrentFileNote,
      mockHandleSaveFile,
      mockHandleOpenFile,
      mockHandleCloseFile,
      mockIsFileModified,
      null,
      mockHandleArchiveNote,
      mockHandleSaveAsFile,
      mockHandleSelectNextAnyNote,
      mockHandleSelectPreviousAnyNote,
    ));

    await vi.runAllTimersAsync();

    expect(mockSetNotes).toHaveBeenCalledWith([]);
    expect(mockHandleNewNote).toHaveBeenCalled();
  });

  it('エラー発生時に適切に処理すること', async () => {
    (ListNotes as any).mockRejectedValue(new Error('Failed to load notes'));

    renderHook(() => useInitialize(
      mockSetNotes,
      mockSetFileNotes,
      mockHandleNewNote,
      mockHandleSelecAnyNote,
      null,
      mockSetCurrentFileNote,
      mockHandleSaveFile,
      mockHandleOpenFile,
      mockHandleCloseFile,
      mockIsFileModified,
      null,
      mockHandleArchiveNote,
      mockHandleSaveAsFile,
      mockHandleSelectNextAnyNote,
      mockHandleSelectPreviousAnyNote,
    ));

    await vi.runAllTimersAsync();

    expect(mockSetNotes).toHaveBeenCalledWith([]);
    expect(mockHandleNewNote).toHaveBeenCalled();
  });
}); 