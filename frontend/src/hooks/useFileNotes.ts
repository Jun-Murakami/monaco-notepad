import { useState, useEffect } from 'react';
import { Note, FileNote } from '../types';
import { SaveFileNotes, CheckFileModified, OpenFile, GetModifiedTime } from '../../wailsjs/go/backend/App';
import { backend } from '../../wailsjs/go/models';

interface UseFileNotesProps {
  notes: Note[];
  setCurrentNote: (note: Note | null) => void;
  handleNewNote: () => void;
  handleSelectNote: (note: Note | FileNote) => void;
  showMessage: (title: string, message: string, isTwoButton?: boolean, button1?: string, button2?: string) => Promise<boolean>;
}

export const useFileNotes = ({ notes, setCurrentNote, handleNewNote, handleSelectNote, showMessage }: UseFileNotesProps) => {
  const [fileNotes, setFileNotes] = useState<FileNote[]>([]);
  const [currentFileNote, setCurrentFileNote] = useState<FileNote | null>(null);

  // ファイルの変更チェックとリロードの共通処理
  const checkAndReloadFile = async (fileNote: FileNote) => {
    try {
      const isModified = await CheckFileModified(fileNote.filePath, fileNote.modifiedTime);
      if (isModified) {
        const shouldReload = await showMessage(
          'File has been modified outside of the app',
          'Do you want to reload the file?',
          true,
          'Reload',
          'Keep current state'
        );

        if (shouldReload) {
          const reloadedContent = await OpenFile(fileNote.filePath);
          const modifiedTime = await GetModifiedTime(fileNote.filePath);
          const newFileNote = {
            ...fileNote,
            content: reloadedContent,
            originalContent: reloadedContent,
            modifiedTime: modifiedTime.toString(),
          };
          setCurrentFileNote(newFileNote);
          setFileNotes(prev => prev.map(note =>
            note.id === fileNote.id ? newFileNote : note
          ));
          await SaveFileNotes([newFileNote]);
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error('Failed to check file modification:', error);
      return false;
    }
  };

  //自動保存の処理 (デバウンスあり)
  useEffect(() => {
    const debounce = setTimeout(() => {
      if (fileNotes.length > 0) {
        handleSaveFileNotes(fileNotes);
      }
    }, 5000);

    return () => {
      clearTimeout(debounce);
    };
  }, [fileNotes, currentFileNote]);

  // ウィンドウフォーカス時のファイル変更チェック
  useEffect(() => {
    const handleFocus = async () => {
      if (currentFileNote) {
        await checkAndReloadFile(currentFileNote);
      }
    };

    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, [currentFileNote, checkAndReloadFile]);

  // ファイルノートが変更されたときの処理
  const handleFileNoteContentChange = (newContent: string) => {
    if (!currentFileNote) {
      return;
    }

    const newFileNote: FileNote = {
      ...currentFileNote,
      content: newContent,
    };
    setCurrentFileNote(newFileNote);
    setFileNotes(prev => prev.map(note =>
      note.id === newFileNote.id ? newFileNote : note
    ));
  };

  // ファイルノートを保存したときの処理
  const handleSaveFileNotes = async (fileNotes: FileNote[]) => {
    try {
      if (!fileNotes) return;
      await SaveFileNotes(fileNotes.map(note => backend.FileNote.createFrom(note)));

    } catch (error) {
      console.error('Failed to save file:', error);
    }
  };

  // ノートを選択したときの処理
  const handleSelectFileNote = async (note: Note | FileNote) => {
    if (!('filePath' in note)) {
      // FileNoteでない場合は何もしない
      setCurrentFileNote(null);
      return;
    }
    const wasReloaded = await checkAndReloadFile(note);
    if (!wasReloaded) {
      setCurrentFileNote(note);
    }
  };

  // 現在のファイルを閉じる処理
  const handleCloseFile = async (fileNote: FileNote) => {
    if (fileNote && fileNote.content !== fileNote.originalContent) {
      const shouldClose = await showMessage('File has unsaved changes', 'Do you want to discard the changes and close the file?', true, 'Discard', 'Cancel');

      if (!shouldClose) {
        return;
      }
    }
    const newFileNotes = fileNotes.filter(note => note.id !== fileNote.id);
    setFileNotes(newFileNotes);
    await SaveFileNotes(newFileNotes.map(note => backend.FileNote.createFrom(note)));
    if (currentFileNote?.id === fileNote.id) {
      setCurrentFileNote(null);
    }
    if (newFileNotes.length > 0) {
      setCurrentFileNote(newFileNotes[0]);
      return;
    } else {
      setCurrentFileNote(null);
    }

    const activeNotes = notes.filter(note => !note.archived);
    if (activeNotes.length > 0) {
      handleSelectNote(activeNotes[0]);
      handleSelectFileNote(activeNotes[0]);
      setCurrentNote(activeNotes[0]);
    } else {
      handleNewNote();
    }
  };

  const isFileModified = (fileId: string) => {
    const note = fileNotes.find(note => note.id === fileId);
    return note ? note.content !== note.originalContent : false;
  };

  return {
    fileNotes,
    setFileNotes,
    currentFileNote,
    setCurrentFileNote,
    handleSelectFileNote,
    handleSaveFileNotes,
    handleFileNoteContentChange,
    handleCloseFile,
    isFileModified
  };
};
