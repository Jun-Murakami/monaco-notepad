import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArchiveFolder,
  CreateFolder,
  DeleteArchivedFolder,
  DeleteFolder,
  DeleteNote,
  DestroyApp,
  GetArchivedTopLevelOrder,
  GetCollapsedFolderIDs,
  GetTopLevelOrder,
  ListFolders,
  ListNotes,
  LoadArchivedNote,
  MoveNoteToFolder,
  RenameFolder,
  SaveNote,
  UnarchiveFolder,
  UpdateArchivedTopLevelOrder,
  UpdateCollapsedFolderIDs,
  UpdateTopLevelOrder,
} from '../../wailsjs/go/backend/App';
import { backend } from '../../wailsjs/go/models';
import * as runtime from '../../wailsjs/runtime';
import type { Folder, Note, TopLevelItem } from '../types';

export const useNotes = (
  onNotesReloaded?: React.RefObject<((notes: Note[]) => void) | null>,
) => {
  const [notes, setNotes] = useState<Note[]>([]);
  const [currentNote, setCurrentNote] = useState<Note | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [topLevelOrder, setTopLevelOrder] = useState<TopLevelItem[]>([]);
  const [archivedTopLevelOrder, setArchivedTopLevelOrder] = useState<
    TopLevelItem[]
  >([]);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const isNoteModified = useRef(false);
  const previousContent = useRef<string>('');
  const pendingContentRef = useRef<string | null>(null);
  const isClosing = useRef(false);
  const currentNoteRef = useRef<Note | null>(null);
  const notesRef = useRef<Note[]>([]);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ref同期（レンダー時に直接代入）
  currentNoteRef.current = currentNote;
  notesRef.current = notes;

  // 現在のノートを保存する（refベースで依存なし） ------------------------------------------------------------
  const saveCurrentNote = useCallback(async () => {
    const base = currentNoteRef.current;
    if (!base?.id || !isNoteModified.current) {
      return;
    }

    const noteToSave =
      pendingContentRef.current !== null
        ? { ...base, content: pendingContentRef.current }
        : base;

    try {
      setNotes((prev) =>
        prev.map((note) => (note.id === noteToSave.id ? noteToSave : note)),
      );
      await SaveNote(backend.Note.createFrom(noteToSave), 'update');
      isNoteModified.current = false;
      pendingContentRef.current = null;
    } catch (_error) {
      // エラーは無視（ログはバックエンドで出力される）
    }
  }, []);

  // デバウンス付き自動保存をスケジュール（ハンドラから呼ぶ） ------------------------------------------------------------
  const scheduleAutoSave = useCallback(() => {
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
    }
    autoSaveTimer.current = setTimeout(() => {
      if (isNoteModified.current) {
        saveCurrentNote();
      }
    }, 3000);
  }, [saveCurrentNote]);

  // タイマーのクリーンアップ
  useEffect(() => {
    return () => {
      if (autoSaveTimer.current) {
        clearTimeout(autoSaveTimer.current);
      }
    };
  }, []);

  // ノートリストの内容を比較する関数
  const isNoteListChanged = useCallback(
    (oldNotes: Note[], newNotes: Note[]): boolean => {
      if (oldNotes.length !== newNotes.length) return true;
      return oldNotes.some((oldNote, index) => {
        const newNote = newNotes[index];
        if (!oldNote || !newNote) return true;
        return (
          oldNote.title !== newNote.title ||
          oldNote.content !== newNote.content ||
          oldNote.language !== newNote.language ||
          oldNote.archived !== newNote.archived ||
          oldNote.modifiedTime !== newNote.modifiedTime
        );
      });
    },
    [],
  );

  useEffect(() => {
    const loadCollapsedFolders = async () => {
      const ids = await GetCollapsedFolderIDs();
      setCollapsedFolders(new Set(ids ?? []));
    };
    loadCollapsedFolders();
  }, []);

  // イベントリスナーの設定（一度だけ登録、ref経由でアクセス） ------------------------------------------------------------
  useEffect(() => {
    const reloadHandler = async () => {
      const [newNotes, newFolders, rawOrder, rawArchivedOrder, collapsedIDs] =
        await Promise.all([
          ListNotes(),
          ListFolders(),
          GetTopLevelOrder(),
          GetArchivedTopLevelOrder(),
          GetCollapsedFolderIDs(),
        ]);

      if (isNoteListChanged(notesRef.current, newNotes)) {
        setNotes(newNotes);
      }
      setFolders(newFolders);
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
      setCollapsedFolders(new Set(collapsedIDs ?? []));

      // 編集中のノートは上書きしない
      if (currentNoteRef.current && !isNoteModified.current) {
        const updatedCurrentNote = newNotes.find(
          (note) => note.id === currentNoteRef.current?.id,
        );
        if (updatedCurrentNote) {
          const cur = currentNoteRef.current;
          const changed =
            cur.title !== updatedCurrentNote.title ||
            cur.content !== updatedCurrentNote.content ||
            cur.language !== updatedCurrentNote.language ||
            cur.archived !== updatedCurrentNote.archived ||
            cur.modifiedTime !== updatedCurrentNote.modifiedTime;
          if (changed) {
            setCurrentNote(updatedCurrentNote);
            previousContent.current = updatedCurrentNote.content || '';
            pendingContentRef.current = null;
          }
        }
      }

      // スプリットモードのペインも同期する
      onNotesReloaded?.current?.(newNotes);
    };

    runtime.EventsOn('notes:reload', reloadHandler);
    runtime.EventsOn('notes:updated', reloadHandler);

    const handleBeforeClose = async () => {
      if (isClosing.current) return;
      isClosing.current = true;

      try {
        const base = currentNoteRef.current;
        if (base?.id && isNoteModified.current) {
          const noteToSave =
            pendingContentRef.current !== null
              ? { ...base, content: pendingContentRef.current }
              : base;
          await SaveNote(backend.Note.createFrom(noteToSave), 'update');
        }
      } catch (_error) {}
      DestroyApp();
    };

    runtime.EventsOn('app:beforeclose', handleBeforeClose);

    return () => {
      runtime.EventsOff('app:beforeclose');
      runtime.EventsOff('notes:reload');
      runtime.EventsOff('notes:updated');
    };
  }, [isNoteListChanged, onNotesReloaded]);

  // 新規ノート作成のロジックを関数として抽出 ------------------------------------------------------------
  const createNewNote = useCallback(async () => {
    const newNote: Note = {
      id: crypto.randomUUID(),
      title: '',
      content: '',
      contentHeader: null,
      language: currentNoteRef.current?.language || 'plaintext',
      modifiedTime: new Date().toISOString(),
      archived: false,
    };
    setShowArchived(false);
    setNotes((prev) => [newNote, ...prev]);
    setTopLevelOrder((prev) => [{ type: 'note', id: newNote.id }, ...prev]);
    setCurrentNote(newNote);
    await SaveNote(backend.Note.createFrom(newNote), 'create');
    return newNote;
  }, []);

  // 新規ノート作成 ------------------------------------------------------------
  const handleNewNote = useCallback(async () => {
    if (currentNoteRef.current && isNoteModified.current) {
      await saveCurrentNote();
    }
    await createNewNote();
  }, [saveCurrentNote, createNewNote]);

  // ノートをアーカイブする ------------------------------------------------------------
  const handleArchiveNote = useCallback(
    async (noteId: string) => {
      const note = notesRef.current.find((note) => note.id === noteId);
      if (!note) return;

      const content = note.content || '';
      const contentHeader =
        content.match(/^.+$/gm)?.slice(0, 3).join('\n').slice(0, 200) || '';

      const archivedNote = {
        ...note,
        archived: true,
        content: content,
        contentHeader,
      };

      setNotes((prev) => prev.map((n) => (n.id === noteId ? archivedNote : n)));
      setTopLevelOrder((prev) =>
        prev.filter((item) => !(item.type === 'note' && item.id === noteId)),
      );
      await SaveNote(backend.Note.createFrom(archivedNote), 'update');

      const newArchivedOrder = [
        { type: 'note' as const, id: noteId },
        ...archivedTopLevelOrder.filter(
          (item) => !(item.type === 'note' && item.id === noteId),
        ),
      ];
      setArchivedTopLevelOrder(newArchivedOrder);
      await UpdateArchivedTopLevelOrder(newArchivedOrder);

      if (currentNoteRef.current?.id === noteId) {
        const currentNotes = notesRef.current;
        const activeNoteMap = new Map(
          currentNotes
            .filter((n) => !n.archived && n.id !== noteId)
            .map((n) => [n.id, n]),
        );
        let nextNote: Note | undefined;
        for (const item of topLevelOrder) {
          if (item.type === 'note' && activeNoteMap.has(item.id)) {
            nextNote = activeNoteMap.get(item.id);
            break;
          }
          if (item.type === 'folder') {
            const folderNote = currentNotes.find(
              (n) => n.folderId === item.id && !n.archived && n.id !== noteId,
            );
            if (folderNote) {
              nextNote = folderNote;
              break;
            }
          }
        }
        if (nextNote) {
          setCurrentNote(nextNote);
        } else {
          await handleNewNote();
        }
      }
    },
    [handleNewNote, topLevelOrder, archivedTopLevelOrder],
  );

  // ノートを選択する ------------------------------------------------------------
  const handleSelectNote = useCallback(
    async (note: Note) => {
      if (currentNoteRef.current?.id && isNoteModified.current) {
        await saveCurrentNote();
      }
      setShowArchived(false);

      previousContent.current = note.content || '';
      setCurrentNote(note);
      isNoteModified.current = false;
      pendingContentRef.current = null;
    },
    [saveCurrentNote],
  );

  // ノートをアーカイブ解除する ------------------------------------------------------------
  const handleUnarchiveNote = useCallback(async (noteId: string) => {
    const note = notesRef.current.find((note) => note.id === noteId);
    if (!note) return;

    const loadedNote = await LoadArchivedNote(noteId);
    if (loadedNote) {
      const unarchivedNote = { ...loadedNote, archived: false };
      setNotes((prev) =>
        prev.map((note) => (note.id === noteId ? unarchivedNote : note)),
      );
      setTopLevelOrder((prev) => [{ type: 'note', id: noteId }, ...prev]);
      setCurrentNote(unarchivedNote);
      setShowArchived(false);
      await SaveNote(backend.Note.createFrom(unarchivedNote), 'update');

      const rawArchivedOrder = await GetArchivedTopLevelOrder();
      setArchivedTopLevelOrder(
        (rawArchivedOrder ?? []).map((item) => ({
          type: item.type as 'note' | 'folder',
          id: item.id,
        })),
      );
    }
  }, []);

  // ノートを削除する ------------------------------------------------------------
  const handleDeleteNote = useCallback(
    async (noteId: string) => {
      const currentNotes = notesRef.current;
      const activeNotes = currentNotes.filter((note) => !note.archived);
      const archivedNotes = currentNotes.filter((note) => note.archived);
      const isLastNote =
        archivedNotes.length === 1 && archivedNotes[0].id === noteId;
      const hasOnlyOneActiveNote = activeNotes.length === 1;
      const hasNoActiveNotes = activeNotes.length === 0;

      await DeleteNote(noteId);
      setNotes((prev) => prev.filter((note) => note.id !== noteId));
      setTopLevelOrder((prev) =>
        prev.filter((item) => !(item.type === 'note' && item.id === noteId)),
      );
      setArchivedTopLevelOrder((prev) =>
        prev.filter((item) => !(item.type === 'note' && item.id === noteId)),
      );

      if (showArchived) {
        if (isLastNote) {
          if (hasNoActiveNotes) {
            await createNewNote();
          } else if (hasOnlyOneActiveNote) {
            setShowArchived(false);
            setCurrentNote(activeNotes[0]);
          }
        }
      }
    },
    [createNewNote, showArchived],
  );

  // ノートをすべて削除する ------------------------------------------------------------
  const handleDeleteAllArchivedNotes = useCallback(async () => {
    const currentNotes = notesRef.current;
    const archivedNotes = currentNotes.filter((note) => note.archived);
    const archivedFolderIds = new Set(
      folders.filter((f) => f.archived).map((f) => f.id),
    );

    for (const note of archivedNotes) {
      await DeleteNote(note.id);
    }
    for (const folderId of archivedFolderIds) {
      await DeleteArchivedFolder(folderId);
    }

    setNotes((prev) => prev.filter((note) => !note.archived));
    setFolders((prev) => prev.filter((f) => !f.archived));
    setArchivedTopLevelOrder([]);

    const activeNotes = currentNotes.filter((note) => !note.archived);
    if (activeNotes.length > 0) {
      setCurrentNote(activeNotes[0]);
    } else {
      await createNewNote();
    }
    setShowArchived(false);
  }, [createNewNote, folders]);

  // ノートのタイトル、言語、内容を変更する（ハンドラ内でdebounce付き保存をスケジュール） ------------------------------------------------------------
  const stateChanger = useCallback(
    (target: 'title' | 'language' | 'content') => {
      return (newState: string) => {
        if (target === 'content') {
          if (newState === previousContent.current) {
            return;
          }
          previousContent.current = newState;
          isNoteModified.current = true;
          pendingContentRef.current = newState;
          scheduleAutoSave();
          return;
        }

        const pendingContent = pendingContentRef.current;

        setCurrentNote((prev) => {
          if (!prev) {
            return prev;
          }

          isNoteModified.current = true;
          const updated = {
            ...prev,
            [target]: newState,
            ...(pendingContent !== null ? { content: pendingContent } : {}),
            modifiedTime: new Date().toISOString(),
          };

          if (target === 'title') {
            setNotes((prevNotes) =>
              prevNotes.map((n) =>
                n.id === prev.id ? { ...n, title: newState } : n,
              ),
            );
          }

          return updated;
        });

        pendingContentRef.current = null;

        // ハンドラ内で直接デバウンス保存をスケジュール
        scheduleAutoSave();
      };
    },
    [scheduleAutoSave],
  );

  // ノートのタイトルを変更する ------------------------------------------------------------
  const handleTitleChange = (newTitle: string) => {
    stateChanger('title')(newTitle);
  };

  // ノートの言語を変更する ------------------------------------------------------------
  const handleLanguageChange = (newLanguage: string) => {
    stateChanger('language')(newLanguage);
  };

  // ノートの内容を変更する ------------------------------------------------------------
  const handleNoteContentChange = (newContent: string) => {
    stateChanger('content')(newContent);
  };

  const handleCreateFolder = useCallback(async (name: string) => {
    const folder = await CreateFolder(name);
    setFolders((prev) => [...prev, folder]);
    setTopLevelOrder((prev) => [{ type: 'folder', id: folder.id }, ...prev]);
    return folder;
  }, []);

  const handleRenameFolder = useCallback(async (id: string, name: string) => {
    await RenameFolder(id, name);
    setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name } : f)));
  }, []);

  const handleDeleteFolder = useCallback(async (id: string) => {
    await DeleteFolder(id);
    setFolders((prev) => prev.filter((f) => f.id !== id));
    setTopLevelOrder((prev) =>
      prev.filter((item) => !(item.type === 'folder' && item.id === id)),
    );
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      next.delete(id);
      void UpdateCollapsedFolderIDs(Array.from(next));
      return next;
    });
  }, []);

  const handleMoveNoteToFolder = useCallback(
    async (noteID: string, folderID: string) => {
      await MoveNoteToFolder(noteID, folderID);
      setNotes((prev) =>
        prev.map((n) =>
          n.id === noteID ? { ...n, folderId: folderID || undefined } : n,
        ),
      );
      if (folderID) {
        setTopLevelOrder((prev) =>
          prev.filter((item) => !(item.type === 'note' && item.id === noteID)),
        );
      } else {
        setTopLevelOrder((prev) => {
          const exists = prev.some(
            (item) => item.type === 'note' && item.id === noteID,
          );
          if (exists) return prev;
          return [...prev, { type: 'note', id: noteID }];
        });
      }
    },
    [],
  );

  const toggleFolderCollapse = useCallback((folderId: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      void UpdateCollapsedFolderIDs(Array.from(next));
      return next;
    });
  }, []);

  const handleUpdateTopLevelOrder = useCallback(
    async (order: TopLevelItem[]) => {
      setTopLevelOrder(order);
      try {
        await UpdateTopLevelOrder(
          order.map((item) => backend.TopLevelItem.createFrom(item)),
        );
      } catch (error) {
        console.error('Failed to update top level order:', error);
      }
    },
    [],
  );

  const reloadAllState = useCallback(async () => {
    const [newNotes, newFolders, rawOrder, rawArchivedOrder, collapsedIDs] =
      await Promise.all([
        ListNotes(),
        ListFolders(),
        GetTopLevelOrder(),
        GetArchivedTopLevelOrder(),
        GetCollapsedFolderIDs(),
      ]);
    setNotes(newNotes);
    setFolders(newFolders);
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
    setCollapsedFolders(new Set(collapsedIDs ?? []));
    return newNotes;
  }, []);

  const handleArchiveFolder = useCallback(
    async (folderId: string) => {
      await ArchiveFolder(folderId);
      const newNotes = await reloadAllState();

      if (currentNote?.folderId === folderId) {
        const activeNotes = newNotes.filter((n) => !n.archived);
        if (activeNotes.length > 0) {
          setCurrentNote(activeNotes[0]);
        } else {
          await handleNewNote();
        }
      }
    },
    [currentNote, handleNewNote, reloadAllState],
  );

  const handleUnarchiveFolder = useCallback(
    async (folderId: string) => {
      await UnarchiveFolder(folderId);
      const newNotes = await reloadAllState();
      setShowArchived(false);

      const restoredNotes = newNotes.filter(
        (n) => n.folderId === folderId && !n.archived,
      );
      if (restoredNotes.length > 0) {
        setCurrentNote(restoredNotes[0]);
      }
    },
    [reloadAllState],
  );

  const handleDeleteArchivedFolder = useCallback(
    async (folderId: string) => {
      await DeleteArchivedFolder(folderId);
      const newNotes = await reloadAllState();

      const hasArchived = newNotes.some((n) => n.archived);
      if (!hasArchived) {
        const activeNotes = newNotes.filter((n) => !n.archived);
        if (activeNotes.length > 0) {
          setCurrentNote(activeNotes[0]);
        } else {
          await handleNewNote();
        }
        setShowArchived(false);
      }
    },
    [handleNewNote, reloadAllState],
  );

  const handleUpdateArchivedTopLevelOrder = useCallback(
    async (order: TopLevelItem[]) => {
      setArchivedTopLevelOrder(order);
      try {
        await UpdateArchivedTopLevelOrder(
          order.map((item) => backend.TopLevelItem.createFrom(item)),
        );
      } catch (error) {
        console.error('Failed to update archived top level order:', error);
      }
    },
    [],
  );

  return {
    notes,
    setNotes,
    currentNote,
    setCurrentNote,
    showArchived,
    setShowArchived,
    saveCurrentNote,
    handleNewNote,
    handleArchiveNote,
    handleSelectNote,
    handleUnarchiveNote,
    handleDeleteNote,
    handleDeleteAllArchivedNotes,
    handleTitleChange,
    handleLanguageChange,
    handleNoteContentChange,
    folders,
    setFolders,
    collapsedFolders,
    topLevelOrder,
    setTopLevelOrder,
    archivedTopLevelOrder,
    setArchivedTopLevelOrder,
    handleCreateFolder,
    handleRenameFolder,
    handleDeleteFolder,
    handleMoveNoteToFolder,
    handleUpdateTopLevelOrder,
    handleArchiveFolder,
    handleUnarchiveFolder,
    handleDeleteArchivedFolder,
    handleUpdateArchivedTopLevelOrder,
    toggleFolderCollapse,
  };
};
