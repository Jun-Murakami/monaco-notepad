import { getLanguageByExtension, getExtensionByLanguage } from '../lib/monaco';
import { SelectFile, OpenFile, SaveFile, SelectSaveFileUri, GetModifiedTime } from '../../wailsjs/go/backend/App';
import { Note, FileNote } from '../types';
import { useEffect, useCallback } from 'react';
import { isBinaryFile } from '../utils/fileUtils';
import * as runtime from '../../wailsjs/runtime';

interface UseFileOperationsProps {
  notes: Note[];
  setNotes: (notes: Note[]) => void;
  currentNote: Note | null;
  handleNoteSelect: (note: Note) => Promise<void>;
  showMessage: (title: string, message: string, isTwoButton?: boolean) => Promise<boolean>;
}

export function useFileOperations({
  notes,
  setNotes,
  currentNote,
  handleNoteSelect,
  showMessage
}: UseFileOperationsProps) {
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

    return {
      type: 'file' as const,
      id: crypto.randomUUID(),
      filePath: filePath,
      fileName: fileName,
      content: content,
      originalContent: content,
      language: language,
      modifiedTime: modifiedTime.toString(),
    };
  }, [showMessage]);

  // ファイルを開く
  const handleOpenFile = async () => {
    try {
      const filePath = await SelectFile();
      if (!filePath || Array.isArray(filePath)) return;

      // 既に同じファイルが開かれているかチェック
      const existingFile = notes.find(note => 'filePath' in note && note.filePath === filePath);
      if (existingFile) {
        await handleNoteSelect(existingFile);
        return;
      }

      const content = await OpenFile(filePath);
      if (typeof content !== 'string') return;

      const newFileNote = await createFileNote(content, filePath);
      if (!newFileNote) return;

      const updatedNotes = [newFileNote, ...notes];
      setNotes(updatedNotes);
      await handleNoteSelect(newFileNote);
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  // ファイルをエクスポートする
  const handleSaveAsFile = async () => {
    try {
      if (!currentNote?.content || currentNote.content === '') return;

      const extension = getExtensionByLanguage(currentNote.language) || 'txt';
      const title = 'title' in currentNote ? currentNote.title : currentNote.fileName;
      const filePath = await SelectSaveFileUri(title, extension);
      if (!filePath || Array.isArray(filePath)) return;

      await SaveFile(filePath, currentNote.content);
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
      const modifiedTime = await GetModifiedTime(fileNote.filePath);
      const updatedFileNote: FileNote = {
        ...fileNote,
        originalContent: fileNote.content,
        modifiedTime: modifiedTime.toString(),
      };
      const updatedNotes = notes.map((note: Note) => note.id === updatedFileNote.id ? updatedFileNote : note);
      setNotes(updatedNotes);
    } catch (error) {
      console.error('Failed to save file:', error);
      showMessage('Error', 'Failed to save the file.');
    }
  };

  // ファイルをメモに変換する
  const handleConvertToNote = async (fileNote: FileNote) => {
    const newNote: Note = {
      type: 'memory' as const,
      id: crypto.randomUUID(),
      title: fileNote.fileName.replace(/\.[^/.]+$/, ''),
      content: fileNote.content,
      contentHeader: null,
      language: fileNote.language,
      modifiedTime: new Date().toISOString(),
      archived: false,
    };

    const updatedNotes = notes.filter((n: Note) => n.id !== fileNote.id);
    setNotes([newNote, ...updatedNotes]);
    await handleNoteSelect(newNote);
  };

  // ファイルドロップのイベントリスナー
  useEffect(() => {
    const cleanup = runtime.EventsOn('file:open-external', async (data: { path: string, content: string }) => {
      const newFileNote = await createFileNote(data.content, data.path);
      if (!newFileNote) return;

      const updatedNotes = [newFileNote, ...notes];
      setNotes(updatedNotes);
      await handleNoteSelect(newFileNote);
    });

    runtime.OnFileDrop(async (_, __, paths) => {
      if (paths.length > 0) {
        const filePath = paths[0];
        if (filePath) {
          try {
            const content = await OpenFile(filePath);
            if (typeof content !== 'string') return;

            const newFileNote = await createFileNote(content, filePath);
            if (!newFileNote) return;

            const updatedNotes = [newFileNote, ...notes];
            setNotes(updatedNotes);
            await handleNoteSelect(newFileNote);
          } catch (error) {
            console.error('Failed to handle dropped file:', error);
          }
        }
      }
    }, true);

    return () => {
      cleanup();
      runtime.OnFileDropOff();
    };
  }, [notes, handleNoteSelect, setNotes, createFileNote]);

  return {
    handleOpenFile,
    handleSaveFile,
    handleSaveAsFile,
    handleConvertToNote,
  };
} 