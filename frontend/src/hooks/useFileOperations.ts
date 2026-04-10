import { useCallback, useEffect, useEffectEvent, useRef } from 'react';

import {
  GetModifiedTime,
  OpenFile,
  SaveFile,
  SaveNote,
  SelectFile,
  SelectSaveFileUri,
} from '../../wailsjs/go/backend/App';
import { backend } from '../../wailsjs/go/models';
import * as runtime from '../../wailsjs/runtime';
import i18n from '../i18n';
import { getExtensionByLanguage, getLanguageByExtension } from '../lib/monaco';
import { isBinaryFile } from '../utils/fileUtils';

import type { FileNote, Note } from '../types';

// ドロップ座標からエディタペインを判定する
const detectTargetPane = (x: number, y: number): 'left' | 'right' | null => {
  const elements = document.elementsFromPoint(x, y);
  for (const el of elements) {
    const paneEl = (el as HTMLElement).closest('[data-pane]');
    if (paneEl) {
      return paneEl.getAttribute('data-pane') as 'left' | 'right';
    }
  }
  return null;
};

export function useFileOperations(
  notes: Note[],
  setNotes: (notes: Note[]) => void,
  currentNote: Note | null,
  currentFileNote: FileNote | null,
  fileNotes: FileNote[],
  setFileNotes: (files: FileNote[]) => void,
  handleSelecAnyNote: (note: Note | FileNote) => Promise<void>,
  _showMessage: (
    title: string,
    message: string,
    isTwoButton?: boolean,
  ) => Promise<boolean>,
  handleSaveFileNotes: (fileNotes: FileNote[]) => Promise<void>,
  isSplitRef: React.RefObject<boolean>,
  openNoteInPaneRef: React.RefObject<
    ((note: Note | FileNote, pane: 'left' | 'right') => void) | null
  >,
  addRecentFileRef: React.RefObject<
    ((filePath: string) => Promise<void>) | null
  >,
  pendingContentRef: React.RefObject<string | null>,
) {
  // ファイルを開く共通処理
  const createFileNote = useCallback(
    async (
      content: string,
      filePath: string,
      sourceEncoding?: string,
    ): Promise<FileNote | null> => {
      if (isBinaryFile(content)) {
        runtime.EventsEmit('logMessage', i18n.t('file.binaryOpenError'));
        return null;
      }

      // エンコーディング変換が行われた場合、通知を表示
      if (sourceEncoding) {
        runtime.EventsEmit(
          'logMessage',
          i18n.t('file.encodingConverted', { encoding: sourceEncoding }),
        );
      }

      const extension = filePath.split('.').pop()?.toLowerCase() || '';
      const detectedLanguage = getLanguageByExtension(`.${extension}`);
      const language =
        typeof detectedLanguage?.id === 'string' && detectedLanguage.id !== ''
          ? detectedLanguage.id
          : 'plaintext';
      const fileName = filePath.split(/[/\\]/).pop() || '';

      const modifiedTime = await GetModifiedTime(filePath);

      const newFileNote: FileNote = {
        id: crypto.randomUUID(),
        filePath: filePath,
        fileName: fileName,
        content: content,
        originalContent: sourceEncoding ? '' : content,
        language: language,
        modifiedTime: modifiedTime.toString(),
      };

      return newFileNote;
    },
    [],
  );

  // ref経由で最新値を参照（effect外のハンドラからも参照するためref維持）
  const fileNotesRef = useRef(fileNotes);
  const handleSelecAnyNoteRef = useRef(handleSelecAnyNote);
  const setFileNotesRef = useRef(setFileNotes);
  const handleSaveFileNotesRef = useRef(handleSaveFileNotes);
  fileNotesRef.current = fileNotes;
  handleSelecAnyNoteRef.current = handleSelecAnyNote;
  setFileNotesRef.current = setFileNotes;
  handleSaveFileNotesRef.current = handleSaveFileNotes;

  // ファイルを開く
  const handleOpenFile = async () => {
    try {
      const filePath = await SelectFile();
      if (!filePath || Array.isArray(filePath)) return;

      // 既に同じファイルが開かれているかチェック
      const existingFile = fileNotes.find((note) => note.filePath === filePath);
      if (existingFile) {
        await handleSelecAnyNote(existingFile);
        return;
      }

      const result = await OpenFile(filePath);
      if (!result || typeof result.content !== 'string') return;

      const newFileNote = await createFileNote(
        result.content,
        filePath,
        result.sourceEncoding || undefined,
      );
      if (!newFileNote) return;

      const updatedFileNotes = [newFileNote, ...fileNotes];
      setFileNotes(updatedFileNotes);
      await handleSaveFileNotes(updatedFileNotes);
      await handleSelecAnyNote(newFileNote);
      addRecentFileRef.current?.(filePath);
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  // ファイルをドラッグアンドドロップする（ref経由で依存を安定化）
  const handleFileDrop = useCallback(
    async (filePath: string, targetPane?: 'left' | 'right') => {
      try {
        if (!filePath) return;

        // 既に同じファイルが開かれているかチェック
        const existingFile = fileNotesRef.current.find(
          (note) => note.filePath === filePath,
        );
        if (existingFile) {
          await handleSelecAnyNoteRef.current(existingFile);
          return;
        }

        const result = await OpenFile(filePath);
        if (!result || typeof result.content !== 'string') return;

        const newFileNote = await createFileNote(
          result.content,
          filePath,
          result.sourceEncoding || undefined,
        );
        if (!newFileNote) return;

        const updatedFileNotes = [newFileNote, ...fileNotesRef.current];
        setFileNotesRef.current(updatedFileNotes);
        await handleSaveFileNotesRef.current(updatedFileNotes);

        if (targetPane && isSplitRef.current && openNoteInPaneRef.current) {
          openNoteInPaneRef.current(newFileNote, targetPane);
        } else {
          await handleSelecAnyNoteRef.current(newFileNote);
        }
        addRecentFileRef.current?.(filePath);
      } catch (error) {
        console.error('Failed to handle dropped file:', error);
      }
    },
    [createFileNote, isSplitRef, openNoteInPaneRef, addRecentFileRef],
  );

  // パスを指定してファイルを開く（最近開いたファイル用）
  const handleOpenFileByPath = async (filePath: string) => {
    try {
      if (!filePath) return;

      // 既に同じファイルが開かれているかチェック
      const existingFile = fileNotes.find((note) => note.filePath === filePath);
      if (existingFile) {
        await handleSelecAnyNote(existingFile);
        return;
      }

      const result = await OpenFile(filePath);
      if (!result || typeof result.content !== 'string') return;

      const newFileNote = await createFileNote(
        result.content,
        filePath,
        result.sourceEncoding || undefined,
      );
      if (!newFileNote) return;

      const updatedFileNotes = [newFileNote, ...fileNotes];
      setFileNotes(updatedFileNotes);
      await handleSaveFileNotes(updatedFileNotes);
      await handleSelecAnyNote(newFileNote);
      addRecentFileRef.current?.(filePath);
    } catch (error) {
      console.error('Failed to open file by path:', error);
    }
  };

  // ファイルをエクスポートする
  const handleSaveAsFile = async () => {
    try {
      // pendingContentRefから最新のコンテンツを取得（Noteのコンテンツ変更はpendingContentRefに
      // 保持され、currentNote.contentには反映されないため）
      const latestNoteContent = currentNote
        ? (pendingContentRef.current ?? currentNote.content)
        : null;
      const latestContent = latestNoteContent || currentFileNote?.content;

      if (!latestContent || latestContent === '') return;

      const saveNote = currentNote || currentFileNote;
      if (!saveNote) return;

      const extension = currentFileNote
        ? ''
        : getExtensionByLanguage(saveNote.language) || 'txt';
      const title = 'title' in saveNote ? saveNote.title : saveNote.fileName;
      const filePath = await SelectSaveFileUri(title, extension);
      if (!filePath || Array.isArray(filePath)) return;

      await SaveFile(filePath, latestContent);
    } catch (error) {
      console.error('Failed to save file:', error);
      runtime.EventsEmit('logMessage', i18n.t('file.saveAsFailed'));
    }
  };

  // ファイルを保存する
  const handleSaveFile = async (fileNote: FileNote) => {
    try {
      if (!fileNote.content) return;
      await SaveFile(fileNote.filePath, fileNote.content);
      const savedContent = fileNote.content;
      const savedTime = new Date().toISOString();
      // refから最新のfileNotesを取得して更新する（await中にユーザーが編集した場合、
      // クロージャの古いfileNotesで上書きしてしまうのを防ぐ）
      const updatedFileNotes = fileNotesRef.current.map((note) =>
        note.id === fileNote.id
          ? { ...note, originalContent: savedContent, modifiedTime: savedTime }
          : note,
      );
      setFileNotes(updatedFileNotes);
      await handleSaveFileNotes(updatedFileNotes);
    } catch (error) {
      console.error('Failed to save file:', error);
      runtime.EventsEmit('logMessage', i18n.t('file.saveFailedKeepChanges'));
    }
  };

  // ファイルをメモに変換する
  const handleConvertToNote = async (fileNote: FileNote) => {
    const newNote: Note = {
      id: crypto.randomUUID(),
      title: fileNote.fileName.replace(/\.[^/.]+$/, ''),
      content: fileNote.content,
      contentHeader: null,
      language: fileNote.language,
      modifiedTime: new Date().toISOString(),
      archived: false,
    };

    setNotes([newNote, ...notes]);
    const updatedFileNotes = fileNotes.filter((f) => f.id !== fileNote.id);
    setFileNotes(updatedFileNotes);
    await handleSaveFileNotes(updatedFileNotes);
    await SaveNote(backend.Note.createFrom(newNote), 'create');
    await handleSelecAnyNote(newNote);
  };

  // useEffectEvent経由でイベントハンドラの再登録を防止
  const onOpenExternal = useEffectEvent(
    async (data: {
      path: string;
      content: string;
      sourceEncoding?: string;
    }) => {
      // 既に同じファイルが開かれているかチェック
      const existingFile = fileNotesRef.current.find(
        (note) => note.filePath === data.path,
      );
      if (existingFile) {
        // 外部からの再オープン時はダイアログなしで最新内容に更新する
        const modifiedTime = await GetModifiedTime(data.path);
        const updatedFile: FileNote = {
          ...existingFile,
          content: data.content,
          originalContent: data.sourceEncoding ? '' : data.content,
          modifiedTime: modifiedTime.toString(),
        };
        const updatedFileNotes = fileNotesRef.current.map((note) =>
          note.id === existingFile.id ? updatedFile : note,
        );
        setFileNotesRef.current(updatedFileNotes);
        await handleSaveFileNotesRef.current(updatedFileNotes);
        await handleSelecAnyNoteRef.current(updatedFile);
        return;
      }

      const newFileNote = await createFileNote(
        data.content,
        data.path,
        data.sourceEncoding || undefined,
      );
      if (!newFileNote) return;

      const updatedFileNotes = [newFileNote, ...fileNotesRef.current];
      setFileNotesRef.current(updatedFileNotes);
      await handleSaveFileNotesRef.current(updatedFileNotes);

      if (isSplitRef.current && openNoteInPaneRef.current) {
        openNoteInPaneRef.current(newFileNote, 'left');
      } else {
        await handleSelecAnyNoteRef.current(newFileNote);
      }
      addRecentFileRef.current?.(data.path);
    },
  );

  const onFileDrop = useEffectEvent(
    async (x: number, y: number, paths: string[]) => {
      if (paths.length > 0) {
        const file = paths[0];
        if (file) {
          const targetPane = isSplitRef.current
            ? (detectTargetPane(x, y) ?? 'left')
            : undefined;
          await handleFileDrop(file, targetPane);
        }
      }
    },
  );

  useEffect(() => {
    const cleanup = runtime.EventsOn('file:open-external', onOpenExternal);

    runtime.OnFileDrop(async (x, y, paths) => {
      await onFileDrop(x, y, paths);
    }, true);

    return () => {
      cleanup();
      runtime.OnFileDropOff();
    };
  }, []);

  const handleCloseFile = async (note: FileNote) => {
    const updatedFileNotes = fileNotes.filter((f) => f.id !== note.id);
    setFileNotes(updatedFileNotes);
    await handleSaveFileNotes(updatedFileNotes);
    if (notes.length > 0) {
      await handleSelecAnyNote(notes[0]);
    }
  };

  return {
    handleOpenFile,
    handleOpenFileByPath,
    handleSaveFile,
    handleSaveAsFile,
    handleConvertToNote,
    handleFileDrop,
    handleCloseFile,
  };
}
