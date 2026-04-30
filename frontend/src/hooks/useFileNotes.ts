import { useCallback, useEffect, useEffectEvent, useRef } from 'react';

import {
  CheckFileExists,
  CheckFileModified,
  GetModifiedTime,
  OpenFile,
  SaveFileNotes,
} from '../../wailsjs/go/backend/App';
import { backend } from '../../wailsjs/go/models';
import * as runtime from '../../wailsjs/runtime';
import i18n from '../i18n';
import { useCurrentNoteStore } from '../stores/useCurrentNoteStore';
import { useFileNotesStore } from '../stores/useFileNotesStore';
import { useNotesStore } from '../stores/useNotesStore';

import type { FileNote, Note } from '../types';

interface UseFileNotesProps {
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

// fileNotes は useFileNotesStore に集約済み。フックは購読せず、
// getState() / setFileNotes (action) 経由で操作する。
const getFileNotes = () => useFileNotesStore.getState().fileNotes;
const setFileNotes = (
  updater: FileNote[] | ((prev: FileNote[]) => FileNote[]),
) => useFileNotesStore.getState().setFileNotes(updater);

export const useFileNotes = ({
  setCurrentNote,
  handleNewNote,
  handleSelectNote,
  showMessage,
}: UseFileNotesProps) => {
  // currentFileNote は useCurrentNoteStore（Zustand）が真の保持者。
  // ここで購読すると App.tsx ごと再レンダーが走るので、書き込み action のみ取得し、
  // 読み出しは getState() / ref 経由に統一する。
  const setCurrentFileNote = useCurrentNoteStore(
    (state) => state.setCurrentFileNote,
  );
  const currentFileNoteRef = useRef<FileNote | null>(
    useCurrentNoteStore.getState().currentFileNote,
  );

  // currentFileNote は store の subscribe 経由で ref へ追従させる
  useEffect(() => {
    currentFileNoteRef.current = useCurrentNoteStore.getState().currentFileNote;
    return useCurrentNoteStore.subscribe((state) => {
      currentFileNoteRef.current = state.currentFileNote;
    });
  }, []);

  // BringToFront起因のフォーカスチェックを一時的に抑制するフラグ
  const suppressFocusCheckRef = useRef(false);

  // ファイルの変更チェックとリロードの共通処理 ------------------------------------------------------------
  const checkAndReloadFile = useCallback(
    async (fileNote: FileNote) => {
      try {
        // ファイルの存在チェックを追加
        const exists = await CheckFileExists(fileNote.filePath);
        if (!exists) {
          const fileName =
            fileNote.filePath.split(/[\\/]/).pop() || fileNote.filePath;
          const shouldKeep = await showMessage(
            i18n.t('file.notFoundTitle'),
            i18n.t('file.notFoundMessage', {
              fileName,
              filePath: fileNote.filePath,
            }),
            true,
            i18n.t('dialog.keep'),
            i18n.t('dialog.discard'),
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
            // getFileNotes()で最新のファイルノート一覧を参照
            // （awaitの後なのでrefはレンダー済みの最新値に同期されている）
            const updatedFileNotes = getFileNotes().map((note) =>
              note.id === fileNote.id ? newFileNote : note,
            );
            setFileNotes(updatedFileNotes);
            SaveFileNotes(
              updatedFileNotes.map((note) => backend.FileNote.createFrom(note)),
            ).catch((err) => console.error('SaveFileNotes failed:', err));
          } else {
            // ファイルノートを削除
            // getFileNotes()で最新のファイルノート一覧を参照
            const newFileNotes = getFileNotes().filter(
              (note) => note.id !== fileNote.id,
            );
            setFileNotes(newFileNotes);
            SaveFileNotes(
              newFileNotes.map((note) => backend.FileNote.createFrom(note)),
            ).catch((err) => console.error('SaveFileNotes failed:', err));

            // 他のノートに切り替え
            if (newFileNotes.length > 0) {
              setCurrentFileNote(newFileNotes[0]);
            } else {
              setCurrentFileNote(null);
              const activeNotes = useNotesStore
                .getState()
                .notes.filter((note) => !note.archived);
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
          const fileName =
            fileNote.filePath.split(/[\\/]/).pop() || fileNote.filePath;
          const shouldReload = await showMessage(
            i18n.t('file.changedExternallyTitle'),
            i18n.t('file.changedExternallyMessage', {
              fileName,
              filePath: fileNote.filePath,
            }),
            true,
            i18n.t('dialog.reload'),
            i18n.t('dialog.keepCurrent'),
          );

          if (shouldReload) {
            const result = await OpenFile(fileNote.filePath);
            const modifiedTime = await GetModifiedTime(fileNote.filePath);
            const newFileNote = {
              ...fileNote,
              content: result.content,
              originalContent: result.sourceEncoding ? '' : result.content,
              modifiedTime: modifiedTime.toString(),
            };
            setCurrentFileNote(newFileNote);
            const updatedFileNotes = getFileNotes().map((note) =>
              note.id === fileNote.id ? newFileNote : note,
            );
            setFileNotes(updatedFileNotes);
            SaveFileNotes(
              updatedFileNotes.map((note) => backend.FileNote.createFrom(note)),
            ).catch((err) => console.error('SaveFileNotes failed:', err));
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
      handleSelectNote,
      handleNewNote,
      setCurrentNote,
      setCurrentFileNote,
    ],
  );

  // ファイルノートを保存したときの処理 ------------------------------------------------------------
  // バックエンド永続化は fire-and-forget。caller 側で await されているが
  // 関数内部では Promise を投げっぱなしにしてエラーだけログる。
  const handleSaveFileNotes = useCallback(
    async (fileNotesToSave: FileNote[]) => {
      if (!fileNotesToSave) return;
      SaveFileNotes(
        fileNotesToSave.map((note) => backend.FileNote.createFrom(note)),
      ).catch((error) => {
        console.error('Failed to save file:', error);
      });
    },
    [],
  );

  // ウィンドウフォーカス時のファイル変更チェック（useEffectEvent経由で一度だけ登録） ------------------------------------------------------------
  const onFocusCheckFile = useEffectEvent(async () => {
    if (suppressFocusCheckRef.current) {
      suppressFocusCheckRef.current = false;
      return;
    }
    if (currentFileNoteRef.current) {
      await checkAndReloadFile(currentFileNoteRef.current);
    }
  });

  useEffect(() => {
    const handleFocus = () => {
      onFocusCheckFile();
    };

    // BringToFront起因のフォーカスチェック抑制イベントを受信
    const cleanupSuppress = runtime.EventsOn(
      'file:suppress-focus-check',
      () => {
        suppressFocusCheckRef.current = true;
        // 安全のため、一定時間後に自動解除
        setTimeout(() => {
          suppressFocusCheckRef.current = false;
        }, 3000);
      },
    );

    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
      cleanupSuppress();
    };
  }, []);

  // ファイルノート自動保存のデバウンスタイマー
  const fileNoteSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        handleSaveFileNotes(getFileNotes());
      }, 1000);
    },
    [handleSaveFileNotes, setCurrentFileNote],
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
    [checkAndReloadFile, setCurrentNote, setCurrentFileNote],
  );

  // ファイルを閉じる処理 ------------------------------------------------------------
  const handleCloseFile = useCallback(
    async (fileNote: FileNote) => {
      // ファイルが変更されている場合は、保存するかどうかを確認
      if (fileNote && fileNote.content !== fileNote.originalContent) {
        const shouldClose = await showMessage(
          i18n.t('file.unsavedChangesTitle'),
          i18n.t('file.unsavedChangesMessage'),
          true,
          i18n.t('dialog.discard'),
          i18n.t('dialog.cancel'),
        );

        if (!shouldClose) {
          return;
        }
      }
      // ファイルを閉じる
      const newFileNotes = getFileNotes().filter(
        (note) => note.id !== fileNote.id,
      );
      setFileNotes(newFileNotes);
      SaveFileNotes(
        newFileNotes.map((note) => backend.FileNote.createFrom(note)),
      ).catch((err) => console.error('SaveFileNotes failed:', err));
      // 閉じたファイルが現在表示中のファイルでない場合は選択を変更しない
      if (currentFileNoteRef.current?.id !== fileNote.id) {
        return;
      }
      // ファイルが残っている場合は、最初のファイルを選択
      if (newFileNotes.length > 0) {
        setCurrentFileNote(newFileNotes[0]);
      } else {
        setCurrentFileNote(null);
        const activeNotes = useNotesStore
          .getState()
          .notes.filter((note) => !note.archived);
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
      setCurrentNote,
      showMessage,
      handleSelectNote,
      handleNewNote,
      setCurrentFileNote,
    ],
  );

  // ファイルが変更されているかどうかを確認する ------------------------------------------------------------
  // fileNotes はストアから都度読む。selector を通さないので isFileModified の参照は不変。
  const isFileModified = useCallback((fileId: string) => {
    const note = getFileNotes().find((note) => note.id === fileId);
    return note ? note.content !== note.originalContent : false;
  }, []);

  return {
    setCurrentFileNote,
    handleSelectFileNote,
    handleSaveFileNotes,
    handleFileNoteContentChange,
    handleCloseFile,
    isFileModified,
  };
};
