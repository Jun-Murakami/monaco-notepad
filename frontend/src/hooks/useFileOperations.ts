import { useCallback, useEffect } from 'react';
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
import type { FileNote, Note } from '../types';
import { isBinaryFile } from '../utils/fileUtils';

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
  showMessage: (
    title: string,
    message: string,
    isTwoButton?: boolean,
  ) => Promise<boolean>,
  handleSaveFileNotes: (fileNotes: FileNote[]) => Promise<void>,
  isSplitRef: React.RefObject<boolean>,
  openNoteInPaneRef: React.RefObject<
    ((note: Note | FileNote, pane: 'left' | 'right') => void) | null
  >,
) {
  // ファイルを開く共通処理
  const createFileNote = useCallback(
    async (content: string, filePath: string): Promise<FileNote | null> => {
      if (isBinaryFile(content)) {
        runtime.EventsEmit(
          'logMessage',
          i18n.t('file.binaryOpenError'),
        );
        return null;
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
        originalContent: content,
        language: language,
        modifiedTime: modifiedTime.toString(),
      };

      return newFileNote;
    },
    [],
  );

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

      const content = await OpenFile(filePath);
      if (typeof content !== 'string') return;

      const newFileNote = await createFileNote(content, filePath);
      if (!newFileNote) return;

      const updatedFileNotes = [newFileNote, ...fileNotes];
      setFileNotes(updatedFileNotes);
      await handleSaveFileNotes(updatedFileNotes);
      await handleSelecAnyNote(newFileNote);
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  // ファイルをドラッグアンドドロップする
  const handleFileDrop = useCallback(
    async (filePath: string, targetPane?: 'left' | 'right') => {
      try {
        if (!filePath) return;

        // 既に同じファイルが開かれているかチェック
        const existingFile = fileNotes.find(
          (note) => note.filePath === filePath,
        );
        if (existingFile) {
          await handleSelecAnyNote(existingFile);
          return;
        }

        const content = await OpenFile(filePath);
        if (typeof content !== 'string') return;

        const newFileNote = await createFileNote(content, filePath);
        if (!newFileNote) return;

        const updatedFileNotes = [newFileNote, ...fileNotes];
        setFileNotes(updatedFileNotes);
        await handleSaveFileNotes(updatedFileNotes);

        if (targetPane && isSplitRef.current && openNoteInPaneRef.current) {
          openNoteInPaneRef.current(newFileNote, targetPane);
        } else {
          await handleSelecAnyNote(newFileNote);
        }
      } catch (error) {
        console.error('Failed to handle dropped file:', error);
      }
    },
    [
      fileNotes,
      createFileNote,
      setFileNotes,
      handleSaveFileNotes,
      handleSelecAnyNote,
      isSplitRef,
      openNoteInPaneRef,
    ],
  );

  // ファイルをエクスポートする
  const handleSaveAsFile = async () => {
    try {
      if (
        (!currentNote?.content || currentNote.content === '') &&
        (!currentFileNote?.content || currentFileNote.content === '')
      )
        return;

      const saveNote = currentNote || currentFileNote;
      if (!saveNote) return;

      const extension = currentFileNote
        ? ''
        : getExtensionByLanguage(saveNote.language) || 'txt';
      const title = 'title' in saveNote ? saveNote.title : saveNote.fileName;
      const filePath = await SelectSaveFileUri(title, extension);
      if (!filePath || Array.isArray(filePath)) return;

      if (saveNote.content) {
        await SaveFile(filePath, saveNote.content);
      }
    } catch (error) {
      console.error('Failed to save file:', error);
      runtime.EventsEmit(
        'logMessage',
        i18n.t('file.saveAsFailed'),
      );
    }
  };

  // ファイルを保存する
  const handleSaveFile = async (fileNote: FileNote) => {
    try {
      if (!fileNote.content) return;
      await SaveFile(fileNote.filePath, fileNote.content);
      const updatedFileNote = {
        ...fileNote,
        originalContent: fileNote.content,
        modifiedTime: new Date().toISOString(),
      };
      const updatedFileNotes = fileNotes.map((note) =>
        note.id === updatedFileNote.id ? updatedFileNote : note,
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

  useEffect(() => {
    const cleanup = runtime.EventsOn(
      'file:open-external',
      async (data: { path: string; content: string }) => {
        // 既に同じファイルが開かれているかチェック
        const existingFile = fileNotes.find(
          (note) => note.filePath === data.path,
        );
        if (existingFile) {
          await handleSelecAnyNote(existingFile);
          return;
        }

        const newFileNote = await createFileNote(data.content, data.path);
        if (!newFileNote) return;

        const updatedFileNotes = [newFileNote, ...fileNotes];
        setFileNotes(updatedFileNotes);
        await handleSaveFileNotes(updatedFileNotes);

        if (isSplitRef.current && openNoteInPaneRef.current) {
          openNoteInPaneRef.current(newFileNote, 'left');
        } else {
          await handleSelecAnyNote(newFileNote);
        }
      },
    );

    runtime.OnFileDrop(async (x, y, paths) => {
      if (paths.length > 0) {
        const file = paths[0];
        if (file) {
          const targetPane = isSplitRef.current
            ? (detectTargetPane(x, y) ?? 'left')
            : undefined;
          await handleFileDrop(file, targetPane);
        }
      }
    }, true);

    return () => {
      cleanup();
      runtime.OnFileDropOff();
    };
  }, [
    fileNotes,
    handleSelecAnyNote,
    setFileNotes,
    handleSaveFileNotes,
    handleFileDrop,
    createFileNote,
    isSplitRef,
    openNoteInPaneRef,
  ]);

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
    handleSaveFile,
    handleSaveAsFile,
    handleConvertToNote,
    handleFileDrop,
    handleCloseFile,
  };
}
