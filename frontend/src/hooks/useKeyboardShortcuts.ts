import { useRef } from 'react';
import { useHotkeys } from '@tanstack/react-hotkeys';

import type { FileNote, Note } from '../types';

interface UseKeyboardShortcutsProps {
  currentNote: Note | null;
  currentFileNote: FileNote | null;
  setCurrentFileNote: (file: FileNote | null) => void;
  handleNewNote: () => void;
  handleOpenFile: () => Promise<void>;
  handleSaveFile: (file: FileNote) => Promise<void>;
  handleSaveAsFile: () => Promise<void>;
  handleCloseFile: (file: FileNote) => Promise<void>;
  handleArchiveNote: (noteId: string) => Promise<void>;
  handleSelectNextAnyNote: () => Promise<void>;
  handleSelectPreviousAnyNote: () => Promise<void>;
  isFileModified: (fileId: string) => boolean;
  // 検索・置換パネル
  onOpenFind: () => void;
  onOpenReplace: () => void;
  onOpenFindInAll: () => void;
}

export const useKeyboardShortcuts = ({
  currentNote,
  currentFileNote,
  setCurrentFileNote,
  handleNewNote,
  handleOpenFile,
  handleSaveFile,
  handleSaveAsFile,
  handleCloseFile,
  handleArchiveNote,
  handleSelectNextAnyNote,
  handleSelectPreviousAnyNote,
  isFileModified,
  onOpenFind,
  onOpenReplace,
  onOpenFindInAll,
}: UseKeyboardShortcutsProps) => {
  // ref経由で最新値を参照し、コールバックの再生成を防止
  const currentFileNoteRef = useRef(currentFileNote);
  const currentNoteRef = useRef(currentNote);
  const setCurrentFileNoteRef = useRef(setCurrentFileNote);
  const handleNewNoteRef = useRef(handleNewNote);
  const handleOpenFileRef = useRef(handleOpenFile);
  const handleSaveFileRef = useRef(handleSaveFile);
  const handleSaveAsFileRef = useRef(handleSaveAsFile);
  const handleCloseFileRef = useRef(handleCloseFile);
  const handleArchiveNoteRef = useRef(handleArchiveNote);
  const handleSelectNextAnyNoteRef = useRef(handleSelectNextAnyNote);
  const handleSelectPreviousAnyNoteRef = useRef(handleSelectPreviousAnyNote);
  const isFileModifiedRef = useRef(isFileModified);
  const onOpenFindRef = useRef(onOpenFind);
  const onOpenReplaceRef = useRef(onOpenReplace);
  const onOpenFindInAllRef = useRef(onOpenFindInAll);
  currentFileNoteRef.current = currentFileNote;
  currentNoteRef.current = currentNote;
  setCurrentFileNoteRef.current = setCurrentFileNote;
  handleNewNoteRef.current = handleNewNote;
  handleOpenFileRef.current = handleOpenFile;
  handleSaveFileRef.current = handleSaveFile;
  handleSaveAsFileRef.current = handleSaveAsFile;
  handleCloseFileRef.current = handleCloseFile;
  handleArchiveNoteRef.current = handleArchiveNote;
  handleSelectNextAnyNoteRef.current = handleSelectNextAnyNote;
  handleSelectPreviousAnyNoteRef.current = handleSelectPreviousAnyNote;
  isFileModifiedRef.current = isFileModified;
  onOpenFindRef.current = onOpenFind;
  onOpenReplaceRef.current = onOpenReplace;
  onOpenFindInAllRef.current = onOpenFindInAll;

  useHotkeys([
    {
      hotkey: 'Mod+N',
      callback: () => {
        setCurrentFileNoteRef.current(null);
        handleNewNoteRef.current();
      },
    },
    {
      hotkey: 'Mod+O',
      callback: () => {
        void handleOpenFileRef.current();
      },
    },
    {
      hotkey: 'Mod+S',
      callback: () => {
        const fileNote = currentFileNoteRef.current;
        if (fileNote && isFileModifiedRef.current(fileNote.id)) {
          void handleSaveFileRef.current(fileNote);
        }
      },
    },
    {
      hotkey: 'Mod+Alt+S',
      callback: () => {
        if (currentNoteRef.current || currentFileNoteRef.current) {
          void handleSaveAsFileRef.current();
        }
      },
    },
    {
      hotkey: 'Mod+W',
      callback: () => {
        const fileNote = currentFileNoteRef.current;
        const note = currentNoteRef.current;
        if (fileNote) {
          void handleCloseFileRef.current(fileNote);
        } else if (note) {
          void handleArchiveNoteRef.current(note.id);
        }
      },
    },
    {
      hotkey: 'Mod+Tab',
      callback: () => {
        void handleSelectNextAnyNoteRef.current();
      },
    },
    {
      hotkey: 'Mod+Shift+Tab',
      callback: () => {
        void handleSelectPreviousAnyNoteRef.current();
      },
    },
    // エディタ外から押された場合のフォールバック（エディタ内ではEditor.tsxの addCommand が先に拾う）
    {
      hotkey: 'Mod+F',
      callback: () => {
        onOpenFindRef.current();
      },
    },
    {
      hotkey: 'Mod+H',
      callback: () => {
        onOpenReplaceRef.current();
      },
    },
    {
      hotkey: 'Mod+Shift+F',
      callback: () => {
        onOpenFindInAllRef.current();
      },
    },
  ]);
};
