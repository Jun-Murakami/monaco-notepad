import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckFileExists,
  CheckFileModified,
  GetModifiedTime,
  OpenFile,
  SaveFileNotes,
} from '../../wailsjs/go/backend/App';
import { backend } from '../../wailsjs/go/models';
import type { FileNote, Note } from '../types';

interface UseFileNotesProps {
  notes: Note[];
  setCurrentNote: (note: Note | null) => void;
  handleNewNote: () => Promise<void>;
  handleSelectNote: (note: Note) => Promise<void>;
  showMessage: (
    title: string,
    message: string,
    isTwoButton?: boolean,
    button1?: string,
    button2?: string,
  ) => Promise<boolean>;
}

export const useFileNotes = ({
  notes,
  setCurrentNote,
  handleNewNote,
  handleSelectNote,
  showMessage,
}: UseFileNotesProps) => {
  const [fileNotes, setFileNotes] = useState<FileNote[]>([]);
  const [currentFileNote, setCurrentFileNote] = useState<FileNote | null>(null);
  const currentFileNoteRef = useRef(currentFileNote);
  currentFileNoteRef.current = currentFileNote;

  // ファイルの変更チェックとリロードの共通処理 ------------------------------------------------------------
  const checkAndReloadFile = useCallback(
    async (fileNote: FileNote) => {
      try {
        // ファイルの存在チェックを追加
        const exists = await CheckFileExists(fileNote.filePath);
        if (!exists) {
          const shouldKeep = await showMessage(
            'File not found',
            'The file has been deleted or moved. Do you want to keep the content in the editor?',
            true,
            'Keep',
            'Discard',
          );

          if (shouldKeep) {
            // 内容を保持し、isModifiedをtrueに設定
            const newFileNote = {
              ...fileNote,
              filePath: '',
              originalContent: '',
              modifiedTime: fileNote.modifiedTime,
            };
            setCurrentFileNote(newFileNote);
            setFileNotes((prev) =>
              prev.map((note) =>
                note.id === fileNote.id ? newFileNote : note,
              ),
            );
            await SaveFileNotes([newFileNote]);
          } else {
            // ファイルノートを削除
            const newFileNotes = fileNotes.filter(
              (note) => note.id !== fileNote.id,
            );
            setFileNotes(newFileNotes);
            await SaveFileNotes(newFileNotes);

            // 他のノートに切り替え
            if (newFileNotes.length > 0) {
              setCurrentFileNote(newFileNotes[0]);
            } else {
              setCurrentFileNote(null);
              const activeNotes = notes.filter((note) => !note.archived);
              if (activeNotes.length > 0) {
                await handleSelectNote(activeNotes[0]);
                setCurrentNote(activeNotes[0]);
              } else {
                await handleNewNote();
              }
            }
          }
          return true;
        }

        // 既存のファイル変更チェックロジック
        const isModified = await CheckFileModified(
          fileNote.filePath,
          fileNote.modifiedTime,
        );
        if (isModified) {
          const shouldReload = await showMessage(
            'File has been modified outside of the app',
            'Do you want to reload the file?',
            true,
            'Reload',
            'Keep current state',
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
            setFileNotes((prev) =>
              prev.map((note) =>
                note.id === fileNote.id ? newFileNote : note,
              ),
            );
            await SaveFileNotes([newFileNote]);
            return true;
          }
        }
        return false;
      } catch (error) {
        console.error('Failed to check file modification:', error);
        return false;
      }
    },
    [
      showMessage,
      fileNotes,
      notes,
      handleSelectNote,
      handleNewNote,
      setCurrentNote,
    ],
  );

  // ファイルノートを保存したときの処理 ------------------------------------------------------------
  const handleSaveFileNotes = useCallback(
    async (fileNotesToSave: FileNote[]) => {
      try {
        if (!fileNotesToSave) return;
        await SaveFileNotes(
          fileNotesToSave.map((note) => backend.FileNote.createFrom(note)),
        );
      } catch (error) {
        console.error('Failed to save file:', error);
      }
    },
    [],
  );

  // ウィンドウフォーカス時のファイル変更チェック（ref経由で一度だけ登録） ------------------------------------------------------------
  const checkAndReloadFileRef = useRef(checkAndReloadFile);
  checkAndReloadFileRef.current = checkAndReloadFile;

  useEffect(() => {
    const handleFocus = async () => {
      if (currentFileNoteRef.current) {
        await checkAndReloadFileRef.current(currentFileNoteRef.current);
      }
    };

    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  // ファイルノート自動保存のデバウンスタイマー
  const fileNoteSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileNotesRef = useRef(fileNotes);
  fileNotesRef.current = fileNotes;

  useEffect(() => {
    return () => {
      if (fileNoteSaveTimer.current) clearTimeout(fileNoteSaveTimer.current);
    };
  }, []);

  // ファイルノートが変更されたときの処理 ------------------------------------------------------------
  const handleFileNoteContentChange = useCallback(
    (newContent: string) => {
      if (!currentFileNoteRef.current) {
        return;
      }

      const newFileNote: FileNote = {
        ...currentFileNoteRef.current,
        content: newContent,
      };
      setCurrentFileNote(newFileNote);
      setFileNotes((prev) =>
        prev.map((note) => (note.id === newFileNote.id ? newFileNote : note)),
      );

      if (fileNoteSaveTimer.current) {
        clearTimeout(fileNoteSaveTimer.current);
      }
      fileNoteSaveTimer.current = setTimeout(() => {
        handleSaveFileNotes(fileNotesRef.current);
      }, 1000);
    },
    [handleSaveFileNotes],
  );

  // ノートを選択したときの処理 ------------------------------------------------------------
  const handleSelectFileNote = useCallback(
    async (note: Note | FileNote) => {
      if (!('filePath' in note)) {
        // FileNoteでない場合は何もしない
        return;
      }
      setCurrentNote(null);
      const wasReloaded = await checkAndReloadFile(note);
      if (!wasReloaded) {
        setCurrentFileNote(note);
      }
    },
    [checkAndReloadFile, setCurrentNote],
  );

  // ファイルを閉じる処理 ------------------------------------------------------------
  const handleCloseFile = useCallback(
    async (fileNote: FileNote) => {
      // ファイルが変更されている場合は、保存するかどうかを確認
      if (fileNote && fileNote.content !== fileNote.originalContent) {
        const shouldClose = await showMessage(
          'File has unsaved changes',
          'Do you want to discard the changes and close the file?',
          true,
          'Discard',
          'Cancel',
        );

        if (!shouldClose) {
          return;
        }
      }
      // ファイルを閉じる
      const newFileNotes = fileNotes.filter((note) => note.id !== fileNote.id);
      setFileNotes(newFileNotes);
      await SaveFileNotes(
        newFileNotes.map((note) => backend.FileNote.createFrom(note)),
      );
      // 閉じたファイルが現在表示中のファイルでない場合は選択を変更しない
      if (currentFileNoteRef.current?.id !== fileNote.id) {
        return;
      }
      // ファイルが残っている場合は、最初のファイルを選択
      if (newFileNotes.length > 0) {
        setCurrentFileNote(newFileNotes[0]);
      } else {
        // ファイルがない場合は、現在のファイルを閉じる
        setCurrentFileNote(null);
        // アクティブなノートがある場合は、そのノートを選択
        const activeNotes = notes.filter((note) => !note.archived);
        if (activeNotes.length > 0) {
          await handleSelectNote(activeNotes[0]);
          setCurrentFileNote(null);
          setCurrentNote(activeNotes[0]);
        } else {
          await handleNewNote();
        }
      }
    },
    [
      fileNotes,
      notes.filter,
      setCurrentNote,
      showMessage,
      handleSelectNote,
      handleNewNote,
      notes,
    ],
  );

  // ファイルが変更されているかどうかを確認する ------------------------------------------------------------
  const isFileModified = useCallback(
    (fileId: string) => {
      const note = fileNotes.find((note) => note.id === fileId);
      return note ? note.content !== note.originalContent : false;
    },
    [fileNotes],
  );

  return {
    fileNotes,
    setFileNotes,
    currentFileNote,
    setCurrentFileNote,
    handleSelectFileNote,
    handleSaveFileNotes,
    handleFileNoteContentChange,
    handleCloseFile,
    isFileModified,
  };
};
