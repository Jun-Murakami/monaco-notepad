import { useCallback, useEffect, useRef } from 'react';

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
  SetLastActiveNote,
  UnarchiveFolder,
  UpdateArchivedTopLevelOrder,
  UpdateCollapsedFolderIDs,
  UpdateTopLevelOrder,
} from '../../wailsjs/go/backend/App';
import { backend } from '../../wailsjs/go/models';
import * as runtime from '../../wailsjs/runtime';
import { useCurrentNoteStore } from '../stores/useCurrentNoteStore';
import { useNotesStore } from '../stores/useNotesStore';
import { useSplitEditorStore } from '../stores/useSplitEditorStore';

import type { EditorPane, FileNote, Note, TopLevelItem } from '../types';

interface UseNotesOptions {
  onNotesReloaded?: React.RefObject<
    ((notes: Note[], topLevelOrder?: TopLevelItem[]) => void) | null
  >;
  // スプリットモードのとき新規ノートを開くためのハンドラ。
  // useSplitEditor の openNoteInPane を ref 経由で受け取る（循環依存回避）。
  openNoteInPaneRef?: React.RefObject<
    ((note: Note | FileNote, pane: EditorPane) => void) | null
  >;
}

// 各 setter は Zustand action そのもの（参照不変）。
// store にひとつだけ存在する関数を取り出して使う。
const getStoreActions = () => useNotesStore.getState();

// state は store の getState() から都度読む。フックは購読しないので
// App.tsx を再レンダー誘発源にしない。
export const useNotes = (options: UseNotesOptions = {}) => {
  const { onNotesReloaded, openNoteInPaneRef } = options;
  const setCurrentNote = useCurrentNoteStore((state) => state.setCurrentNote);
  const setCurrentFileNote = useCurrentNoteStore(
    (state) => state.setCurrentFileNote,
  );
  const requestTitleFocus = useCurrentNoteStore(
    (state) => state.requestTitleFocus,
  );

  const isNoteModified = useRef(false);
  const previousContent = useRef<string>('');
  const pendingContentRef = useRef<string | null>(null);
  const isClosing = useRef(false);
  // 初期値は store から読む。以降は subscribe で追従。
  const currentNoteRef = useRef<Note | null>(
    useCurrentNoteStore.getState().currentNote,
  );
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Zustand ストアを購読せずに最新の currentNote を ref で保持する。
  useEffect(() => {
    currentNoteRef.current = useCurrentNoteStore.getState().currentNote;
    return useCurrentNoteStore.subscribe((state) => {
      currentNoteRef.current = state.currentNote;
    });
  }, []);

  // 現在のノートを保存する（refベースで依存なし） ------------------------------------------------------------
  // ★ fire-and-forget: ローカル state の楽観更新とフラグクリアを先にやり、
  //   バックエンドの SaveNote は await せずに投げる。
  //   ノート切替/オートセーブの待ち時間が消える。失敗時のログだけ残す。
  //   beforeClose では別途同期的に await する経路があるのでデータロスは防げる。
  const saveCurrentNote = useCallback(() => {
    const base = currentNoteRef.current;
    if (!base?.id || !isNoteModified.current) {
      return;
    }

    const noteToSave =
      pendingContentRef.current !== null
        ? { ...base, content: pendingContentRef.current }
        : base;

    getStoreActions().setNotes((prev) =>
      prev.map((note) =>
        note.id === noteToSave.id
          ? { ...noteToSave, folderId: note.folderId }
          : note,
      ),
    );
    // フラグは先にクリアする。saveCurrentNote 完了前にユーザーが
    // 別ノートに切替えて再編集 → このコールバックでフラグを再クリア…
    // という競合を避けるため。
    isNoteModified.current = false;
    pendingContentRef.current = null;
    SaveNote(backend.Note.createFrom(noteToSave), 'update').catch((err) =>
      console.error('SaveNote failed:', err),
    );
  }, []);

  // デバウンス付き自動保存をスケジュール ------------------------------------------------------------
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
      getStoreActions().setCollapsedFolders(new Set(ids ?? []));
    };
    loadCollapsedFolders();
  }, []);

  // イベントリスナーの設定 ------------------------------------------------------------
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

      const nextTopLevelOrder = (rawOrder ?? []).map((item) => ({
        type: item.type as 'note' | 'folder',
        id: item.id,
      }));
      const nextArchivedTopLevelOrder = (rawArchivedOrder ?? []).map(
        (item) => ({
          type: item.type as 'note' | 'folder',
          id: item.id,
        }),
      );
      const activeNotes = newNotes.filter((note) => !note.archived);
      const activeNoteMap = new Map(activeNotes.map((note) => [note.id, note]));
      const orderedActiveNotes: Note[] = [];
      const seenActiveNoteIDs = new Set<string>();

      for (const item of nextTopLevelOrder) {
        if (item.type === 'note') {
          const note = activeNoteMap.get(item.id);
          if (note && !seenActiveNoteIDs.has(note.id)) {
            orderedActiveNotes.push(note);
            seenActiveNoteIDs.add(note.id);
          }
          continue;
        }

        const folderNotes = activeNotes.filter(
          (note) => note.folderId === item.id,
        );
        for (const note of folderNotes) {
          if (seenActiveNoteIDs.has(note.id)) continue;
          orderedActiveNotes.push(note);
          seenActiveNoteIDs.add(note.id);
        }
      }

      for (const note of activeNotes) {
        if (seenActiveNoteIDs.has(note.id)) continue;
        orderedActiveNotes.push(note);
        seenActiveNoteIDs.add(note.id);
      }

      const actions = getStoreActions();
      const currentNotesSnapshot = useNotesStore.getState().notes;
      if (isNoteListChanged(currentNotesSnapshot, newNotes)) {
        actions.setNotes(newNotes);
      }
      actions.setFolders(newFolders);
      actions.setTopLevelOrder(nextTopLevelOrder);
      actions.setArchivedTopLevelOrder(nextArchivedTopLevelOrder);
      actions.setCollapsedFolders(new Set(collapsedIDs ?? []));

      // Splitモードでは現在ノートの整合はuseSplitEditor側で管理する。
      if (!useSplitEditorStore.getState().isSplit && currentNoteRef.current) {
        const updatedCurrentNote = activeNoteMap.get(currentNoteRef.current.id);
        if (!updatedCurrentNote) {
          const replacement = orderedActiveNotes.find(
            (note) => note.id !== currentNoteRef.current?.id,
          );
          setCurrentNote(replacement ?? null);
          previousContent.current = replacement?.content || '';
          pendingContentRef.current = null;
          isNoteModified.current = false;
        } else if (!isNoteModified.current) {
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
      onNotesReloaded?.current?.(newNotes, nextTopLevelOrder);
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
  }, [isNoteListChanged, onNotesReloaded, setCurrentNote]);

  // 新規ノート作成のロジック ------------------------------------------------------------
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
    const actions = getStoreActions();
    actions.setShowArchived(false);
    actions.setNotes((prev) => [newNote, ...prev]);
    actions.setTopLevelOrder((prev) => [
      { type: 'note', id: newNote.id },
      ...prev,
    ]);

    // 分割表示中はフォーカス中のペインに新ノートを開く。
    // openNoteInPaneRef は useSplitEditor の openNoteInPane を ref 越しに受ける。
    const splitState = useSplitEditorStore.getState();
    if (splitState.isSplit && openNoteInPaneRef?.current) {
      openNoteInPaneRef.current(newNote, splitState.focusedPane);
    } else {
      // 直前にローカルファイルが開かれていた場合、currentFileNote をクリアしないと
      // currentNote と currentFileNote が両方セットされた「分裂状態」になる
      // （PaneHeader は fileNote 優先で描画し、Editor 本文は note を表示する不整合）。
      setCurrentNote(newNote);
      setCurrentFileNote(null);
      SetLastActiveNote(newNote.id, false);
    }

    // バックエンドへの永続化は fire-and-forget。in-memory は同期更新済み。
    SaveNote(backend.Note.createFrom(newNote), 'create').catch((err) =>
      console.error('SaveNote (create) failed:', err),
    );
    // タイトル欄にフォーカスを送る（PaneHeader が token 変化で focus + select する）
    requestTitleFocus();
    return newNote;
  }, [
    openNoteInPaneRef,
    setCurrentNote,
    setCurrentFileNote,
    requestTitleFocus,
  ]);

  // 新規ノート作成 ------------------------------------------------------------
  const handleNewNote = useCallback(async () => {
    if (currentNoteRef.current && isNoteModified.current) {
      saveCurrentNote();
    }
    await createNewNote();
  }, [saveCurrentNote, createNewNote]);

  // ノートをアーカイブする ------------------------------------------------------------
  const handleArchiveNote = useCallback(
    async (noteId: string) => {
      const storeState = useNotesStore.getState();
      const oldNotes = storeState.notes;
      const oldTopLevelOrder = storeState.topLevelOrder;
      const oldArchivedTopLevelOrder = storeState.archivedTopLevelOrder;
      const wasCurrent = currentNoteRef.current?.id === noteId;

      const note = oldNotes.find((note) => note.id === noteId);
      if (!note) return;

      // ★ アーカイブ前にノートリスト表示順のフラット列とアーカイブ対象の位置を確定する
      let nextNote: Note | undefined;
      if (wasCurrent) {
        const oldFlat: Note[] = [];
        const seenFlat = new Set<string>();
        const oldNoteMap = new Map(
          oldNotes.filter((n) => !n.archived).map((n) => [n.id, n]),
        );
        for (const item of oldTopLevelOrder) {
          if (item.type === 'note') {
            const n = oldNoteMap.get(item.id);
            if (n && !seenFlat.has(n.id)) {
              oldFlat.push(n);
              seenFlat.add(n.id);
            }
          } else if (item.type === 'folder') {
            for (const n of oldNotes) {
              if (
                n.folderId === item.id &&
                !n.archived &&
                !seenFlat.has(n.id)
              ) {
                oldFlat.push(n);
                seenFlat.add(n.id);
              }
            }
          }
        }
        for (const n of oldNotes) {
          if (!n.archived && !seenFlat.has(n.id)) {
            oldFlat.push(n);
            seenFlat.add(n.id);
          }
        }

        const archivedIdx = oldFlat.findIndex((n) => n.id === noteId);
        if (archivedIdx >= 0) {
          if (archivedIdx + 1 < oldFlat.length) {
            nextNote = oldFlat[archivedIdx + 1];
          } else if (archivedIdx > 0) {
            nextNote = oldFlat[archivedIdx - 1];
          }
        }
      }

      const content = note.content || '';
      const contentHeader =
        content.match(/^.+$/gm)?.slice(0, 3).join('\n').slice(0, 200) || '';

      const archivedNote = {
        ...note,
        archived: true,
        content: content,
        contentHeader,
        folderId: undefined,
      };

      const actions = getStoreActions();
      actions.setNotes((prev) =>
        prev.map((n) => (n.id === noteId ? archivedNote : n)),
      );
      const newTopLevelOrder = oldTopLevelOrder.filter(
        (item) => !(item.type === 'note' && item.id === noteId),
      );
      actions.setTopLevelOrder(newTopLevelOrder);

      const newArchivedOrder = [
        { type: 'note' as const, id: noteId },
        ...oldArchivedTopLevelOrder.filter(
          (item) => !(item.type === 'note' && item.id === noteId),
        ),
      ];
      actions.setArchivedTopLevelOrder(newArchivedOrder);

      // 永続化はバックエンドに投げっぱなし。in-memory state はすでに更新済み。
      SaveNote(backend.Note.createFrom(archivedNote), 'update').catch((err) =>
        console.error('SaveNote (archive) failed:', err),
      );
      UpdateTopLevelOrder(
        newTopLevelOrder.map((item) => backend.TopLevelItem.createFrom(item)),
      ).catch((err) =>
        console.error('UpdateTopLevelOrder (archive) failed:', err),
      );
      UpdateArchivedTopLevelOrder(
        newArchivedOrder.map((item) => backend.TopLevelItem.createFrom(item)),
      ).catch((err) =>
        console.error('UpdateArchivedTopLevelOrder (archive) failed:', err),
      );

      if (wasCurrent) {
        if (nextNote) {
          setCurrentNote(nextNote);
        } else {
          await handleNewNote();
        }
      }
    },
    [handleNewNote, setCurrentNote],
  );

  // ノートを選択する ------------------------------------------------------------
  const handleSelectNote = useCallback(
    async (note: Note) => {
      if (currentNoteRef.current?.id && isNoteModified.current) {
        // fire-and-forget: 旧ノートの保存はバックエンドに投げて即座に切替を進める
        saveCurrentNote();
      }
      getStoreActions().setShowArchived(false);

      previousContent.current = note.content || '';
      setCurrentNote(note);
      isNoteModified.current = false;
      pendingContentRef.current = null;
    },
    [saveCurrentNote, setCurrentNote],
  );

  // ノートをアーカイブ解除する ------------------------------------------------------------
  const handleUnarchiveNote = useCallback(async (noteId: string) => {
    const storeState = useNotesStore.getState();
    const note = storeState.notes.find((note) => note.id === noteId);
    if (!note) return;

    const loadedNote = await LoadArchivedNote(noteId);
    if (loadedNote) {
      const previousFolderId = loadedNote.folderId;
      const unarchivedNote = {
        ...loadedNote,
        archived: false,
        folderId: undefined,
      };
      const actions = getStoreActions();
      actions.setNotes((prev) =>
        prev.map((note) => (note.id === noteId ? unarchivedNote : note)),
      );
      const currentTopLevel = useNotesStore.getState().topLevelOrder;
      const currentArchivedOrder =
        useNotesStore.getState().archivedTopLevelOrder;
      const newTopLevelOrder = [
        { type: 'note' as const, id: noteId },
        ...currentTopLevel.filter(
          (item) => !(item.type === 'note' && item.id === noteId),
        ),
      ];
      const newArchivedOrder = currentArchivedOrder.filter(
        (item) => !(item.type === 'note' && item.id === noteId),
      );
      actions.setTopLevelOrder(newTopLevelOrder);
      actions.setArchivedTopLevelOrder(newArchivedOrder);
      // 永続化は fire-and-forget
      SaveNote(backend.Note.createFrom(unarchivedNote), 'update').catch((err) =>
        console.error('SaveNote (unarchive) failed:', err),
      );
      if (previousFolderId) {
        MoveNoteToFolder(noteId, '').catch((err) =>
          console.error('MoveNoteToFolder (unarchive) failed:', err),
        );
      }
      Promise.all([
        UpdateTopLevelOrder(
          newTopLevelOrder.map((item) => backend.TopLevelItem.createFrom(item)),
        ),
        UpdateArchivedTopLevelOrder(
          newArchivedOrder.map((item) => backend.TopLevelItem.createFrom(item)),
        ),
      ]).catch((err) =>
        console.error('UpdateTopLevelOrder (unarchive) failed:', err),
      );
    }
  }, []);

  // ノートを削除する ------------------------------------------------------------
  const handleDeleteNote = useCallback(
    async (noteId: string) => {
      const storeState = useNotesStore.getState();
      const currentNotes = storeState.notes;
      const showArchived = storeState.showArchived;
      const activeNotes = currentNotes.filter((note) => !note.archived);
      const archivedNotes = currentNotes.filter((note) => note.archived);
      const isLastNote =
        archivedNotes.length === 1 && archivedNotes[0].id === noteId;
      const hasOnlyOneActiveNote = activeNotes.length === 1;
      const hasNoActiveNotes = activeNotes.length === 0;

      await DeleteNote(noteId);
      const actions = getStoreActions();
      actions.setNotes((prev) => prev.filter((note) => note.id !== noteId));
      actions.setTopLevelOrder((prev) =>
        prev.filter((item) => !(item.type === 'note' && item.id === noteId)),
      );
      actions.setArchivedTopLevelOrder((prev) =>
        prev.filter((item) => !(item.type === 'note' && item.id === noteId)),
      );

      if (showArchived) {
        if (isLastNote) {
          if (hasNoActiveNotes) {
            await createNewNote();
          } else if (hasOnlyOneActiveNote) {
            actions.setShowArchived(false);
            setCurrentNote(activeNotes[0]);
          }
        }
      }
    },
    [createNewNote, setCurrentNote],
  );

  // ノートをすべて削除する ------------------------------------------------------------
  const handleDeleteAllArchivedNotes = useCallback(async () => {
    const storeState = useNotesStore.getState();
    const currentNotes = storeState.notes;
    const folders = storeState.folders;
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

    const actions = getStoreActions();
    actions.setNotes((prev) => prev.filter((note) => !note.archived));
    actions.setFolders((prev) => prev.filter((f) => !f.archived));
    actions.setArchivedTopLevelOrder([]);

    const activeNotes = currentNotes.filter((note) => !note.archived);
    if (activeNotes.length > 0) {
      setCurrentNote(activeNotes[0]);
    } else {
      await createNewNote();
    }
    actions.setShowArchived(false);
  }, [createNewNote, setCurrentNote]);

  // ノートのタイトル、言語、内容を変更する ------------------------------------------------------------
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
        const prev = useCurrentNoteStore.getState().currentNote;
        if (prev) {
          isNoteModified.current = true;
          const updated = {
            ...prev,
            [target]: newState,
            ...(pendingContent !== null ? { content: pendingContent } : {}),
            modifiedTime: new Date().toISOString(),
          };

          if (target === 'title') {
            getStoreActions().setNotes((prevNotes) =>
              prevNotes.map((n) =>
                n.id === prev.id ? { ...n, title: newState } : n,
              ),
            );
          }

          setCurrentNote(updated);
        }

        pendingContentRef.current = null;

        scheduleAutoSave();
      };
    },
    [scheduleAutoSave, setCurrentNote],
  );

  const handleTitleChange = (newTitle: string) => {
    stateChanger('title')(newTitle);
  };

  const handleLanguageChange = (newLanguage: string) => {
    stateChanger('language')(newLanguage);
  };

  const handleNoteContentChange = (newContent: string) => {
    stateChanger('content')(newContent);
  };

  const handleCreateFolder = useCallback(async (name: string) => {
    const folder = await CreateFolder(name);
    const actions = getStoreActions();
    actions.setFolders((prev) => [...prev, folder]);
    actions.setTopLevelOrder((prev) => [
      { type: 'folder', id: folder.id },
      ...prev,
    ]);
    return folder;
  }, []);

  const handleRenameFolder = useCallback(async (id: string, name: string) => {
    await RenameFolder(id, name);
    getStoreActions().setFolders((prev) =>
      prev.map((f) => (f.id === id ? { ...f, name } : f)),
    );
  }, []);

  const handleDeleteFolder = useCallback(async (id: string) => {
    await DeleteFolder(id);
    const actions = getStoreActions();
    actions.setFolders((prev) => prev.filter((f) => f.id !== id));
    actions.setTopLevelOrder((prev) =>
      prev.filter((item) => !(item.type === 'folder' && item.id === id)),
    );
    actions.setCollapsedFolders((prev) => {
      const next = new Set(prev);
      next.delete(id);
      void UpdateCollapsedFolderIDs(Array.from(next));
      return next;
    });
  }, []);

  const handleMoveNoteToFolder = useCallback(
    async (noteID: string, folderID: string) => {
      // バックエンドへの永続化は fire-and-forget。UI は in-memory 更新だけで進む。
      MoveNoteToFolder(noteID, folderID).catch((err) =>
        console.error('MoveNoteToFolder failed:', err),
      );
      const newFolderId = folderID || undefined;
      const actions = getStoreActions();
      actions.setNotes((prev) =>
        prev.map((n) =>
          n.id === noteID ? { ...n, folderId: newFolderId } : n,
        ),
      );
      const prevCurrent = currentNoteRef.current;
      if (prevCurrent?.id === noteID) {
        setCurrentNote({ ...prevCurrent, folderId: newFolderId });
      }
      if (folderID) {
        actions.setTopLevelOrder((prev) =>
          prev.filter((item) => !(item.type === 'note' && item.id === noteID)),
        );
      } else {
        actions.setTopLevelOrder((prev) => {
          const exists = prev.some(
            (item) => item.type === 'note' && item.id === noteID,
          );
          if (exists) return prev;
          return [...prev, { type: 'note', id: noteID }];
        });
      }
    },
    [setCurrentNote],
  );

  const toggleFolderCollapse = useCallback((folderId: string) => {
    getStoreActions().setCollapsedFolders((prev) => {
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
      getStoreActions().setTopLevelOrder(order);
      // 永続化は fire-and-forget。in-memory 更新は同期で済んでいる。
      UpdateTopLevelOrder(
        order.map((item) => backend.TopLevelItem.createFrom(item)),
      ).catch((error) => {
        console.error('Failed to update top level order:', error);
      });
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
    const actions = getStoreActions();
    actions.setNotes(newNotes);
    actions.setFolders(newFolders);
    actions.setTopLevelOrder(
      (rawOrder ?? []).map((item) => ({
        type: item.type as 'note' | 'folder',
        id: item.id,
      })),
    );
    actions.setArchivedTopLevelOrder(
      (rawArchivedOrder ?? []).map((item) => ({
        type: item.type as 'note' | 'folder',
        id: item.id,
      })),
    );
    actions.setCollapsedFolders(new Set(collapsedIDs ?? []));
    return newNotes;
  }, []);

  const handleArchiveFolder = useCallback(
    async (folderId: string) => {
      await ArchiveFolder(folderId);
      const newNotes = await reloadAllState();

      const cur = useCurrentNoteStore.getState().currentNote;
      if (cur?.folderId === folderId) {
        const activeNotes = newNotes.filter((n) => !n.archived);
        if (activeNotes.length > 0) {
          setCurrentNote(activeNotes[0]);
        } else {
          await handleNewNote();
        }
      }
    },
    [handleNewNote, reloadAllState, setCurrentNote],
  );

  const handleUnarchiveFolder = useCallback(
    async (folderId: string) => {
      await UnarchiveFolder(folderId);
      await reloadAllState();
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
        getStoreActions().setShowArchived(false);
      }
    },
    [handleNewNote, reloadAllState, setCurrentNote],
  );

  const handleUpdateArchivedTopLevelOrder = useCallback(
    async (order: TopLevelItem[]) => {
      getStoreActions().setArchivedTopLevelOrder(order);
      UpdateArchivedTopLevelOrder(
        order.map((item) => backend.TopLevelItem.createFrom(item)),
      ).catch((error) => {
        console.error('Failed to update archived top level order:', error);
      });
    },
    [],
  );

  // 戻り値はアクション群のみ。state は store から直接購読してもらう。
  // pendingContentRef は handler 連携で使うため引き続き露出。
  return {
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
    pendingContentRef,
  };
};
