import { useCallback } from 'react';

import { SetLastActiveNote } from '../../wailsjs/go/backend/App';
import { useCurrentNoteStore } from '../stores/useCurrentNoteStore';
import { useFileNotesStore } from '../stores/useFileNotesStore';
import { useNotesStore } from '../stores/useNotesStore';

import type { FileNote, Note } from '../types';

interface NoteSelecterProps {
  handleSelectNote: (note: Note) => Promise<void>;
  handleSelectFileNote: (note: FileNote) => Promise<void>;
}

export const useNoteSelecter = ({
  handleSelectNote,
  handleSelectFileNote,
}: NoteSelecterProps) => {
  const setCurrentNote = useCurrentNoteStore((s) => s.setCurrentNote);
  const setCurrentFileNote = useCurrentNoteStore((s) => s.setCurrentFileNote);

  // ノートを選択する
  const handleSelecAnyNote = useCallback(
    async (note: Note | FileNote) => {
      const isFile = 'filePath' in note;
      if (isFile) {
        await handleSelectFileNote(note);
        setCurrentNote(null);
      } else {
        await handleSelectNote(note);
        setCurrentFileNote(null);
      }
      SetLastActiveNote(note.id, isFile);
    },
    [
      handleSelectFileNote,
      handleSelectNote,
      setCurrentFileNote,
      setCurrentNote,
    ],
  );

  // 次のノートを選択する
  const handleSelectNextAnyNote = useCallback(async () => {
    const notes = useNotesStore.getState().notes;
    const fileNotes = useFileNotesStore.getState().fileNotes;
    const activeNotes = notes.filter((note) => !note.archived);
    const allNotes = [...activeNotes, ...fileNotes];
    if (allNotes.length === 0) return;

    const { currentNote, currentFileNote } = useCurrentNoteStore.getState();
    let currentIndex = -1;
    if (currentNote) {
      currentIndex = allNotes.findIndex((note) => note.id === currentNote.id);
    } else if (currentFileNote) {
      currentIndex = allNotes.findIndex(
        (note) => note.id === currentFileNote.id,
      );
    }

    const nextIndex = (currentIndex + 1) % allNotes.length;
    await handleSelecAnyNote(allNotes[nextIndex]);
  }, [handleSelecAnyNote]);

  // 前のノートを選択する
  const handleSelectPreviousAnyNote = useCallback(async () => {
    const notes = useNotesStore.getState().notes;
    const fileNotes = useFileNotesStore.getState().fileNotes;
    const activeNotes = notes.filter((note) => !note.archived);
    const allNotes = [...activeNotes, ...fileNotes];
    if (allNotes.length === 0) return;

    const { currentNote, currentFileNote } = useCurrentNoteStore.getState();
    let currentIndex = -1;
    if (currentNote) {
      currentIndex = allNotes.findIndex((note) => note.id === currentNote.id);
    } else if (currentFileNote) {
      currentIndex = allNotes.findIndex(
        (note) => note.id === currentFileNote.id,
      );
    }

    const previousIndex =
      (currentIndex - 1 + allNotes.length) % allNotes.length;
    await handleSelecAnyNote(allNotes[previousIndex]);
  }, [handleSelecAnyNote]);

  return {
    handleSelecAnyNote,
    handleSelectNextAnyNote,
    handleSelectPreviousAnyNote,
  };
};
