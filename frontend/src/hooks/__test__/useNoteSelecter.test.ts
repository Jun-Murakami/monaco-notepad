import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCurrentNoteStore } from '../../stores/useCurrentNoteStore';
import { useFileNotesStore } from '../../stores/useFileNotesStore';
import { useNotesStore } from '../../stores/useNotesStore';
import { useNoteSelecter } from '../useNoteSelecter';

import type { FileNote, Note } from '../../types';

vi.mock('../../../wailsjs/go/backend/App', () => ({
  SetLastActiveNote: vi.fn(),
}));

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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useCurrentNoteStore.getState().resetCurrentNote();
    // notes / fileNotes はストアから読まれるので、デフォルト状態をセットしておく
    useNotesStore.getState().setNotes([mockNote, mockArchivedNote]);
    useFileNotesStore.getState().setFileNotes([mockFileNote]);
  });

  describe('ノート選択の基本機能', () => {
    it('通常ノートを選択した場合、正しく処理されること', async () => {
      const { result } = renderHook(() => useNoteSelecter(mockProps));

      await act(async () => {
        await result.current.handleSelecAnyNote(mockNote);
      });

      expect(mockProps.handleSelectNote).toHaveBeenCalledWith(mockNote);
      // 通常ノート選択時は currentFileNote が null にクリアされる
      expect(useCurrentNoteStore.getState().currentFileNote).toBeNull();
      expect(mockProps.handleSelectFileNote).not.toHaveBeenCalled();
    });

    it('ファイルノートを選択した場合、正しく処理されること', async () => {
      const { result } = renderHook(() => useNoteSelecter(mockProps));

      await act(async () => {
        await result.current.handleSelecAnyNote(mockFileNote);
      });

      expect(mockProps.handleSelectFileNote).toHaveBeenCalledWith(mockFileNote);
      // ファイルノート選択時は currentNote が null にクリアされる
      expect(useCurrentNoteStore.getState().currentNote).toBeNull();
      expect(mockProps.handleSelectNote).not.toHaveBeenCalled();
    });
  });

  describe('ノートの順次選択機能', () => {
    it('次のノートを選択する場合、アーカイブされていないノートとファイルノートの中から選択されること', async () => {
      useCurrentNoteStore.setState({ currentNote: mockNote });
      const { result } = renderHook(() => useNoteSelecter(mockProps));

      await act(async () => {
        await result.current.handleSelectNextAnyNote();
      });

      expect(mockProps.handleSelectFileNote).toHaveBeenCalledWith(mockFileNote);
      expect(useCurrentNoteStore.getState().currentNote).toBeNull();
    });

    it('前のノートを選択する場合、アーカイブされていないノートとファイルノートの中から選択されること', async () => {
      useCurrentNoteStore.setState({ currentFileNote: mockFileNote });
      const { result } = renderHook(() => useNoteSelecter(mockProps));

      await act(async () => {
        await result.current.handleSelectPreviousAnyNote();
      });

      expect(mockProps.handleSelectNote).toHaveBeenCalledWith(mockNote);
      expect(useCurrentNoteStore.getState().currentFileNote).toBeNull();
    });

    it('ノートが存在しない場合、次のノート選択は何も実行されないこと', async () => {
      // notes / fileNotes は store から読まれるため、両方空にしてからレンダーする
      useNotesStore.getState().setNotes([]);
      useFileNotesStore.getState().setFileNotes([]);
      const { result } = renderHook(() => useNoteSelecter(mockProps));

      await act(async () => {
        await result.current.handleSelectNextAnyNote();
      });

      expect(mockProps.handleSelectNote).not.toHaveBeenCalled();
      expect(mockProps.handleSelectFileNote).not.toHaveBeenCalled();
    });

    it('最後のノートから次に進むと最初のノートが選択されること', async () => {
      useCurrentNoteStore.setState({ currentFileNote: mockFileNote });
      const { result } = renderHook(() => useNoteSelecter(mockProps));

      await act(async () => {
        await result.current.handleSelectNextAnyNote();
      });

      expect(mockProps.handleSelectNote).toHaveBeenCalledWith(mockNote);
      expect(useCurrentNoteStore.getState().currentFileNote).toBeNull();
    });

    it('最初のノートから前に戻ると最後のノートが選択されること', async () => {
      useCurrentNoteStore.setState({ currentNote: mockNote });
      const { result } = renderHook(() => useNoteSelecter(mockProps));

      await act(async () => {
        await result.current.handleSelectPreviousAnyNote();
      });

      expect(mockProps.handleSelectFileNote).toHaveBeenCalledWith(mockFileNote);
      expect(useCurrentNoteStore.getState().currentNote).toBeNull();
    });
  });
});
