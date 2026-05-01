import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useFileNotesStore } from '../../stores/useFileNotesStore';
import { useNotesStore } from '../../stores/useNotesStore';
import {
  type SearchScope,
  useSearchReplaceStore,
} from '../../stores/useSearchReplaceStore';
import { useNoteSearch } from '../useNoteSearch';

import type { FileNote, Note } from '../../types';

const mkNote = (id: string, title: string, content: string): Note => ({
  id,
  title,
  content,
  contentHeader: null,
  language: 'plaintext',
  modifiedTime: '2026-05-01T00:00:00Z',
  archived: false,
});

const mkFileNote = (
  id: string,
  fileName: string,
  content: string,
): FileNote => ({
  id,
  fileName,
  filePath: `/tmp/${fileName}`,
  content,
  originalContent: content,
  language: 'plaintext',
  modifiedTime: '2026-05-01T00:00:00Z',
});

const setStores = (
  notes: Note[],
  fileNotes: FileNote[],
  query: string,
  scope: SearchScope,
) => {
  useNotesStore.setState({ notes });
  useFileNotesStore.setState({ fileNotes });
  useSearchReplaceStore.setState({ query, scope });
};

beforeEach(() => {
  useNotesStore.setState({ notes: [] });
  useFileNotesStore.setState({ fileNotes: [] });
  useSearchReplaceStore.setState({ query: '', scope: 'all' });
});
afterEach(() => {
  useNotesStore.setState({ notes: [] });
  useFileNotesStore.setState({ fileNotes: [] });
  useSearchReplaceStore.setState({ query: '', scope: 'all' });
});

describe('useNoteSearch', () => {
  describe('クエリが空のとき', () => {
    it('全ノート / 全ファイルノートを返し、件数 0', () => {
      setStores(
        [mkNote('n1', 'N1', 'foo bar'), mkNote('n2', 'N2', 'baz')],
        [mkFileNote('f1', 'a.md', 'foo')],
        '',
        'all',
      );
      const { result } = renderHook(() => useNoteSearch());
      expect(result.current.filteredNotes).toHaveLength(2);
      expect(result.current.filteredFileNotes).toHaveLength(1);
      expect(result.current.totalSearchMatches).toBe(0);
    });
  });

  describe('scope = "all"', () => {
    it('Notes と FileNotes 両方をクエリでフィルタする', () => {
      setStores(
        [
          mkNote('n1', 'hello', 'world'),
          mkNote('n2', 'other', 'no match'),
          mkNote('n3', 'with hello inside content', 'hello world'),
        ],
        [
          mkFileNote('f1', 'hello.md', 'foo'),
          mkFileNote('f2', 'other.md', 'no match'),
        ],
        'hello',
        'all',
      );
      const { result } = renderHook(() => useNoteSearch());
      expect(result.current.filteredNotes.map((n) => n.id)).toEqual([
        'n1',
        'n3',
      ]);
      expect(result.current.filteredFileNotes.map((f) => f.id)).toEqual(['f1']);
    });

    it('totalSearchMatches に Notes と FileNotes の両方の件数が合算される', () => {
      setStores(
        [mkNote('n1', 'x', 'hello hello')], // 2 件
        [mkFileNote('f1', 'a.md', 'hello world hello')], // 2 件
        'hello',
        'all',
      );
      const { result } = renderHook(() => useNoteSearch());
      expect(result.current.totalSearchMatches).toBe(4);
    });

    it('archived ノートはフィルタ結果に含めない', () => {
      const archived: Note = {
        ...mkNote('a1', 'hello', 'hello'),
        archived: true,
      };
      setStores([archived, mkNote('n1', 'hello', 'hello')], [], 'hello', 'all');
      const { result } = renderHook(() => useNoteSearch());
      expect(result.current.filteredNotes.map((n) => n.id)).toEqual(['n1']);
    });
  });

  describe('scope = "local"', () => {
    it('Notes はスコープ外なので空配列を返す / FileNotes はクエリでフィルタ', () => {
      setStores(
        [mkNote('n1', 'hello', 'x'), mkNote('n2', 'no', 'y')],
        [mkFileNote('f1', 'hello.md', 'x'), mkFileNote('f2', 'no.md', 'y')],
        'hello',
        'local',
      );
      const { result } = renderHook(() => useNoteSearch());
      // ノートは空（スコープ外）
      expect(result.current.filteredNotes).toEqual([]);
      // ファイルノートはフィルタ
      expect(result.current.filteredFileNotes.map((f) => f.id)).toEqual(['f1']);
    });

    it('totalSearchMatches に Notes 側のヒットを含めない', () => {
      setStores(
        [mkNote('n1', 'x', 'hello hello hello')], // notes 側 3 件は無視される
        [mkFileNote('f1', 'a.md', 'hello hello')], // fileNotes 側 2 件のみ
        'hello',
        'local',
      );
      const { result } = renderHook(() => useNoteSearch());
      expect(result.current.totalSearchMatches).toBe(2);
    });
  });

  describe('scope = "notes"', () => {
    it('FileNotes はスコープ外なので空配列を返す / Notes はクエリでフィルタ', () => {
      setStores(
        [mkNote('n1', 'hello', 'x'), mkNote('n2', 'no', 'y')],
        [mkFileNote('f1', 'hello.md', 'x'), mkFileNote('f2', 'no.md', 'y')],
        'hello',
        'notes',
      );
      const { result } = renderHook(() => useNoteSearch());
      expect(result.current.filteredNotes.map((n) => n.id)).toEqual(['n1']);
      // ファイルノートは空（スコープ外）
      expect(result.current.filteredFileNotes).toEqual([]);
    });

    it('totalSearchMatches に FileNotes 側のヒットを含めない', () => {
      setStores(
        [mkNote('n1', 'x', 'hello')],
        [mkFileNote('f1', 'a.md', 'hello hello hello hello')], // 4 件は無視
        'hello',
        'notes',
      );
      const { result } = renderHook(() => useNoteSearch());
      expect(result.current.totalSearchMatches).toBe(1);
    });
  });
});
