import { useState, useEffect, useRef } from 'react';
import { Note } from '../types';
import {
  QueueNoteOperation,
  ListNotes,
  DestroyApp,
  AuthorizeDrive,
  LogoutDrive,
  SyncNow,
  CheckDriveConnection,
  CancelLoginDrive,
} from '../../wailsjs/go/backend/App';
import * as runtime from '../../wailsjs/runtime';
import { backend } from '../../wailsjs/go/models';

const SYNC_TIMEOUT = 5 * 60 * 1000; // 5分のタイムアウト

export const useNotes = (showMessage: (title: string, message: string, isTwoButton?: boolean) => Promise<boolean>) => {
  const [notes, setNotes] = useState<Note[]>([]);
  const [currentNote, setCurrentNote] = useState<Note | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'synced' | 'syncing' | 'logging in' | 'offline'>('offline');
  const isNoteModified = useRef(false);
  const previousContent = useRef<string>('');
  const isClosing = useRef(false);
  const currentNoteRef = useRef<Note | null>(null);
  const syncStartTime = useRef<number | null>(null);
  const syncCheckInterval = useRef<NodeJS.Timeout | null>(null);

  // 現在のノートを保存する
  const saveCurrentNote = async (note: Note) => {
    if (!note?.id) return;
    try {
      const operation = backend.UpdateOperation.createFrom({
        type: "UPDATE",
        noteId: note.id,
        content: note,
        timestamp: new Date().toISOString(),
      });

      await QueueNoteOperation(operation);
    } catch (error) {
      console.error('Failed to save note:', error);
    }
  };

  // currentNoteの変更を追跡
  useEffect(() => {
    currentNoteRef.current = currentNote;
  }, [currentNote]);

  // 初期ロードとイベントリスナーの設定
  useEffect(() => {
    const loadNotes = async () => {
      const notes = await ListNotes();
      setNotes(notes);
    };

    loadNotes();

    // notes:reloadイベントのハンドラを登録
    runtime.EventsOn('notes:reload', async () => {
      const updatedNotes = await ListNotes();

      // 現在のノートの状態を保持
      if (currentNoteRef.current) {
        const currentNoteInList = updatedNotes.find(note => note.id === currentNoteRef.current?.id);
        if (currentNoteInList) {
          // 編集中のノートは現在の状態を維持
          setNotes(updatedNotes.map(note =>
            note.id === currentNoteRef.current?.id ? currentNoteRef.current : note
          ));
        } else {
          setNotes(updatedNotes);
        }
      } else {
        setNotes(updatedNotes);
      }
    });

    // 個別のノート更新イベントのハンドラを登録
    runtime.EventsOn('note:updated', async (noteId: string) => {
      // 更新されたノートを再読み込み
      const notes = await ListNotes();
      setNotes(notes);

      // 現在表示中のノートが更新された場合、その内容も更新
      if (currentNoteRef.current?.id === noteId) {
        const updatedNote = notes.find(note => note.id === noteId);
        if (updatedNote) {
          setCurrentNote(updatedNote);
          previousContent.current = updatedNote.content || '';
          isNoteModified.current = false;
        }
      }
    });

    // BeforeCloseイベントのリスナーを一度だけ設定
    const handleBeforeClose = async () => {
      if (isClosing.current) return;
      isClosing.current = true;

      try {
        const noteToSave = currentNoteRef.current;
        if (noteToSave?.id && isNoteModified.current) {
          await saveCurrentNote(noteToSave);
        }
      } catch (error) {
      }
      DestroyApp();
    };

    // ドライブ関連のイベントハンドラを登録
    const handleSync = () => {
      setSyncStatus('syncing');
    };

    const handleDriveStatus = (status: string) => {
      setSyncStatus(status as 'synced' | 'syncing' | 'offline');
    };

    const handleDriveError = (error: string) => {
      showMessage('Drive error', error);
      console.error('Drive error:', error);
    };

    runtime.EventsOn('app:beforeclose', handleBeforeClose);
    runtime.EventsOn('notes:updated', handleSync);
    runtime.EventsOn('drive:status', handleDriveStatus);
    runtime.EventsOn('drive:error', handleDriveError);

    return () => {
      runtime.EventsOff('app:beforeclose');
      runtime.EventsOff('notes:reload');
      runtime.EventsOff('note:updated');
      runtime.EventsOff('notes:updated');
      runtime.EventsOff('drive:status');
      runtime.EventsOff('drive:error');
    };
  }, [showMessage]);

  // 自動保存の処理 (デバウンスありSynchingSynching)
  useEffect(() => {
    if (!currentNote) return;

    const debounce = setTimeout(() => {
      if (isNoteModified.current) {
        saveCurrentNote(currentNote);
        isNoteModified.current = false;
      }
    }, 5000); // 5秒ごとに自動保存

    return () => {
      clearTimeout(debounce);
    };
  }, [currentNote]);

  // 同期状態の監視を開始
  const startSyncMonitoring = () => {
    // 既存の監視をクリア
    if (syncCheckInterval.current) {
      clearInterval(syncCheckInterval.current);
    }

    syncStartTime.current = Date.now();
    syncCheckInterval.current = setInterval(async () => {
      try {
        // バックエンドの状態をチェック
        const isConnected = await CheckDriveConnection();

        if (!isConnected && syncStatus !== 'logging in') {
          // 切断されている場合は強制ログアウト
          await handleForcedLogout('Drive connection lost. Please login again.');
          return;
        }

        // タイムアウトチェック
        if (syncStartTime.current && Date.now() - syncStartTime.current > SYNC_TIMEOUT) {
          await handleForcedLogout('Sync timeout. Please login again.');
          return;
        }
      } catch (error) {
        console.error('Sync monitoring error:', error);
        await handleForcedLogout('Error checking sync status. Please login again.');
      }
    }, 10000); // 10秒ごとにチェック
  };

  // 同期状態の監視を停止
  const stopSyncMonitoring = () => {
    if (syncCheckInterval.current) {
      clearInterval(syncCheckInterval.current);
      syncCheckInterval.current = null;
    }
    syncStartTime.current = null;
  };

  // 強制ログアウト処理
  const handleForcedLogout = async (message: string) => {
    stopSyncMonitoring();
    try {
      await LogoutDrive();
      showMessage('Sync Error', message);
    } catch (error) {
      console.error('Forced logout error:', error);
      showMessage('Error', 'Failed to logout: ' + error);
    }
  };

  // syncStatusの変更を監視
  useEffect(() => {
    if (syncStatus === 'syncing') {
      startSyncMonitoring();
    } else {
      stopSyncMonitoring();
    }

    return () => {
      stopSyncMonitoring();
    };
  }, [syncStatus]);

  // Google Drive関連の処理
  const handleGoogleAuth = async () => {
    try {
      setSyncStatus('syncing');
      await AuthorizeDrive();
    } catch (error) {
      console.error('Google authentication error:', error);
      showMessage('Error', 'Google authentication failed: ' + error);
      setSyncStatus('offline');
    }
  };

  // ログアウトする
  const handleLogout = async () => {
    try {
      // ログイン中の場合はキャンセル処理を実行
      if (syncStatus === 'logging in') {
        await CancelLoginDrive();
        return;
      }

      // 通常のログアウト処理（確認あり）
      const result = await showMessage('Logout from Google Drive', 'Are you sure you want to logout?', true);
      if (result) {
        await LogoutDrive();
      }
    } catch (error) {
      console.error('Logout error:', error);
      showMessage('Error', 'Logout failed: ' + error);
    }
  };

  // ただちに同期する
  const handleSync = async () => {
    if (syncStatus === 'synced') {
      try {
        setSyncStatus('syncing');
        await SyncNow();
        setSyncStatus('synced');
      } catch (error) {
        console.error('Manual sync error:', error);
        showMessage('Sync Error', 'Failed to synchronize with Google Drive: ' + error);
      }
    }
  };

  // 新規ノート作成のロジックを関数として抽出
  const createNewNote = async () => {
    const newNote: Note = {
      id: crypto.randomUUID(),
      title: '',
      content: '',
      contentHeader: null,
      language: currentNote?.language || 'plaintext',
      modifiedTime: new Date().toISOString(),
      archived: false,
    };

    const operation = backend.UpdateOperation.createFrom({
      type: "CREATE",
      noteId: newNote.id,
      content: newNote,
      timestamp: new Date().toISOString(),
    });

    await QueueNoteOperation(operation);

    // バックエンドの保存が完了した後で状態を更新
    setShowArchived(false);
    setNotes((prev) => [newNote, ...prev]);
    setCurrentNote(newNote);

    return newNote;
  };

  // 新規ノート作成
  const handleNewNote = async () => {
    if (currentNote && isNoteModified.current) {
      await saveCurrentNote(currentNote);
      isNoteModified.current = false;
    }
    await createNewNote();
  };

  // ノートをアーカイブする
  const handleArchiveNote = async (noteId: string) => {
    const note = notes.find((note) => note.id === noteId);
    if (!note) return;

    // コンテンツヘッダーを生成
    const content = note.content || '';
    const contentHeader = content
      .split('\n')
      .filter(line => line.trim().length > 0)
      .slice(0, 3)  // 最初の3行を取得
      .join('\n')
      .slice(0, 200);  // 最大200文字まで

    const archivedNote = {
      ...note,
      archived: true,
      content: content,
      contentHeader,
    };

    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? archivedNote : n))
    );

    const operation = backend.UpdateOperation.createFrom({
      type: "UPDATE",
      noteId: noteId,
      content: archivedNote,
      timestamp: new Date().toISOString(),
    });
    await QueueNoteOperation(operation);


    if (currentNote?.id === noteId) {
      const activeNotes = notes.filter((note) => !note.archived && note.id !== noteId);
      if (activeNotes.length > 0) {
        setCurrentNote(activeNotes[0]);
      } else {
        await createNewNote();
      }
    }
  };

  // ノートを選択する
  const handleNoteSelect = async (note: Note, isNew: boolean = false) => {
    if (currentNote?.id && isNoteModified.current) {
      await saveCurrentNote(currentNote);
      isNoteModified.current = false;
    }
    setShowArchived(false);

    if (isNew) {
      const operation = backend.UpdateOperation.createFrom({
        type: "CREATE",
        noteId: note.id,
        content: note,
        timestamp: new Date().toISOString(),
      });
      await QueueNoteOperation(operation);
    }


    previousContent.current = note.content || '';
    setCurrentNote(note);
  };

  // ノートをアーカイブ解除する
  const handleUnarchiveNote = async (noteId: string) => {
    const note = notes.find((note) => note.id === noteId);
    if (!note) return;

    const unarchivedNote = { ...note, archived: false };
    const operation = backend.UpdateOperation.createFrom({
      type: "UPDATE",
      noteId: noteId,
      content: unarchivedNote,
      timestamp: new Date().toISOString(),
    });
    await QueueNoteOperation(operation);


    setNotes((prev) =>
      prev.map((note) => (note.id === noteId ? unarchivedNote : note))
    );
  };

  // ノートを削除する
  const handleDeleteNote = async (noteId: string) => {
    const operation = backend.UpdateOperation.createFrom({
      type: "DELETE",
      noteId: noteId,
      content: null,
      timestamp: new Date().toISOString(),
    });
    await QueueNoteOperation(operation);

    setNotes((prev) => prev.filter((note) => note.id !== noteId));

    if (currentNote?.id === noteId) {
      const activeNotes = notes.filter((note) => !note.archived && note.id !== noteId);
      if (activeNotes.length > 0) {
        setCurrentNote(activeNotes[0]);
      } else {
        await createNewNote();
      }
    }
  };

  // アーカイブフラグのノートをすべて削除する
  const handleDeleteAllArchivedNotes = async () => {
    // notesの中からarchivedがtrueのノートをすべて削除キューに入れていく
    const archivedNotes = notes.filter((note) => note.archived);
    for (const note of archivedNotes) {
      const operation = backend.UpdateOperation.createFrom({
        type: "DELETE",
        noteId: note.id,
        content: null,
        timestamp: new Date().toISOString(),
      });
      await QueueNoteOperation(operation);
    }

    setNotes((prev) => prev.filter((note) => !note.archived));
  };

  // ノートの順序を更新する
  const handleReorderNotes = async (reorderedNotes: Note[]) => {
    setNotes(reorderedNotes);
    await QueueNoteOperation(backend.UpdateOperation.createFrom({
      type: "REORDER",
      noteId: "reorder", // 特別なIDを使用
      content: reorderedNotes.map(note => backend.Note.createFrom(note)),
      timestamp: new Date().toISOString(),
    }));
  };

  // タイトルを変更する
  const handleTitleChange = (title: string) => {
    if (!currentNote) return;
    const updatedNote = { ...currentNote, title, modifiedTime: new Date().toISOString() };
    setCurrentNote(updatedNote);
    setNotes((prev) =>
      prev.map((note) => (note.id === currentNote.id ? updatedNote : note))
    );
    isNoteModified.current = true;
  };

  // 言語を変更する
  const handleLanguageChange = (language: string) => {
    if (!currentNote) return;
    const updatedNote = { ...currentNote, language, modifiedTime: new Date().toISOString() };
    setCurrentNote(updatedNote);
    setNotes((prev) =>
      prev.map((note) => (note.id === currentNote.id ? updatedNote : note))
    );
    isNoteModified.current = true;
  };

  // 内容を変更する
  const handleContentChange = (content: string) => {
    if (!currentNote) return;
    const updatedNote = { ...currentNote, content, modifiedTime: new Date().toISOString() };
    setCurrentNote(updatedNote);
    setNotes((prev) =>
      prev.map((note) => (note.id === currentNote.id ? updatedNote : note))
    );
    isNoteModified.current = true;
  };

  return {
    notes,
    currentNote,
    showArchived,
    setShowArchived,
    syncStatus,
    setNotes,
    handleNewNote,
    handleArchiveNote,
    handleNoteSelect,
    handleUnarchiveNote,
    handleDeleteNote,
    handleDeleteAllArchivedNotes,
    handleReorderNotes,
    handleTitleChange,
    handleLanguageChange,
    handleContentChange,
    handleGoogleAuth,
    handleLogout,
    handleSync,
  };
}; 