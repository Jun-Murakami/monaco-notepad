import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useNoteSelecter } from '../useNoteSelecter';
import type { Note, FileNote } from '../../types';

describe('useNoteSelecter フック', () => {
  const mockNote: Note = {
    id: '1',
    title: 'テストノート',
    content: 'テストコンテンツ',
    contentHeader: null,
    language: 'plaintext',
    modifiedTime: new Date().toISOString(),
    archived: false,
  };

  const mockArchivedNote: Note = {
    id: '2',
    title: 'アーカイブされたノート',
    content: 'アーカイブコンテンツ',
    contentHeader: null,
    language: 'plaintext',
    modifiedTime: new Date().toISOString(),
    archived: true,
  };

  const mockFileNote: FileNote = {
    id: '3',
    filePath: '/test/path',
    fileName: 'test.txt',
    content: 'ファイルノートコンテンツ',
    originalContent: 'ファイルノートコンテンツ',
    language: 'plaintext',
    modifiedTime: new Date().toISOString(),
  };

  const mockProps = {
    handleSelectNote: vi.fn(),
    handleSelectFileNote: vi.fn(),
    notes: [mockNote, mockArchivedNote],
    fileNotes: [mockFileNote],
    currentNote: null,
    currentFileNote: null,
    setCurrentNote: vi.fn(),
    setCurrentFileNote: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ノート選択の基本機能', () => {
    it('通常ノートを選択した場合、正しく処理されること', async () => {
      const { result } = renderHook(() => useNoteSelecter(mockProps));

      await act(async () => {
        await result.current.handleSelecAnyNote(mockNote);
      });

      expect(mockProps.handleSelectNote).toHaveBeenCalledWith(mockNote);
      expect(mockProps.setCurrentFileNote).toHaveBeenCalledWith(null);
      expect(mockProps.handleSelectFileNote).not.toHaveBeenCalled();
    });

    it('ファイルノートを選択した場合、正しく処理されること', async () => {
      const { result } = renderHook(() => useNoteSelecter(mockProps));

      await act(async () => {
        await result.current.handleSelecAnyNote(mockFileNote);
      });

      expect(mockProps.handleSelectFileNote).toHaveBeenCalledWith(mockFileNote);
      expect(mockProps.setCurrentNote).toHaveBeenCalledWith(null);
      expect(mockProps.handleSelectNote).not.toHaveBeenCalled();
    });
  });

  describe('ノートの順次選択機能', () => {
    it('次のノートを選択する場合、アーカイブされていないノートとファイルノートの中から選択されること', async () => {
      const { result } = renderHook(() => useNoteSelecter({
        ...mockProps,
        currentNote: mockNote
      }));

      await act(async () => {
        await result.current.handleSelectNextAnyNote();
      });

      expect(mockProps.handleSelectFileNote).toHaveBeenCalledWith(mockFileNote);
      expect(mockProps.setCurrentNote).toHaveBeenCalledWith(null);
    });

    it('前のノートを選択する場合、アーカイブされていないノートとファイルノートの中から選択されること', async () => {
      const { result } = renderHook(() => useNoteSelecter({
        ...mockProps,
        currentFileNote: mockFileNote
      }));

      await act(async () => {
        await result.current.handleSelectPreviousAnyNote();
      });

      expect(mockProps.handleSelectNote).toHaveBeenCalledWith(mockNote);
      expect(mockProps.setCurrentFileNote).toHaveBeenCalledWith(null);
    });

    it('ノートが存在しない場合、次のノート選択は何も実行されないこと', async () => {
      const { result } = renderHook(() => useNoteSelecter({
        ...mockProps,
        notes: [],
        fileNotes: []
      }));

      await act(async () => {
        await result.current.handleSelectNextAnyNote();
      });

      expect(mockProps.handleSelectNote).not.toHaveBeenCalled();
      expect(mockProps.handleSelectFileNote).not.toHaveBeenCalled();
    });

    it('最後のノートから次に進むと最初のノートが選択されること', async () => {
      const { result } = renderHook(() => useNoteSelecter({
        ...mockProps,
        currentFileNote: mockFileNote
      }));

      await act(async () => {
        await result.current.handleSelectNextAnyNote();
      });

      expect(mockProps.handleSelectNote).toHaveBeenCalledWith(mockNote);
      expect(mockProps.setCurrentFileNote).toHaveBeenCalledWith(null);
    });

    it('最初のノートから前に戻ると最後のノートが選択されること', async () => {
      const { result } = renderHook(() => useNoteSelecter({
        ...mockProps,
        currentNote: mockNote
      }));

      await act(async () => {
        await result.current.handleSelectPreviousAnyNote();
      });

      expect(mockProps.handleSelectFileNote).toHaveBeenCalledWith(mockFileNote);
      expect(mockProps.setCurrentNote).toHaveBeenCalledWith(null);
    });
  });
}); 