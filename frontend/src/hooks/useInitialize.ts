import { useEffect, useState, useCallback } from 'react';
import { ListNotes, LoadFileNotes } from '../../wailsjs/go/backend/App';
import { getSupportedLanguages, type LanguageInfo } from '../lib/monaco';
import * as runtime from '../../wailsjs/runtime';
import type { Note, FileNote } from '../types';

export const useInitialize = (
  setNotes: (notes: Note[]) => void,
  setFileNotes: (files: FileNote[]) => void,
  handleNewNote: () => void,
  handleSelecAnyNote: (note: Note | FileNote) => Promise<void>,
  currentFileNote: FileNote | null,
  setCurrentFileNote: (file: FileNote | null) => void,
  handleSaveFile: (file: FileNote) => Promise<void>,
  handleOpenFile: () => Promise<void>,
  handleCloseFile: (file: FileNote) => Promise<void>,
  isFileModified: (fileId: string) => boolean,
  currentNote: Note | null,
  handleArchiveNote: (noteId: string) => Promise<void>,
  handleSaveAsFile: () => Promise<void>,
  handleSelectNextAnyNote: () => Promise<void>,
  handleSelectPreviousAnyNote: () => Promise<void>,
) => {
  const [languages, setLanguages] = useState<LanguageInfo[]>([]);
  const [platform, setPlatform] = useState<string>('');

  const initialNortLoader = useCallback(async () => {
    try {
      // ファイルノート一覧を取得
      const fileNotes = await LoadFileNotes();
      const loadedFileNotes = fileNotes.map(file => ({
        id: file.id,
        filePath: file.filePath,
        fileName: file.fileName,
        content: file.content,
        originalContent: file.content,
        language: file.language,
        modifiedTime: file.modifiedTime.toString(),
      }));
      if (loadedFileNotes.length > 0) {
        setFileNotes(loadedFileNotes);
      }

      // ノート一覧を取得
      const notes = await ListNotes();
      if (!notes) {
        setNotes([]);
        handleNewNote();
        return;
      }
      const parsedNotes = notes.map(note => ({
        ...note,
        modifiedTime: note.modifiedTime.toString(),
      }));
      setNotes(parsedNotes);
      if (!currentNote) {
        const activeNotes = parsedNotes.filter((note) => !note.archived);
        if (loadedFileNotes.length > 0) {
          await handleSelecAnyNote(loadedFileNotes[0]);
        } else if (activeNotes.length > 0) {
          await handleSelecAnyNote(activeNotes[0]);
        } else {
          handleNewNote();
        }
      }
    } catch (error) {
      setNotes([]);
      handleNewNote();
    }
  }, [handleNewNote, handleSelecAnyNote, setFileNotes, setNotes, currentNote]);

  useEffect(() => {
    const asyncFunc = async () => {
      // プラットフォームを取得
      const env = await runtime.Environment();
      setPlatform(env.platform);

      // 言語一覧を取得
      setLanguages(getSupportedLanguages());

      // ノート一覧を取得
      await initialNortLoader();
    };
    // 初期化処理を実行
    asyncFunc();
  }, [initialNortLoader]);

  // グローバルキーボードショートカット
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Ctrl/Cmd + N
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setCurrentFileNote(null);
        handleNewNote();
      }

      // Ctrl/Cmd + O
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        await handleOpenFile();
      }

      // Ctrl/Cmd + S
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (currentFileNote && isFileModified(currentFileNote.id)) {
          await handleSaveFile(currentFileNote);
        }
      }

      // Ctrl/Cmd + Alt + S
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (currentNote || currentFileNote) {
          await handleSaveAsFile();
        }
      }

      // Ctrl/Cmd + W
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        if (currentFileNote) {
          await handleCloseFile(currentFileNote);
        } else if (currentNote) {
          await handleArchiveNote(currentNote.id);
        }
      }

      // Ctrl/Cmd + Tab
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'tab') {
        e.preventDefault();
        await handleSelectNextAnyNote();
      }

      // Ctrl/Cmd + Shift + Tab
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'tab') {
        e.preventDefault();
        await handleSelectPreviousAnyNote();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    currentFileNote,
    currentNote,
    handleSaveFile,
    handleCloseFile,
    handleArchiveNote,
    handleSaveAsFile,
    isFileModified,
    handleNewNote,
    handleOpenFile,
    handleSelectNextAnyNote,
    handleSelectPreviousAnyNote,
    setCurrentFileNote,
  ]);

  return {
    languages,
    platform,
  };
}; 