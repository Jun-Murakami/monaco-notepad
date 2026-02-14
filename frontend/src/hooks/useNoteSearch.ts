import { useCallback, useMemo, useState } from 'react';
import type { FileNote, Note, TopLevelItem } from '../types';

type SearchMatch = {
  note: Note | FileNote;
  matchIndexInNote: number;
};

interface UseNoteSearchProps {
  notes: Note[];
  fileNotes: FileNote[];
  topLevelOrder: TopLevelItem[];
  isSplit: boolean;
  onSelectInSplit: (note: Note | FileNote) => Promise<void>;
  onSelectSingle: (note: Note | FileNote) => Promise<void>;
}

export const useNoteSearch = ({
  notes,
  fileNotes,
  topLevelOrder,
  isSplit,
  onSelectInSplit,
  onSelectSingle,
}: UseNoteSearchProps) => {
  const [noteSearch, setNoteSearch] = useState('');
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);

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

  const { globalMatches, totalSearchMatches } = useMemo(() => {
    if (!noteSearch)
      return { globalMatches: [] as SearchMatch[], totalSearchMatches: 0 };

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

    const activeFiltered = filteredNotes.filter((n) => !n.archived);
    const filteredNoteSet = new Set(activeFiltered.map((n) => n.id));
    const filteredNoteMap = new Map(activeFiltered.map((n) => [n.id, n]));
    const orderedNotes: (Note | FileNote)[] = [...filteredFileNotes];
    for (const item of topLevelOrder) {
      if (item.type === 'note') {
        if (filteredNoteSet.has(item.id)) {
          const note = filteredNoteMap.get(item.id);
          if (note) orderedNotes.push(note);
        }
      } else if (item.type === 'folder') {
        const folderNotes = activeFiltered.filter(
          (n) => n.folderId === item.id,
        );
        orderedNotes.push(...folderNotes);
      }
    }

    const matches: SearchMatch[] = [];
    for (const note of orderedNotes) {
      const matchCount = countOccurrences(note.content);
      for (let i = 0; i < matchCount; i++) {
        matches.push({ note, matchIndexInNote: i });
      }
    }

    return { globalMatches: matches, totalSearchMatches: matches.length };
  }, [noteSearch, filteredNotes, filteredFileNotes, topLevelOrder]);

  const handleSearchChange = useCallback((value: string) => {
    setNoteSearch(value);
    setSearchMatchIndex(value ? 1 : 0);
  }, []);

  const handleSearchNavigate = useCallback(
    (direction: 'next' | 'prev') => {
      if (totalSearchMatches === 0) return;

      let newIndex = searchMatchIndex;
      if (direction === 'next') {
        newIndex =
          searchMatchIndex >= totalSearchMatches ? 1 : searchMatchIndex + 1;
      } else {
        newIndex =
          searchMatchIndex <= 1 ? totalSearchMatches : searchMatchIndex - 1;
      }

      setSearchMatchIndex(newIndex);
      const match = globalMatches[newIndex - 1];
      if (!match) return;

      if (isSplit) {
        void onSelectInSplit(match.note);
      } else {
        void onSelectSingle(match.note);
      }
    },
    [
      totalSearchMatches,
      searchMatchIndex,
      globalMatches,
      isSplit,
      onSelectInSplit,
      onSelectSingle,
    ],
  );

  const searchMatchIndexInNote = useMemo(() => {
    if (totalSearchMatches === 0 || searchMatchIndex === 0) return 0;
    const match = globalMatches[searchMatchIndex - 1];
    return match ? match.matchIndexInNote : 0;
  }, [globalMatches, searchMatchIndex, totalSearchMatches]);

  return {
    noteSearch,
    searchMatchIndex,
    filteredNotes,
    filteredFileNotes,
    totalSearchMatches,
    searchMatchIndexInNote,
    handleSearchChange,
    handleSearchNavigate,
  };
};
