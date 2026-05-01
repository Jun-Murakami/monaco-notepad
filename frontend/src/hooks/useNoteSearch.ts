import { useMemo } from 'react';

import { useAllFileNotes } from '../stores/useFileNotesStore';
import { useAllNotes } from '../stores/useNotesStore';
import { useSearchReplaceStore } from '../stores/useSearchReplaceStore';

// サイドバーのフィルタ用フック。
// クエリ・notes・fileNotes ともに store から直接購読する。
// クエリ無し: 各セクション全件表示（フィルタなし）。
// クエリあり:
//   - scope='all'  : Notes / FileNotes 両方をクエリでフィルタ
//   - scope='local': FileNotes のみフィルタ。Notes はスコープ外なので **空配列**
//   - scope='notes': Notes のみフィルタ。FileNotes はスコープ外なので **空配列**
// スコープ外で「全件表示」にするとサイドバー件数表示がスコープと不整合になる
// （例: filtered.length が分母より大きく見える）ので、空配列で揃える。
export const useNoteSearch = () => {
  const noteSearch = useSearchReplaceStore((s) => s.query);
  const scope = useSearchReplaceStore((s) => s.scope);
  const notes = useAllNotes();
  const fileNotes = useAllFileNotes();

  const filteredNotes = useMemo(() => {
    if (!noteSearch) return notes;
    if (scope === 'local') return []; // スコープ外
    const q = noteSearch.toLowerCase();
    return notes.filter((note) => {
      if (note.archived) return false;
      return (
        note.title.toLowerCase().includes(q) ||
        (note.content?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [notes, noteSearch, scope]);

  const filteredFileNotes = useMemo(() => {
    if (!noteSearch) return fileNotes;
    if (scope === 'notes') return []; // スコープ外
    const q = noteSearch.toLowerCase();
    return fileNotes.filter(
      (note) =>
        note.fileName.toLowerCase().includes(q) ||
        note.content.toLowerCase().includes(q),
    );
  }, [fileNotes, noteSearch, scope]);

  const totalSearchMatches = useMemo(() => {
    if (!noteSearch) return 0;
    const q = noteSearch.toLowerCase();
    const countOccurrences = (text: string | null): number => {
      if (!text) return 0;
      const lower = text.toLowerCase();
      let count = 0;
      let pos = lower.indexOf(q);
      while (pos !== -1) {
        count++;
        pos = lower.indexOf(q, pos + q.length);
      }
      return count;
    };
    let total = 0;
    // 件数集計はスコープに応じて対象を絞る
    if (scope !== 'local') {
      for (const note of filteredNotes) {
        if (note.archived) continue;
        total += countOccurrences(note.content);
      }
    }
    if (scope !== 'notes') {
      for (const fn of filteredFileNotes) {
        total += countOccurrences(fn.content);
      }
    }
    return total;
  }, [noteSearch, filteredNotes, filteredFileNotes, scope]);

  return {
    noteSearch,
    filteredNotes,
    filteredFileNotes,
    totalSearchMatches,
  };
};
