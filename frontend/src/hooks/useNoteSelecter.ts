import { useCallback } from 'react';
import type { Note, FileNote } from '../types';

interface NoteSelecterProps {
  handleSelectNote: (note: Note) => Promise<void>;
  handleSelectFileNote: (note: FileNote) => Promise<void>;
  notes: Note[];
  fileNotes: FileNote[];
  currentNote: Note | null;
  currentFileNote: FileNote | null;
  setCurrentNote: (note: Note | null) => void;
  setCurrentFileNote: (note: FileNote | null) => void;
  getOrCreateModel: (note: Note | FileNote) => void;
}

export const useNoteSelecter = ({ handleSelectNote, handleSelectFileNote, notes, fileNotes, currentNote, currentFileNote, setCurrentNote, setCurrentFileNote, getOrCreateModel }: NoteSelecterProps) => {
  // ノートを選択する
  const handleSelecAnyNote = useCallback(async (note: Note | FileNote) => {
    if ('filePath' in note) {
      await handleSelectFileNote(note);
      setCurrentNote(null);
    } else {
      await handleSelectNote(note);
      setCurrentFileNote(null);
    }
    getOrCreateModel(note);
  }, [handleSelectFileNote, handleSelectNote, setCurrentFileNote, setCurrentNote, getOrCreateModel]);

  // 次のノートを選択する
  const handleSelectNextAnyNote = useCallback(async () => {
    const activeNotes = notes.filter(note => !note.archived);

    // 全てのノートを一つの配列にまとめる
    const allNotes = [...activeNotes, ...fileNotes];
    if (allNotes.length === 0) return;

    // 現在のノートのインデックスを探す
    let currentIndex = -1;
    if (currentNote) {
      currentIndex = allNotes.findIndex(note => note.id === currentNote.id);
    } else if (currentFileNote) {
      currentIndex = allNotes.findIndex(note => note.id === currentFileNote.id);
    }

    // 次のノートを選択
    const nextIndex = (currentIndex + 1) % allNotes.length;
    await handleSelecAnyNote(allNotes[nextIndex]);
  }, [handleSelecAnyNote, currentFileNote, currentNote, fileNotes, notes]);

  // 前のノートを選択する
  const handleSelectPreviousAnyNote = useCallback(async () => {
    const activeNotes = notes.filter(note => !note.archived);

    // 全てのノートを一つの配列にまとめる
    const allNotes = [...activeNotes, ...fileNotes];
    if (allNotes.length === 0) return;

    // 現在のノートのインデックスを探す
    let currentIndex = -1;
    if (currentNote) {
      currentIndex = allNotes.findIndex(note => note.id === currentNote.id);
    } else if (currentFileNote) {
      currentIndex = allNotes.findIndex(note => note.id === currentFileNote.id);
    }

    // 前のノートを選択
    const previousIndex = (currentIndex - 1 + allNotes.length) % allNotes.length;
    await handleSelecAnyNote(allNotes[previousIndex]);
  }, [handleSelecAnyNote, currentFileNote, currentNote, fileNotes, notes]);

  return { handleSelecAnyNote, handleSelectNextAnyNote, handleSelectPreviousAnyNote };
}

