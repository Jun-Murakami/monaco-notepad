import { getLanguageByExtension, getExtensionByLanguage } from '../lib/monaco';
import { SelectFile, OpenFile, SaveFile, SelectSaveFileUri, GetModifiedTime, } from '../../wailsjs/go/backend/App';
import { Note, FileNote } from '../types';
import { useEffect, useCallback } from 'react';
import { isBinaryFile } from '../utils/fileUtils';
import * as runtime from '../../wailsjs/runtime';

export function useFileOperations(
  notes: Note[],
  setNotes: (notes: Note[]) => void,
  currentNote: Note | null,
  currentFileNote: FileNote | null,
  fileNotes: FileNote[],
  setFileNotes: (files: FileNote[]) => void,
  handleNoteSelect: (note: Note | FileNote, isNew?: boolean) => Promise<void>,
  showMessage: (title: string, message: string, isTwoButton?: boolean) => Promise<boolean>,
  handleSaveFileNotes: (fileNotes: FileNote[]) => Promise<void>
) {
  // ファイルを開く共通処理
  const createFileNote = useCallback(async (content: string, filePath: string): Promise<FileNote | null> => {
    if (isBinaryFile(content)) {
      showMessage('Error', 'Failed to open the file. Please check the file format.');
      return null;
    }

    const extension = filePath.split('.').pop()?.toLowerCase() || '';
    const detectedLanguage = getLanguageByExtension('.' + extension);
    const language = typeof detectedLanguage?.id === 'string' && detectedLanguage.id !== '' ? detectedLanguage.id : 'plaintext';
    const fileName = filePath.split(/[/\\]/).pop() || '';

    const modifiedTime = await GetModifiedTime(filePath);

    const newFileNote: FileNote = {
      id: crypto.randomUUID(),
      filePath: filePath,
      fileName: fileName,
      content: content,
      originalContent: content,
      language: language,
      modifiedTime: modifiedTime,
    };

    return newFileNote;
  }, [showMessage]);

  // ファイルを開く
  const handleOpenFile = async () => {
    try {
      const filePath = await SelectFile();
      if (!filePath || Array.isArray(filePath)) return;

      // 既に同じファイルが開かれているかチェック
      const existingFile = fileNotes.find(note => note.filePath === filePath);
      if (existingFile) {
        await handleNoteSelect(existingFile);
        return;
      }

      const content = await OpenFile(filePath);
      if (typeof content !== 'string') return;

      const newFileNote = await createFileNote(content, filePath);
      if (!newFileNote) return;

      const updatedFileNotes = [newFileNote, ...fileNotes];
      setFileNotes(updatedFileNotes);
      await handleSaveFileNotes(updatedFileNotes);
      await handleNoteSelect(newFileNote);
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  // ファイルをドラッグアンドドロップする
  const handleFileDrop = useCallback(async (filePath: string) => {
    try {
      if (!filePath) return;

      // 既に同じファイルが開かれているかチェック
      const existingFile = fileNotes.find(note => note.filePath === filePath);
      if (existingFile) {
        await handleNoteSelect(existingFile);
        return;
      }

      const content = await OpenFile(filePath);
      if (typeof content !== 'string') return;

      const newFileNote = await createFileNote(content, filePath);
      if (!newFileNote) return;

      const updatedFileNotes = [newFileNote, ...fileNotes];
      setFileNotes(updatedFileNotes);
      await handleSaveFileNotes(updatedFileNotes);
      await handleNoteSelect(newFileNote);
    } catch (error) {
      console.error('Failed to handle dropped file:', error);
    }
  }, [fileNotes, createFileNote, setFileNotes, handleSaveFileNotes, handleNoteSelect, showMessage]);

  // ファイルをエクスポートする
  const handleSaveAsFile = async () => {
    try {
      if ((!currentNote?.content || currentNote.content === '')
        && (!currentFileNote?.content || currentFileNote.content === '')) return;

      const saveNote = currentNote || currentFileNote;
      if (!saveNote) return;

      const extension = getExtensionByLanguage(saveNote.language) || 'txt';
      const title = 'title' in saveNote ? saveNote.title : saveNote.fileName;
      const filePath = await SelectSaveFileUri(title, extension);
      if (!filePath || Array.isArray(filePath)) return;

      if (saveNote.content) {
        await SaveFile(filePath, saveNote.content);
      }
    } catch (error) {
      console.error('Failed to save file:', error);
      showMessage('Error', 'Failed to save the file.');
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
      const updatedFileNotes = fileNotes.map(note =>
        note.id === updatedFileNote.id ? updatedFileNote : note
      );
      setFileNotes(updatedFileNotes);
      await handleSaveFileNotes(updatedFileNotes);
    } catch (error) {
      console.error('Failed to save file:', error);
      showMessage('Error', 'Failed to save the file.');
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
    const updatedFileNotes = fileNotes.filter(f => f.id !== fileNote.id);
    setFileNotes(updatedFileNotes);
    await handleSaveFileNotes(updatedFileNotes);
    await handleNoteSelect(newNote);
  };


  useEffect(() => {
    const cleanup = runtime.EventsOn('file:open-external', async (data: { path: string, content: string }) => {
      const newFileNote = await createFileNote(data.content, data.path);
      if (!newFileNote) return;

      const updatedFileNotes = [newFileNote, ...fileNotes];
      setFileNotes(updatedFileNotes);
      await handleSaveFileNotes(updatedFileNotes);
      await handleNoteSelect(newFileNote);
    });

    runtime.OnFileDrop(async (_, __, paths) => {
      if (paths.length > 0) {
        const file = paths[0];
        if (file) {
          await handleFileDrop(file);
        }
      }
    }, true);

    return () => {
      cleanup();
      runtime.OnFileDropOff();
    };
  }, [fileNotes, handleNoteSelect, setFileNotes, handleSaveFileNotes, handleFileDrop]);

  const handleCloseFile = async (note: FileNote) => {
    const updatedFileNotes = fileNotes.filter(f => f.fileName !== note.fileName);
    setFileNotes(updatedFileNotes);
    await handleSaveFileNotes(updatedFileNotes);
    if (currentNote?.id === note.id) {
      await handleNoteSelect(notes[0]);
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