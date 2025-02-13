import { useState, useEffect } from 'react';
import { FileNote } from '../types';
import { SaveFileNotes, CheckFileModified, ReloadFileContent, GetModifiedTime } from '../../wailsjs/go/backend/App';
import { backend } from '../../wailsjs/go/models';

interface UseFileNotesProps {
  showMessage: (title: string, message: string, isTwoButton?: boolean, button1?: string, button2?: string) => Promise<boolean>;
}

export const useFileNotes = ({ showMessage }: UseFileNotesProps) => {
  const [fileNotes, setFileNotes] = useState<FileNote[]>([]);
  const [currentFileNote, setCurrentFileNote] = useState<FileNote | null>(null);

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
      if (!fileNotes || fileNotes.length === 0) return;
      await SaveFileNotes(fileNotes.map(note => backend.FileNote.createFrom(note)));

    } catch (error) {
      console.error('Failed to save file:', error);
    }
  };

  // ファイルノートを選択したときの処理
  const handleSelectFileNote = async (fileNote: FileNote) => {
    // 現在のファイルに未保存の変更がある場合は確認
    if (currentFileNote && currentFileNote.content !== currentFileNote.originalContent) {
      const shouldProceed = await showMessage('File has unsaved changes', 'Do you want to discard the changes and switch to the file?', true, 'Proceed', 'Cancel');

      if (!shouldProceed) {
        return;
      }
    }

    try {
      // ファイルが外部で変更されているかチェック
      const isModified = await CheckFileModified(fileNote.filePath, fileNote.modifiedTime);
      if (isModified) {
        const shouldReload = await showMessage('File has been modified', 'Do you want to reload the file?', true, 'Reload', 'Keep current state');

        if (shouldReload) {
          const reloadedContent = await ReloadFileContent(fileNote.filePath);
          fileNote = {
            ...fileNote,
            content: reloadedContent,
            originalContent: reloadedContent,
            modifiedTime: new Date().toISOString(),
          };
        }
      }
    } catch (error) {
      console.error('Failed to check file modification:', error);
    }

    setCurrentFileNote(fileNote);
  };

  // 現在のファイルを閉じる処理
  const handleCloseFile = async (fileNote: FileNote) => {
    console.log('handleCloseFile', fileNote);
    if (fileNote && fileNote.content !== fileNote.originalContent) {
      const shouldClose = await showMessage('File has unsaved changes', 'Do you want to discard the changes and close the file?', true, 'Discard', 'Cancel');

      if (!shouldClose) {
        return;
      }
    }
    const newFileNotes = fileNotes.filter(note => note.id !== fileNote.id);
    setFileNotes(newFileNotes);
    if (currentFileNote?.id === fileNote.id) {
      setCurrentFileNote(null);
    }
    if (newFileNotes.length > 0) {
      setCurrentFileNote(newFileNotes[0]);
    } else {
      setCurrentFileNote(null);
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
