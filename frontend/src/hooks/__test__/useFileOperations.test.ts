// fileUtilsのモックを最上部に移動
vi.mock('../../utils/fileUtils', () => ({
  isBinaryFile: vi.fn().mockReturnValue(false),
}));

// Monaco Editorのモック
vi.mock('../../lib/monaco', () => ({
  getLanguageByExtension: vi.fn().mockReturnValue({ id: 'plaintext' }),
  getExtensionByLanguage: vi.fn().mockReturnValue('txt'),
}));

vi.mock('../../../wailsjs/go/backend/App', () => ({
  SelectFile: vi.fn(),
  OpenFile: vi.fn(),
  SaveFile: vi.fn(),
  SaveNote: vi.fn(),
  SelectSaveFileUri: vi.fn(),
  GetModifiedTime: vi.fn(),
}));

vi.mock('../../../wailsjs/runtime', () => ({
  EventsOn: vi.fn().mockReturnValue(() => { }),
  EventsOff: vi.fn(),
  OnFileDrop: vi.fn(),
  OnFileDropOff: vi.fn(),
}));

vi.mock('../../../wailsjs/go/models', () => ({
  backend: {
    Note: {
      createFrom: (note: Note) => note,
    },
  },
}));

import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useFileOperations } from '../useFileOperations';
import { SelectFile, OpenFile, SaveFile, SaveNote, SelectSaveFileUri, GetModifiedTime } from '../../../wailsjs/go/backend/App';
import { backend } from '../../../wailsjs/go/models';
import { Note, FileNote } from '../../types';
import * as runtime from '../../../wailsjs/runtime';

describe('useFileOperations', () => {
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

  const mockSetNotes = vi.fn();
  const mockSetFileNotes = vi.fn();
  const mockHandleSelecAnyNote = vi.fn();
  const mockShowMessage = vi.fn();
  const mockHandleSaveFileNotes = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockShowMessage.mockResolvedValue(true);
    (GetModifiedTime as any).mockResolvedValue(new Date().toISOString());
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('ファイルを開く機能', () => {
    it('新しいファイルを正しく開くこと', async () => {
      const { result } = renderHook(() => useFileOperations(
        [mockNote],
        mockSetNotes,
        mockNote,
        null,
        [],
        mockSetFileNotes,
        mockHandleSelecAnyNote,
        mockShowMessage,
        mockHandleSaveFileNotes,
      ));

      (SelectFile as any).mockResolvedValue('/path/to/newfile.txt');
      (OpenFile as any).mockResolvedValue('New File Content');

      await act(async () => {
        await result.current.handleOpenFile();
      });

      expect(mockSetFileNotes).toHaveBeenCalled();
      expect(mockHandleSaveFileNotes).toHaveBeenCalled();
      expect(mockHandleSelecAnyNote).toHaveBeenCalled();
    });

    it('既に開いているファイルを選択した場合、そのファイルにフォーカスすること', async () => {
      const { result } = renderHook(() => useFileOperations(
        [mockNote],
        mockSetNotes,
        mockNote,
        null,
        [mockFileNote],
        mockSetFileNotes,
        mockHandleSelecAnyNote,
        mockShowMessage,
        mockHandleSaveFileNotes,
      ));

      (SelectFile as any).mockResolvedValue(mockFileNote.filePath);

      await act(async () => {
        await result.current.handleOpenFile();
      });

      expect(mockHandleSelecAnyNote).toHaveBeenCalledWith(mockFileNote);
      expect(OpenFile).not.toHaveBeenCalled();
    });

    it('バイナリファイルを開こうとした場合、エラーメッセージを表示すること', async () => {
      const { result } = renderHook(() => useFileOperations(
        [mockNote],
        mockSetNotes,
        mockNote,
        null,
        [],
        mockSetFileNotes,
        mockHandleSelecAnyNote,
        mockShowMessage,
        mockHandleSaveFileNotes,
      ));

      (SelectFile as any).mockResolvedValue('/path/to/binary.exe');
      // バイナリファイルの内容をシミュレート
      const binaryContent = '\x00\x01\x02\x03';
      (OpenFile as any).mockResolvedValue(binaryContent);

      await act(async () => {
        await result.current.handleOpenFile();
        await vi.runAllTimersAsync();
      });

      expect(OpenFile).toHaveBeenCalledWith('/path/to/binary.exe');
      expect(mockShowMessage).toHaveBeenCalledWith(
        'Error',
        'Failed to open the file. Please check the file format.'
      );
      expect(mockSetFileNotes).not.toHaveBeenCalled();
    });
  });

  describe('ファイルを保存する機能', () => {
    it('ファイルを正しく保存すること', async () => {
      const { result } = renderHook(() => useFileOperations(
        [mockNote],
        mockSetNotes,
        mockNote,
        mockFileNote,
        [mockFileNote],
        mockSetFileNotes,
        mockHandleSelecAnyNote,
        mockShowMessage,
        mockHandleSaveFileNotes,
      ));

      await act(async () => {
        await result.current.handleSaveFile(mockFileNote);
      });

      expect(SaveFile).toHaveBeenCalledWith(mockFileNote.filePath, mockFileNote.content);
      expect(mockSetFileNotes).toHaveBeenCalled();
      expect(mockHandleSaveFileNotes).toHaveBeenCalled();
    });

    it('保存に失敗した場合、エラーメッセージを表示すること', async () => {
      const { result } = renderHook(() => useFileOperations(
        [mockNote],
        mockSetNotes,
        mockNote,
        mockFileNote,
        [mockFileNote],
        mockSetFileNotes,
        mockHandleSelecAnyNote,
        mockShowMessage,
        mockHandleSaveFileNotes,
      ));

      (SaveFile as any).mockRejectedValue(new Error('Save failed'));

      await act(async () => {
        await result.current.handleSaveFile(mockFileNote);
      });

      expect(mockShowMessage).toHaveBeenCalledWith('Error', 'Failed to save the file.');
    });
  });

  describe('名前を付けて保存する機能', () => {
    it('ノートを新しいファイルとして保存すること', async () => {
      const { result } = renderHook(() => useFileOperations(
        [mockNote],
        mockSetNotes,
        mockNote,
        null,
        [],
        mockSetFileNotes,
        mockHandleSelecAnyNote,
        mockShowMessage,
        mockHandleSaveFileNotes,
      ));

      (SelectSaveFileUri as any).mockResolvedValue('/path/to/saved.txt');

      await act(async () => {
        await result.current.handleSaveAsFile();
      });

      expect(SelectSaveFileUri).toHaveBeenCalled();
      expect(SaveFile).toHaveBeenCalledWith('/path/to/saved.txt', mockNote.content);
    });

    it('保存に失敗した場合、エラーメッセージを表示すること', async () => {
      const { result } = renderHook(() => useFileOperations(
        [mockNote],
        mockSetNotes,
        mockNote,
        null,
        [],
        mockSetFileNotes,
        mockHandleSelecAnyNote,
        mockShowMessage,
        mockHandleSaveFileNotes,
      ));

      (SelectSaveFileUri as any).mockResolvedValue('/path/to/saved.txt');
      (SaveFile as any).mockRejectedValue(new Error('Save failed'));

      await act(async () => {
        await result.current.handleSaveAsFile();
      });

      expect(mockShowMessage).toHaveBeenCalledWith('Error', 'Failed to save the file.');
    });
  });

  describe('メモに変換する機能', () => {
    it('ファイルノートを通常のノートに変換すること', async () => {
      const { result } = renderHook(() => useFileOperations(
        [mockNote],
        mockSetNotes,
        mockNote,
        mockFileNote,
        [mockFileNote],
        mockSetFileNotes,
        mockHandleSelecAnyNote,
        mockShowMessage,
        mockHandleSaveFileNotes,
      ));

      await act(async () => {
        await result.current.handleConvertToNote(mockFileNote);
      });

      expect(mockSetNotes).toHaveBeenCalled();
      expect(mockSetFileNotes).toHaveBeenCalled();
      expect(SaveNote).toHaveBeenCalled();
      expect(mockHandleSelecAnyNote).toHaveBeenCalled();
    });
  });

  describe('ファイルをドロップする機能', () => {
    it('ドロップされたファイルを正しく開くこと', async () => {
      const { result } = renderHook(() => useFileOperations(
        [mockNote],
        mockSetNotes,
        mockNote,
        null,
        [],
        mockSetFileNotes,
        mockHandleSelecAnyNote,
        mockShowMessage,
        mockHandleSaveFileNotes,
      ));

      (OpenFile as any).mockResolvedValue('Dropped File Content');

      await act(async () => {
        await result.current.handleFileDrop('/path/to/dropped.txt');
      });

      expect(OpenFile).toHaveBeenCalledWith('/path/to/dropped.txt');
      expect(mockSetFileNotes).toHaveBeenCalled();
      expect(mockHandleSaveFileNotes).toHaveBeenCalled();
      expect(mockHandleSelecAnyNote).toHaveBeenCalled();
    });

    it('既に開いているファイルがドロップされた場合、そのファイルにフォーカスすること', async () => {
      const { result } = renderHook(() => useFileOperations(
        [mockNote],
        mockSetNotes,
        mockNote,
        null,
        [mockFileNote],
        mockSetFileNotes,
        mockHandleSelecAnyNote,
        mockShowMessage,
        mockHandleSaveFileNotes,
      ));

      await act(async () => {
        await result.current.handleFileDrop(mockFileNote.filePath);
      });

      expect(mockHandleSelecAnyNote).toHaveBeenCalledWith(mockFileNote);
      expect(OpenFile).not.toHaveBeenCalled();
    });
  });

  describe('ファイルを閉じる機能', () => {
    it('ファイルを正しく閉じること', async () => {
      const { result } = renderHook(() => useFileOperations(
        [mockNote],
        mockSetNotes,
        mockNote,
        mockFileNote,
        [mockFileNote],
        mockSetFileNotes,
        mockHandleSelecAnyNote,
        mockShowMessage,
        mockHandleSaveFileNotes,
      ));

      await act(async () => {
        await result.current.handleCloseFile(mockFileNote);
        await vi.runAllTimersAsync();
      });

      expect(mockSetFileNotes).toHaveBeenCalledWith([]);
      expect(mockHandleSaveFileNotes).toHaveBeenCalledWith([]);
      expect(mockHandleSelecAnyNote).toHaveBeenCalledWith(mockNote);
      expect(mockSetFileNotes).toHaveBeenCalledBefore(mockHandleSaveFileNotes);
      expect(mockHandleSaveFileNotes).toHaveBeenCalledBefore(mockHandleSelecAnyNote);
    });
  });
}); 