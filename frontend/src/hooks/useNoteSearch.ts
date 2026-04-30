import { useMemo } from 'react';

import { useAllFileNotes } from '../stores/useFileNotesStore';
import { useAllNotes } from '../stores/useNotesStore';
import { useSearchReplaceStore } from '../stores/useSearchReplaceStore';

// サイドバーのフィルタ用フック。
// クエリ・notes・fileNotes ともに store から直接購読する。
// 旧 handleSearchNavigate / searchMatchIndexInNote は呼び出し元がなくなっていたため削除。
export const useNoteSearch = () => {
  const noteSearch = useSearchReplaceStore((s) => s.query);
  const notes = useAllNotes();
  const fileNotes = useAllFileNotes();

  const filteredNotes = useMemo(() => {
    if (!noteSearch) return notes;
    const q = noteSearch.toLowerCase();
    return notes.filter((note) => {
      if (note.archived) return false;
      return (
        note.title.toLowerCase().includes(q) ||
        (note.content?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [notes, noteSearch]);

  const filteredFileNotes = useMemo(() => {
    if (!noteSearch) return fileNotes;
    const q = noteSearch.toLowerCase();
    return fileNotes.filter(
      (note) =>
        note.fileName.toLowerCase().includes(q) ||
        note.content.toLowerCase().includes(q),
    );
  }, [fileNotes, noteSearch]);

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
    for (const note of filteredNotes) {
      if (note.archived) continue;
      total += countOccurrences(note.content);
    }
    for (const fn of filteredFileNotes) {
      total += countOccurrences(fn.content);
    }
    return total;
  }, [noteSearch, filteredNotes, filteredFileNotes]);

  return {
    noteSearch,
    filteredNotes,
    filteredFileNotes,
    totalSearchMatches,
  };
};
