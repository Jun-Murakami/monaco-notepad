import { renderHook, act } from '@testing-library/react';
import { useFileNotes } from '../useFileNotes';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SaveFileNotes, CheckFileModified, OpenFile, GetModifiedTime } from '../../../wailsjs/go/backend/App';
import { backend } from '../../../wailsjs/go/models';
import { FileNote, Note } from '../../types';

// モックの設定
vi.mock('../../../wailsjs/go/backend/App', () => ({
  SaveFileNotes: vi.fn(),
  CheckFileModified: vi.fn(),
  OpenFile: vi.fn(),
  GetModifiedTime: vi.fn(),
}));

// backend.FileNote.createFromのモック
vi.mock('../../../wailsjs/go/models', () => ({
  backend: {
    FileNote: {
      createFrom: (note: FileNote) => note,
    },
  },
}));

describe('useFileNotes', () => {
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

  const mockProps = {
    notes: [mockNote],
    setCurrentNote: vi.fn(),
    handleNewNote: vi.fn(),
    handleSelectNote: vi.fn(),
    showMessage: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockProps.showMessage.mockResolvedValue(true);
  });

  describe('基本機能', () => {
    it('初期状態が正しく設定されていること', () => {
      const { result } = renderHook(() => useFileNotes(mockProps));

      expect(result.current.fileNotes).toEqual([]);
      expect(result.current.currentFileNote).toBeNull();
    });

    it('ファイルノートの選択が正しく機能すること', async () => {
      const { result } = renderHook(() => useFileNotes(mockProps));

      await act(async () => {
        await result.current.handleSelectFileNote(mockFileNote);
      });

      expect(result.current.currentFileNote).toEqual(mockFileNote);
      expect(mockProps.setCurrentNote).toHaveBeenCalledWith(null);
    });

    it('ファイルノートの内容変更が正しく機能すること', async () => {
      const { result } = renderHook(() => useFileNotes(mockProps));
      const newContent = 'Updated Content';

      await act(async () => {
        await result.current.handleSelectFileNote(mockFileNote);
      });

      act(() => {
        result.current.handleFileNoteContentChange(newContent);
      });

      expect(result.current.currentFileNote?.content).toBe(newContent);
    });

    it('ファイルノートが自動保存されること', async () => {
      const { result } = renderHook(() => useFileNotes(mockProps));
      const newContent = 'Updated Content';

      await act(async () => {
        await result.current.handleSelectFileNote(mockFileNote);
      });

      act(() => {
        result.current.handleFileNoteContentChange(newContent);
        result.current.setFileNotes([{ ...mockFileNote, content: newContent }]);
      });

      await act(async () => {
        vi.advanceTimersByTime(1100); // 1秒以上待つ
        await vi.runAllTimersAsync();
      });

      expect(SaveFileNotes).toHaveBeenCalledWith([
        expect.objectContaining({
          id: mockFileNote.id,
          content: newContent,
        }),
      ]);
    });

    it('リロードをキャンセルした場合、現在の内容が保持されること', async () => {
      const { result } = renderHook(() => useFileNotes(mockProps));
      (CheckFileModified as any).mockResolvedValue(true);
      mockProps.showMessage.mockResolvedValueOnce(false);
      (OpenFile as any).mockReset();

      await act(async () => {
        await result.current.handleSelectFileNote(mockFileNote);
        result.current.setFileNotes([mockFileNote]);
      });

      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await vi.runAllTimersAsync();
      });

      expect(OpenFile).not.toHaveBeenCalled();
      expect(result.current.currentFileNote?.content).toBe(mockFileNote.content);
    });
  });

  describe('ファイル変更検知', () => {
    it('外部変更を検知してリロードダイアログを表示すること', async () => {
      const { result } = renderHook(() => useFileNotes(mockProps));
      (CheckFileModified as any).mockResolvedValue(true);
      const updatedContent = 'Updated from outside';
      (OpenFile as any).mockResolvedValue(updatedContent);
      (GetModifiedTime as any).mockResolvedValue(new Date().toISOString());

      await act(async () => {
        await result.current.handleSelectFileNote(mockFileNote);
      });

      // フォーカスイベントをシミュレート
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });

      expect(CheckFileModified).toHaveBeenCalledWith(
        mockFileNote.filePath,
        mockFileNote.modifiedTime
      );
      expect(mockProps.showMessage).toHaveBeenCalled();
      expect(OpenFile).toHaveBeenCalledWith(mockFileNote.filePath);
      expect(result.current.currentFileNote?.content).toBe(updatedContent);
    });

    it('リロードをキャンセルした場合、現在の内容が保持されること', async () => {
      const { result } = renderHook(() => useFileNotes(mockProps));
      (CheckFileModified as any).mockResolvedValue(true);
      mockProps.showMessage.mockResolvedValueOnce(false);
      (OpenFile as any).mockReset();

      await act(async () => {
        await result.current.handleSelectFileNote(mockFileNote);
        result.current.setFileNotes([mockFileNote]);
      });

      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await vi.runAllTimersAsync();
      });

      expect(OpenFile).not.toHaveBeenCalled();
      expect(result.current.currentFileNote?.content).toBe(mockFileNote.content);
    });
  });

  describe('ファイルを閉じる機能', () => {
    it('変更がない場合、確認なしで閉じること', async () => {
      const { result } = renderHook(() => useFileNotes(mockProps));
      (CheckFileModified as any).mockResolvedValue(false);

      await act(async () => {
        await result.current.handleSelectFileNote(mockFileNote);
      });

      await act(async () => {
        await result.current.handleCloseFile(mockFileNote);
      });

      expect(mockProps.showMessage).not.toHaveBeenCalled();
      expect(result.current.fileNotes).toEqual([]);
      expect(result.current.currentFileNote).toBeNull();
    });

    it('変更がある場合、確認ダイアログを表示すること', async () => {
      const { result } = renderHook(() => useFileNotes(mockProps));
      const modifiedFileNote = {
        ...mockFileNote,
        content: 'Modified Content',
      };

      await act(async () => {
        await result.current.handleSelectFileNote(modifiedFileNote);
        await result.current.handleCloseFile(modifiedFileNote);
      });

      expect(mockProps.showMessage).toHaveBeenCalled();
    });

    it('最後のファイルを閉じた場合、通常のノートに切り替わること', async () => {
      const { result } = renderHook(() => useFileNotes(mockProps));

      await act(async () => {
        await result.current.handleSelectFileNote(mockFileNote);
        await result.current.handleCloseFile(mockFileNote);
      });

      expect(mockProps.handleSelectNote).toHaveBeenCalledWith(mockNote);
    });

    it('最後のファイルを閉じ、通常のノートがない場合、新規ノートが作成されること', async () => {
      const propsWithoutNotes = {
        ...mockProps,
        notes: [],
      };
      const { result } = renderHook(() => useFileNotes(propsWithoutNotes));

      await act(async () => {
        await result.current.handleSelectFileNote(mockFileNote);
        await result.current.handleCloseFile(mockFileNote);
      });

      expect(mockProps.handleNewNote).toHaveBeenCalled();
    });
  });

  describe('エラーハンドリング', () => {
    it('ファイルの保存に失敗した場合でも状態が保持されること', async () => {
      const { result } = renderHook(() => useFileNotes(mockProps));
      const newContent = 'Updated Content';
      (SaveFileNotes as any).mockRejectedValueOnce(new Error('保存エラー'));

      await act(async () => {
        await result.current.handleSelectFileNote(mockFileNote);
      });

      act(() => {
        result.current.handleFileNoteContentChange(newContent);
        result.current.setFileNotes([{ ...mockFileNote, content: newContent }]);
      });

      await act(async () => {
        vi.advanceTimersByTime(1100);
        await vi.runAllTimersAsync();
      });

      expect(result.current.currentFileNote?.content).toBe(newContent);
    });

    it('ファイルの変更チェックに失敗した場合、エラーを適切に処理すること', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
      const { result } = renderHook(() => useFileNotes(mockProps));
      const error = new Error('チェックエラー');
      (CheckFileModified as any).mockRejectedValueOnce(error);

      await act(async () => {
        await result.current.handleSelectFileNote(mockFileNote);
      });

      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await vi.runAllTimersAsync();
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to check file modification:',
        error
      );
      expect(result.current.currentFileNote).toBeTruthy();

      consoleSpy.mockRestore();
    });
  });

  describe('自動保存の詳細動作', () => {
    it('複数のファイルノートが存在する場合、全てのファイルが保存されること', async () => {
      const { result } = renderHook(() => useFileNotes(mockProps));
      const anotherFileNote = {
        ...mockFileNote,
        id: '3',
        filePath: '/path/to/another.txt',
        fileName: 'another.txt',
      };

      await act(async () => {
        result.current.setFileNotes([mockFileNote, anotherFileNote]);
      });

      await act(async () => {
        vi.advanceTimersByTime(1100);
        await vi.runAllTimersAsync();
      });

      expect(SaveFileNotes).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: mockFileNote.id }),
          expect.objectContaining({ id: anotherFileNote.id }),
        ])
      );
    });

    it('ファイルノートが空の場合、自動保存が実行されないこと', async () => {
      const { result } = renderHook(() => useFileNotes(mockProps));

      await act(async () => {
        vi.advanceTimersByTime(1100);
        await vi.runAllTimersAsync();
      });

      expect(SaveFileNotes).not.toHaveBeenCalled();
    });
  });

  describe('境界ケース', () => {
    it('FileNoteでないノートを選択した場合、何も起こらないこと', async () => {
      const { result } = renderHook(() => useFileNotes(mockProps));
      const regularNote = {
        id: '4',
        title: 'Regular Note',
        content: 'Regular Content',
        contentHeader: null,
        language: 'plaintext',
        modifiedTime: new Date().toISOString(),
        archived: false,
      };

      await act(async () => {
        await result.current.handleSelectFileNote(regularNote);
      });

      expect(result.current.currentFileNote).toBeNull();
      expect(result.current.fileNotes).toEqual([]);
    });

    it('存在しないファイルIDの変更状態をチェックした場合、falseを返すこと', () => {
      const { result } = renderHook(() => useFileNotes(mockProps));

      expect(result.current.isFileModified('non-existent-id')).toBe(false);
    });

    it('ファイルを閉じる際にキャンセルした場合、状態が保持されること', async () => {
      const { result } = renderHook(() => useFileNotes(mockProps));
      const modifiedFileNote = {
        ...mockFileNote,
        content: 'Modified Content',
      };
      mockProps.showMessage.mockResolvedValueOnce(false);

      await act(async () => {
        await result.current.handleSelectFileNote(modifiedFileNote);
      });

      await act(async () => {
        await result.current.handleCloseFile(modifiedFileNote);
      });

      expect(result.current.currentFileNote).toEqual(modifiedFileNote);
      expect(result.current.fileNotes).toContainEqual(modifiedFileNote);
    });
  });
}); 