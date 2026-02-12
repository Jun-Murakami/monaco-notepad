import { useCallback, useEffect, useState } from 'react';
import {
  ApplyIntegrityFixes,
  GetArchivedTopLevelOrder,
  GetTopLevelOrder,
  ListFolders,
  ListNotes,
  LoadFileNotes,
  NotifyFrontendReady,
} from '../../wailsjs/go/backend/App';
import * as runtime from '../../wailsjs/runtime';
import { getSupportedLanguages, type LanguageInfo } from '../lib/monaco';
import type {
  FileNote,
  Folder,
  IntegrityFixSelection,
  IntegrityIssue,
  Note,
  TopLevelItem,
} from '../types';

export const useInitialize = (
  setNotes: (notes: Note[]) => void,
  setFileNotes: (files: FileNote[]) => void,
  setFolders: (folders: Folder[]) => void,
  setTopLevelOrder: (order: TopLevelItem[]) => void,
  setArchivedTopLevelOrder: (order: TopLevelItem[]) => void,
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
  showMessage: (
    title: string,
    message: string,
    isTwoButton?: boolean,
    primaryButtonText?: string,
    secondaryButtonText?: string,
  ) => Promise<boolean>,
  restorePaneNotes: (notes: Note[], fileNotes: FileNote[]) => void,
) => {
  const [languages, setLanguages] = useState<LanguageInfo[]>([]);
  const [platform, setPlatform] = useState<string>('');
  const [isInitialized, setIsInitialized] = useState(false);

  const initialNortLoader = useCallback(async () => {
    // ファイルノート一覧を取得
    const fileNotes = await LoadFileNotes();
    const loadedFileNotes = fileNotes.map((file) => ({
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

    const [notes, folders, rawOrder, rawArchivedOrder] = await Promise.all([
      ListNotes(),
      ListFolders(),
      GetTopLevelOrder(),
      GetArchivedTopLevelOrder(),
    ]);
    setFolders(folders ?? []);
    setTopLevelOrder(
      (rawOrder ?? []).map((item) => ({
        type: item.type as 'note' | 'folder',
        id: item.id,
      })),
    );
    setArchivedTopLevelOrder(
      (rawArchivedOrder ?? []).map((item) => ({
        type: item.type as 'note' | 'folder',
        id: item.id,
      })),
    );
    if (!notes) {
      setNotes([]);
      handleNewNote();
      return;
    }
    const parsedNotes = notes.map((note) => ({
      ...note,
      modifiedTime: note.modifiedTime.toString(),
    }));
    setNotes(parsedNotes);
    const activeNotes = parsedNotes.filter((note) => !note.archived);
    if (loadedFileNotes.length > 0) {
      await handleSelecAnyNote(loadedFileNotes[0]);
    } else if (activeNotes.length > 0) {
      await handleSelecAnyNote(activeNotes[0]);
    } else {
      handleNewNote();
    }
    restorePaneNotes(parsedNotes, loadedFileNotes);
  }, [
    handleNewNote,
    handleSelecAnyNote,
    setFileNotes,
    setFolders,
    setTopLevelOrder,
    setArchivedTopLevelOrder,
    setNotes,
    restorePaneNotes,
  ]);

  useEffect(() => {
    const handleIntegrityIssues = async (issues: IntegrityIssue[]) => {
      if (!issues || issues.length === 0) {
        return;
      }

      const selections: IntegrityFixSelection[] = [];

      for (const issue of issues) {
        if (!issue.needsUserDecision) {
          continue;
        }

        if (!issue.fixOptions || issue.fixOptions.length < 2) {
          await showMessage('Notice', issue.summary, false, 'OK');
          continue;
        }

        const primary = issue.fixOptions[0];
        const secondary = issue.fixOptions[1];
        const confirmed = await showMessage(
          'Unknown file',
          issue.summary,
          true,
          primary.label,
          secondary.label,
        );
        selections.push({
          issueId: issue.id,
          fixId: confirmed ? primary.id : secondary.id,
        });
      }

      if (selections.length > 0) {
        try {
          await ApplyIntegrityFixes(selections);
        } catch (error) {
          console.error('Failed to apply integrity fixes:', error);
        }
      }
    };

    runtime.EventsOn('notes:integrity-issues', handleIntegrityIssues);
    return () => {
      runtime.EventsOff('notes:integrity-issues');
    };
  }, [showMessage]);

  useEffect(() => {
    if (isInitialized) return;
    const asyncFunc = async () => {
      try {
        // プラットフォームを取得
        const env = await runtime.Environment();
        setPlatform(env.platform);

        // 言語一覧を取得
        setLanguages(getSupportedLanguages());

        await initialNortLoader();
      } catch (_error) {
        setNotes([]);
        handleNewNote();
      }
    };
    asyncFunc();

    // DomReadyはuseEffectより先に完了するため、直接通知
    NotifyFrontendReady();

    setIsInitialized(true);
  }, [initialNortLoader, isInitialized, handleNewNote, setNotes]);

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
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === 's'
      ) {
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
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === 'tab'
      ) {
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
