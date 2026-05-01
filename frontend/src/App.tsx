import { Box, Typography } from '@mui/material';
import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import {
  SaveNote,
  SetLastActiveNote,
  UpdateNoteOrder,
} from '../wailsjs/go/backend/App';
import { backend } from '../wailsjs/go/models';
import { WindowToggleMaximise } from '../wailsjs/runtime';
import { EditorArea } from './components/EditorArea';
import { insertTopLevelNote } from './components/NoteList';
import { Sidebar } from './components/Sidebar';
import {
  saveAndApplyEditorSettings,
  useEditorSettings,
} from './hooks/useEditorSettings';
import { useFileNotes } from './hooks/useFileNotes';
import { useFileOperations } from './hooks/useFileOperations';
import { useInitialize } from './hooks/useInitialize';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useMessageDialog } from './hooks/useMessageDialog';
import { useNoteSelecter } from './hooks/useNoteSelecter';
import { useNotes } from './hooks/useNotes';
import { usePaneSizes } from './hooks/usePaneSizes';
import { useRecentFiles } from './hooks/useRecentFiles';
import { useSplitEditor } from './hooks/useSplitEditor';
import { useCurrentNoteStore } from './stores/useCurrentNoteStore';
import { useDialogsStore } from './stores/useDialogsStore';
import {
  applyLanguageToEditor,
  useEditorSettingsStore,
} from './stores/useEditorSettingsStore';
import { useFileNotesStore } from './stores/useFileNotesStore';
import { useNotesStore } from './stores/useNotesStore';
import { useSearchReplaceStore } from './stores/useSearchReplaceStore';
import { useSplitEditorStore } from './stores/useSplitEditorStore';

import type { editor } from 'monaco-editor';
import type { FileNote, Note, TopLevelItem } from './types';

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

function App() {
  const { t } = useTranslation();

  // 1) 内部状態（ref / useState）
  const onNotesReloadedRef = useRef<
    ((notes: Note[], topLevelOrder?: TopLevelItem[]) => void) | null
  >(null);
  const isSidebarDraggingRef = useRef<boolean>(false);
  const openNoteInPaneRef = useRef<
    ((note: Note | FileNote, pane: 'left' | 'right') => void) | null
  >(null);
  const archiveNoteRef = useRef<(noteId: string) => Promise<void>>(
    async () => {},
  );
  const closeFileRef = useRef<(file: FileNote) => Promise<void>>(
    async () => {},
  );
  const addRecentFileRef = useRef<((filePath: string) => Promise<void>) | null>(
    null,
  );

  const leftEditorInstanceRef = useRef<editor.IStandaloneCodeEditor | null>(
    null,
  );
  const rightEditorInstanceRef = useRef<editor.IStandaloneCodeEditor | null>(
    null,
  );

  // 2) カスタムフック
  // エディタ設定（state は useEditorSettingsStore に集約済み。フックは load 副作用のみ）
  // App.tsx は settings 全体を購読しない。タイトルバーの isDarkMode のみ narrow selector で読む。
  useEditorSettings();
  const isDarkMode = useEditorSettingsStore((s) => s.settings.isDarkMode);

  // ペインサイズ管理
  const {
    sidebarWidth,
    splitPaneSize,
    markdownPreviewPaneSize,
    handleSidebarWidthChange,
    handleSplitPaneSizeChange,
    handleMarkdownPreviewPaneSizeChange,
    scheduleSave: schedulePaneSizeSave,
    getAllotmentSizes,
  } = usePaneSizes();

  // メッセージダイアログ（実体は <MessageDialog /> + useMessageDialogStore に分離済み）
  const { showMessage } = useMessageDialog();

  // ノート（state は useNotesStore に集約済み。フックは action 群のみ提供）
  const {
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
  } = useNotes({
    onNotesReloaded: onNotesReloadedRef,
    openNoteInPaneRef,
  });
  const setCurrentNote = useCurrentNoteStore((s) => s.setCurrentNote);
  // App.tsx は notes / folders / topLevelOrder / showArchived を「購読しない」。
  // 派生計算 (canSplit / canSelectAdjacent / orderedAvailableNotes) は consumer
  // (Sidebar / EditorArea) で行う。App のハンドラは getState() で都度読む。
  // setter は Zustand action（参照不変）なので普通に取得して問題ない。
  const setNotes = useNotesStore((s) => s.setNotes);
  const setFolders = useNotesStore((s) => s.setFolders);
  const setTopLevelOrder = useNotesStore((s) => s.setTopLevelOrder);
  const setArchivedTopLevelOrder = useNotesStore(
    (s) => s.setArchivedTopLevelOrder,
  );
  const setShowArchived = useNotesStore((s) => s.setShowArchived);

  // ファイルノート（state は useFileNotesStore に集約済み。フックは action のみ提供）
  const {
    setCurrentFileNote,
    handleSelectFileNote,
    handleSaveFileNotes,
    handleFileNoteContentChange,
    handleCloseFile,
    isFileModified,
  } = useFileNotes({
    setCurrentNote,
    handleNewNote,
    handleSelectNote,
    showMessage,
  });
  // setFileNotes は Zustand action（参照不変）。store 直接取得で OK。
  const setFileNotes = useFileNotesStore((s) => s.setFileNotes);

  // ノート選択ユーティリティ（fileNotes は store から都度読むので props 不要）
  const { handleSelecAnyNote } = useNoteSelecter({
    handleSelectNote,
    handleSelectFileNote,
  });

  // ファイル操作（fileNotes は store から都度読む）
  const {
    handleOpenFile,
    handleOpenFileByPath,
    handleSaveFile,
    handleSaveAsFile,
  } = useFileOperations(
    handleSelecAnyNote,
    showMessage,
    handleSaveFileNotes,
    openNoteInPaneRef,
    addRecentFileRef,
    pendingContentRef,
  );

  // ノート分割管理（state は useSplitEditorStore に集約済み）
  const {
    toggleSplit,
    toggleMarkdownPreview,
    handleFocusPane,
    handleSelectNoteForPane,
    openNoteInPane,
    handleLeftNoteContentChange,
    handleRightNoteContentChange,
    handleLeftNoteTitleChange,
    handleRightNoteTitleChange,
    handleLeftNoteLanguageChange,
    handleRightNoteLanguageChange,
    handleLeftFileNoteContentChange,
    handleRightFileNoteContentChange,
    restorePaneNotes,
    saveSplitState,
    syncPaneNotes,
  } = useSplitEditor();
  // pane state は consumer (Sidebar / EditorArea) が直接購読する。
  // App.tsx のハンドラは useSplitEditorStore.getState() で都度読む。
  // 書き込み action だけはここで取得（参照不変）
  const setLeftNote = useSplitEditorStore((s) => s.setLeftNote);
  const setLeftFileNote = useSplitEditorStore((s) => s.setLeftFileNote);
  const setRightNote = useSplitEditorStore((s) => s.setRightNote);
  const setRightFileNote = useSplitEditorStore((s) => s.setRightFileNote);

  // フック間で参照するため、現在の状態をrefへ同期
  onNotesReloadedRef.current = syncPaneNotes;
  openNoteInPaneRef.current = openNoteInPane;
  archiveNoteRef.current = handleArchiveNote;
  closeFileRef.current = handleCloseFile;

  // 初期化
  const { languages, platform, systemLocale } = useInitialize(
    setNotes,
    setFolders,
    setTopLevelOrder,
    setArchivedTopLevelOrder,
    handleNewNote,
    handleSelecAnyNote,
    showMessage,
    restorePaneNotes,
  );

  // 最近開いたファイル
  const {
    recentFiles,
    addRecentFile,
    removeRecentFile,
    clearRecentFiles,
    openRecentFile,
  } = useRecentFiles({
    handleOpenFileByPath,
    showMessage,
  });
  addRecentFileRef.current = addRecentFile;

  // 絞り込み件数は Sidebar 内で計算するため、App.tsx では useNoteSearch を呼ばない。
  // App.tsx が notes 変化で再レンダーするのを避けるため。

  // 検索・置換パネル用の context を store に登録する。状態 / 副作用は
  // useSearchReplaceStore + <SearchReplaceEngine /> が担当するので、ここでは
  // 「App ローカルの参照」だけブリッジする。notes は store から都度読む。
  const getActiveEditor = useCallback(() => {
    const { isSplit, focusedPane } = useSplitEditorStore.getState();
    return (
      (isSplit && focusedPane === 'right'
        ? rightEditorInstanceRef.current
        : leftEditorInstanceRef.current) ?? null
    );
  }, []);
  const getActiveNoteId = useCallback((): string | null => {
    const {
      isSplit,
      focusedPane,
      leftNote,
      leftFileNote,
      rightNote,
      rightFileNote,
    } = useSplitEditorStore.getState();
    if (isSplit) {
      if (focusedPane === 'left')
        return leftNote?.id ?? leftFileNote?.id ?? null;
      return rightNote?.id ?? rightFileNote?.id ?? null;
    }
    // 単一ペイン時は currentNote 優先、なければ currentFileNote を見る
    const currentNoteId = useCurrentNoteStore.getState().currentNote?.id;
    if (currentNoteId) return currentNoteId;
    return useCurrentNoteStore.getState().currentFileNote?.id ?? null;
  }, []);
  const handleSelectNoteByIdForSearch = useCallback(
    async (noteId: string) => {
      // ノートとファイルノートの両方から探す（クロスノート検索結果は両方を含むため）
      const n = useNotesStore
        .getState()
        .notes.find((note) => note.id === noteId);
      if (n) {
        if (useSplitEditorStore.getState().isSplit)
          await handleSelectNoteForPane(n);
        else await handleSelecAnyNote(n);
        return;
      }
      const fn = useFileNotesStore
        .getState()
        .fileNotes.find((file) => file.id === noteId);
      if (!fn) return;
      if (useSplitEditorStore.getState().isSplit)
        await handleSelectNoteForPane(fn);
      else await handleSelecAnyNote(fn);
    },
    [handleSelectNoteForPane, handleSelecAnyNote],
  );
  useEffect(() => {
    useSearchReplaceStore.getState().setContext({
      getNotes: () => useNotesStore.getState().notes,
      getFileNotes: () => useFileNotesStore.getState().fileNotes,
      setNotes: (updater) => useNotesStore.getState().setNotes(updater),
      setFileNotes: (updater) =>
        useFileNotesStore.getState().setFileNotes(updater),
      getActiveEditor,
      getActiveNoteId,
      t,
      onSelectNote: handleSelectNoteByIdForSearch,
    });
  }, [getActiveEditor, getActiveNoteId, t, handleSelectNoteByIdForSearch]);

  // 3) ハンドラ・派生値
  // 設定の最新値はストアから直接取得する（購読不要）
  const savePaneSizes = useCallback(
    (sizes: {
      sidebarWidth: number;
      splitPaneSize: number;
      markdownPreviewPaneSize: number;
    }) => {
      const current = useEditorSettingsStore.getState().settings;
      saveAndApplyEditorSettings({
        ...current,
        sidebarWidth: sizes.sidebarWidth,
        splitPaneSize: sizes.splitPaneSize,
        markdownPreviewPaneSize: sizes.markdownPreviewPaneSize,
      });
    },
    [],
  );

  // canSplit / orderedAvailableNotes / canSelectAdjacent* の派生計算は
  // EditorArea / Sidebar 内部で行う（App.tsx を notes 変化で再レンダーさせないため）。
  // App のハンドラはイベント時に store から都度読む形でこれらを再構築する。

  // ハンドラから呼ぶ orderedAvailableNotes 構築。getState ベースで参照を都度作る。
  const buildOrderedAvailableNotes = useCallback((): (Note | FileNote)[] => {
    const { notes, topLevelOrder } = useNotesStore.getState();
    const fileNotes = useFileNotesStore.getState().fileNotes;
    const activeNotes = notes.filter((n) => !n.archived);
    const noteMap = new Map(activeNotes.map((n) => [n.id, n]));
    const result: (Note | FileNote)[] = [...fileNotes];
    const seen = new Set<string>();
    for (const item of topLevelOrder) {
      if (item.type === 'note') {
        const n = noteMap.get(item.id);
        if (n && !seen.has(n.id)) {
          result.push(n);
          seen.add(n.id);
        }
      } else if (item.type === 'folder') {
        for (const n of activeNotes) {
          if (n.folderId === item.id && !seen.has(n.id)) {
            result.push(n);
            seen.add(n.id);
          }
        }
      }
    }
    for (const n of activeNotes) {
      if (!seen.has(n.id)) {
        result.push(n);
        seen.add(n.id);
      }
    }
    return result;
  }, []);

  // 指定ペインに対し、ノートリスト順序に従って隣接ノートを選択する
  const handleSelectAdjacentForPane = useCallback(
    async (pane: 'left' | 'right', direction: 'next' | 'previous') => {
      const list = buildOrderedAvailableNotes();
      if (list.length === 0) return;

      const { isSplit, leftNote, leftFileNote, rightNote, rightFileNote } =
        useSplitEditorStore.getState();
      const { currentNote, currentFileNote } = useCurrentNoteStore.getState();
      const paneNote = isSplit
        ? pane === 'left'
          ? (leftNote ?? leftFileNote)
          : (rightNote ?? rightFileNote)
        : (currentNote ?? currentFileNote);

      const otherPaneNoteId = isSplit
        ? pane === 'left'
          ? (rightNote?.id ?? rightFileNote?.id)
          : (leftNote?.id ?? leftFileNote?.id)
        : undefined;

      let idx = paneNote
        ? list.findIndex((n) => n.id === paneNote.id)
        : direction === 'next'
          ? -1
          : 0;
      const step = direction === 'next' ? 1 : -1;
      for (let i = 0; i < list.length; i++) {
        idx = (idx + step + list.length) % list.length;
        const candidate = list[idx];
        if (otherPaneNoteId && candidate.id === otherPaneNoteId) continue;
        if (paneNote && candidate.id === paneNote.id) continue;
        if (isSplit) {
          handleFocusPane(pane);
          await handleSelectNoteForPane(candidate);
        } else {
          await handleSelecAnyNote(candidate);
        }
        return;
      }
    },
    [
      buildOrderedAvailableNotes,
      handleFocusPane,
      handleSelectNoteForPane,
      handleSelecAnyNote,
    ],
  );

  const leftOnSelectNext = useCallback(
    () => handleSelectAdjacentForPane('left', 'next'),
    [handleSelectAdjacentForPane],
  );
  const leftOnSelectPrevious = useCallback(
    () => handleSelectAdjacentForPane('left', 'previous'),
    [handleSelectAdjacentForPane],
  );
  const rightOnSelectNext = useCallback(
    () => handleSelectAdjacentForPane('right', 'next'),
    [handleSelectAdjacentForPane],
  );
  const rightOnSelectPrevious = useCallback(
    () => handleSelectAdjacentForPane('right', 'previous'),
    [handleSelectAdjacentForPane],
  );

  // フォーカス中ペインに対する隣接選択 (キーボードショートカット用)
  const handleSelectNextInFocusedPane = useCallback(() => {
    const { isSplit, focusedPane } = useSplitEditorStore.getState();
    return handleSelectAdjacentForPane(isSplit ? focusedPane : 'left', 'next');
  }, [handleSelectAdjacentForPane]);
  const handleSelectPreviousInFocusedPane = useCallback(() => {
    const { isSplit, focusedPane } = useSplitEditorStore.getState();
    return handleSelectAdjacentForPane(
      isSplit ? focusedPane : 'left',
      'previous',
    );
  }, [handleSelectAdjacentForPane]);

  const handleToggleSplit = useCallback(() => {
    const { isSplit } = useSplitEditorStore.getState();
    if (!isSplit) {
      // canSplit 判定はストアの最新値で行う
      const { notes, topLevelOrder } = useNotesStore.getState();
      const fileNotes = useFileNotesStore.getState().fileNotes;
      const activeCount = notes.reduce((c, n) => c + (n.archived ? 0 : 1), 0);
      if (fileNotes.length + activeCount < 2) return;
      const { currentNote, currentFileNote } = useCurrentNoteStore.getState();
      const leftId = currentNote?.id || currentFileNote?.id;
      const firstOther =
        fileNotes.find((fn) => fn.id !== leftId) ||
        (() => {
          for (const item of topLevelOrder) {
            if (item.type === 'note') {
              const n = notes.find(
                (n) => n.id === item.id && !n.archived && n.id !== leftId,
              );
              if (n) return n;
            } else if (item.type === 'folder') {
              const n = notes.find(
                (n) => n.folderId === item.id && !n.archived && n.id !== leftId,
              );
              if (n) return n;
            }
          }
          return undefined;
        })();
      toggleSplit(firstOther ?? undefined);
    } else {
      toggleSplit();
    }
  }, [toggleSplit]);

  const findFirstOtherNote = useCallback(
    (...excludeIds: string[]): Note | FileNote | undefined => {
      const { notes, topLevelOrder } = useNotesStore.getState();
      const fileNotes = useFileNotesStore.getState().fileNotes;
      const excluded = new Set(excludeIds);
      const found = fileNotes.find((fn) => !excluded.has(fn.id));
      if (found) return found;
      for (const item of topLevelOrder) {
        if (item.type === 'note') {
          const n = notes.find(
            (n) => n.id === item.id && !n.archived && !excluded.has(n.id),
          );
          if (n) return n;
        } else if (item.type === 'folder') {
          const n = notes.find(
            (n) => n.folderId === item.id && !n.archived && !excluded.has(n.id),
          );
          if (n) return n;
        }
      }
      return undefined;
    },
    [],
  );

  // 指定 ID 直後のノート(orderedAvailableNotes 上)を返す。最後だった場合は直前。
  // skipIds は除外。アーカイブ等で「次のノート」を開きたいとき向け。
  const findNoteAfterPosition = useCallback(
    (afterId: string, ...skipIds: string[]): Note | FileNote | undefined => {
      const list = buildOrderedAvailableNotes();
      const idx = list.findIndex((n) => n.id === afterId);
      if (idx < 0) return undefined;
      const skip = new Set([afterId, ...skipIds.filter(Boolean)]);
      for (let i = idx + 1; i < list.length; i++) {
        if (!skip.has(list[i].id)) return list[i];
      }
      for (let i = idx - 1; i >= 0; i--) {
        if (!skip.has(list[i].id)) return list[i];
      }
      return undefined;
    },
    [buildOrderedAvailableNotes],
  );

  const handleOpenNoteInPane = useCallback(
    (note: Note | FileNote, pane: 'left' | 'right') => {
      // canSplit はストアから即時計算
      if (!useSplitEditorStore.getState().isSplit) {
        const activeCount = useNotesStore
          .getState()
          .notes.reduce((c, n) => c + (n.archived ? 0 : 1), 0);
        const fileNotesCount = useFileNotesStore.getState().fileNotes.length;
        if (fileNotesCount + activeCount < 2) return;
      }
      const fallback = findFirstOtherNote(note.id);
      openNoteInPane(note, pane, fallback);
    },
    [openNoteInPane, findFirstOtherNote],
  );

  const replacePaneAfterClose = useCallback(
    (closedId: string, explicitReplacement?: Note | FileNote) => {
      const {
        isSplit,
        leftNote,
        leftFileNote,
        rightNote,
        rightFileNote,
        focusedPane,
      } = useSplitEditorStore.getState();
      if (!isSplit) return;
      const leftId = leftNote?.id ?? leftFileNote?.id;
      const rightId = rightNote?.id ?? rightFileNote?.id;
      const inLeft = leftId === closedId;
      const inRight = rightId === closedId;

      if (!inLeft && !inRight) return;
      if (inLeft && inRight) return;

      const setPaneNote = (pane: 'left' | 'right', note: Note | FileNote) => {
        const isFile = 'filePath' in note;
        if (pane === 'left') {
          setLeftNote(isFile ? null : (note as Note));
          setLeftFileNote(isFile ? (note as FileNote) : null);
        } else {
          setRightNote(isFile ? null : (note as Note));
          setRightFileNote(isFile ? (note as FileNote) : null);
        }
        if (focusedPane === pane) {
          setCurrentNote(isFile ? null : (note as Note));
          setCurrentFileNote(isFile ? (note as FileNote) : null);
        }
      };

      if (inLeft) {
        const replacement =
          explicitReplacement ?? findFirstOtherNote(closedId, rightId ?? '');
        if (replacement) {
          setPaneNote('left', replacement);
        } else {
          toggleSplit();
        }
      } else if (inRight) {
        const replacement =
          explicitReplacement ?? findFirstOtherNote(closedId, leftId ?? '');
        if (replacement) {
          setPaneNote('right', replacement);
        } else {
          toggleSplit();
        }
      }
      saveSplitState();
    },
    [
      findFirstOtherNote,
      setLeftNote,
      setLeftFileNote,
      setRightNote,
      setRightFileNote,
      setCurrentNote,
      setCurrentFileNote,
      toggleSplit,
      saveSplitState,
    ],
  );

  const handleArchiveNoteWithSplit = useCallback(
    async (noteId: string) => {
      // 分割表示中はアーカイブ前に「次のノート」を確定する。
      // (アーカイブ後は orderedAvailableNotes から対象が消えて位置が取れなくなるため)
      let replacement: Note | FileNote | undefined;
      const { isSplit, leftNote, leftFileNote, rightNote, rightFileNote } =
        useSplitEditorStore.getState();
      if (isSplit) {
        const otherPaneId =
          (leftNote?.id ?? leftFileNote?.id) === noteId
            ? (rightNote?.id ?? rightFileNote?.id ?? '')
            : (leftNote?.id ?? leftFileNote?.id ?? '');
        replacement = findNoteAfterPosition(noteId, otherPaneId);
      }
      await handleArchiveNote(noteId);
      replacePaneAfterClose(noteId, replacement);
    },
    [handleArchiveNote, replacePaneAfterClose, findNoteAfterPosition],
  );

  const handleCloseFileWithSplit = useCallback(
    async (fileNote: FileNote) => {
      // 閉じるファイルを最近開いたファイルに追加
      if (fileNote.filePath) {
        addRecentFile(fileNote.filePath);
      }
      await handleCloseFile(fileNote);
      if (!useSplitEditorStore.getState().isSplit) {
        // Override the wrong selection made by handleCloseFile
        // (which picks array-first instead of topLevelOrder-first)
        const replacement = findFirstOtherNote(fileNote.id);
        if (replacement) {
          const isFile = 'filePath' in replacement;
          setCurrentNote(isFile ? null : (replacement as Note));
          setCurrentFileNote(isFile ? (replacement as FileNote) : null);
        }
        return;
      }
      replacePaneAfterClose(fileNote.id);
    },
    [
      handleCloseFile,
      replacePaneAfterClose,
      findFirstOtherNote,
      setCurrentNote,
      setCurrentFileNote,
      addRecentFile,
    ],
  );

  const handleDropFileNoteToNotes = useCallback(
    async (
      fileNoteId: string,
      target: {
        kind: string;
        destinationIndex?: number;
        folderId?: string;
        topLevelInsertIndex?: number;
      },
    ) => {
      const fileNotes = useFileNotesStore.getState().fileNotes;
      const fileNote = fileNotes.find((value) => value.id === fileNoteId);
      if (!fileNote) return;
      const wasCurrentFile =
        useCurrentNoteStore.getState().currentFileNote?.id === fileNoteId;
      const splitState = useSplitEditorStore.getState();
      const wasLeftFile = splitState.leftFileNote?.id === fileNoteId;
      const wasRightFile = splitState.rightFileNote?.id === fileNoteId;
      const isSplit = splitState.isSplit;

      const newNote: Note = {
        id: crypto.randomUUID(),
        title: fileNote.fileName.replace(/\.[^/.]+$/, ''),
        content: fileNote.content,
        contentHeader: null,
        language: fileNote.language,
        modifiedTime: new Date().toISOString(),
        archived: false,
        ...(target.kind === 'folder' ? { folderId: target.folderId } : {}),
      };

      const remainingFileNotes = fileNotes.filter(
        (value) => value.id !== fileNoteId,
      );
      const { notes, topLevelOrder } = useNotesStore.getState();
      const activeNotes = notes.filter((note) => !note.archived);
      const archivedNotes = notes.filter((note) => note.archived);

      let insertedActiveNotes = [...activeNotes];
      let destinationIndex = activeNotes.length;
      if (target.kind === 'flat' || target.kind === 'folder') {
        destinationIndex = clamp(
          target.destinationIndex ?? 0,
          0,
          activeNotes.length,
        );
        insertedActiveNotes = [
          ...activeNotes.slice(0, destinationIndex),
          newNote,
          ...activeNotes.slice(destinationIndex),
        ];
      } else {
        insertedActiveNotes = [...activeNotes, newNote];
      }

      setFileNotes(remainingFileNotes);
      setNotes([...insertedActiveNotes, ...archivedNotes]);

      // 永続化はバックエンドに投げて即進める
      handleSaveFileNotes(remainingFileNotes);
      SaveNote(backend.Note.createFrom(newNote), 'create').catch((err) =>
        console.error('SaveNote (drop file→note) failed:', err),
      );

      if (target.kind === 'top-level') {
        const nextOrder = insertTopLevelNote(
          topLevelOrder,
          newNote.id,
          target.topLevelInsertIndex ?? 0,
        );
        handleUpdateTopLevelOrder(nextOrder);
      } else {
        UpdateNoteOrder(newNote.id, destinationIndex).catch((error) => {
          console.error('Failed to update converted note order:', error);
        });
      }

      let replacedPane = false;
      if (isSplit) {
        if (wasLeftFile) {
          setLeftFileNote(null);
          setLeftNote(newNote);
          replacedPane = true;
        }
        if (wasRightFile) {
          setRightFileNote(null);
          setRightNote(newNote);
          replacedPane = true;
        }
        if (wasCurrentFile) {
          setCurrentFileNote(null);
          setCurrentNote(newNote);
        }
        if (replacedPane) {
          saveSplitState();
        }
      }

      if (!isSplit || !replacedPane) {
        await handleSelecAnyNote(newNote);
      }
    },
    [
      handleSaveFileNotes,
      handleSelecAnyNote,
      handleUpdateTopLevelOrder,
      saveSplitState,
      setFileNotes,
      setLeftFileNote,
      setLeftNote,
      setRightFileNote,
      setRightNote,
      setCurrentFileNote,
      setCurrentNote,
      setNotes,
    ],
  );

  const handleConvertToNoteWithPlacement = useCallback(
    async (fileNote: FileNote) => {
      const hasActiveFolders = useNotesStore
        .getState()
        .folders.some((folder) => !folder.archived);
      if (hasActiveFolders) {
        await handleDropFileNoteToNotes(fileNote.id, {
          kind: 'top-level',
          topLevelInsertIndex: 0,
        });
        return;
      }
      await handleDropFileNoteToNotes(fileNote.id, {
        kind: 'flat',
        destinationIndex: 0,
      });
    },
    [handleDropFileNoteToNotes],
  );

  // ショートカット経由の操作を、分割対応ハンドラに差し替え
  archiveNoteRef.current = handleArchiveNoteWithSplit;
  closeFileRef.current = handleCloseFileWithSplit;

  // グローバルキーボードショートカット
  useKeyboardShortcuts({
    setCurrentFileNote,
    handleNewNote,
    handleOpenFile,
    handleSaveFile,
    handleSaveAsFile,
    handleCloseFile: useCallback(
      (file: FileNote) => closeFileRef.current(file),
      [],
    ),
    handleArchiveNote: useCallback(
      (noteId: string) => archiveNoteRef.current(noteId),
      [],
    ),
    handleSelectNextAnyNote: handleSelectNextInFocusedPane,
    handleSelectPreviousAnyNote: handleSelectPreviousInFocusedPane,
    isFileModified,
    onOpenFind: useCallback(
      () => useSearchReplaceStore.getState().focusFind('find'),
      [],
    ),
    onOpenReplace: useCallback(
      () => useSearchReplaceStore.getState().focusFind('replace'),
      [],
    ),
    onOpenFindInAll: useCallback(
      () => useSearchReplaceStore.getState().focusFind('find'),
      [],
    ),
  });

  const TITLE_BAR_HEIGHT = platform === 'darwin' ? 26 : 0;

  const handleToggleShowArchived = useCallback(() => {
    setShowArchived((prev) => !prev);
  }, [setShowArchived]);

  const handleSidebarSelectAnyNote = useCallback(
    async (note: Note | FileNote) => {
      if (useNotesStore.getState().showArchived) {
        setShowArchived(false);
      }
      if (useSplitEditorStore.getState().isSplit) {
        await handleSelectNoteForPane(note);
      } else {
        await handleSelecAnyNote(note);
      }
    },
    [setShowArchived, handleSelectNoteForPane, handleSelecAnyNote],
  );

  // 4) Allotment onChange (エディタ領域)
  const handleEditorAllotmentChange = useCallback(
    (sizes: number[]) => {
      const { isSplit, isMarkdownPreview } = useSplitEditorStore.getState();
      if (isSplit && sizes.length >= 2) {
        const total = sizes[0] + sizes[1];
        if (total > 0) {
          handleSplitPaneSizeChange(sizes[0] / total);
          schedulePaneSizeSave(savePaneSizes);
        }
      } else if (isMarkdownPreview && sizes.length >= 2) {
        const total = sizes[0] + sizes[1];
        if (total > 0) {
          const isPreviewOnLeft =
            useEditorSettingsStore.getState().settings.markdownPreviewOnLeft;
          const previewSize = isPreviewOnLeft ? sizes[0] : sizes[1];
          handleMarkdownPreviewPaneSizeChange(previewSize / total);
          schedulePaneSizeSave(savePaneSizes);
        }
      }
    },
    [
      handleSplitPaneSizeChange,
      handleMarkdownPreviewPaneSizeChange,
      schedulePaneSizeSave,
      savePaneSizes,
    ],
  );

  // 5) 左右ペインのハンドラ
  const leftOnTitleChange = useCallback(
    (title: string) => {
      const { isSplit, leftNote } = useSplitEditorStore.getState();
      if (isSplit) {
        if (leftNote) handleLeftNoteTitleChange(title);
      } else {
        handleTitleChange(title);
      }
    },
    [handleLeftNoteTitleChange, handleTitleChange],
  );

  const leftOnLanguageChange = useCallback(
    (language: string) => {
      const { isSplit, leftNote, leftFileNote } =
        useSplitEditorStore.getState();
      if (isSplit) {
        if (leftNote) {
          handleLeftNoteLanguageChange(language);
        } else if (leftFileNote) {
          setLeftFileNote({ ...leftFileNote, language });
        }
      } else {
        handleLanguageChange(language);
      }
      // ハンドラから直接Monacoに言語を適用（useEffect不要）
      applyLanguageToEditor(leftEditorInstanceRef.current, language);
    },
    [handleLeftNoteLanguageChange, setLeftFileNote, handleLanguageChange],
  );

  // 非スプリット時は store からの判定に切り替えて App.tsx の再描画を回避する
  const leftOnChange = useCallback(
    (value: string) => {
      const { isSplit, leftNote } = useSplitEditorStore.getState();
      if (isSplit) {
        if (leftNote) handleLeftNoteContentChange(value);
        else handleLeftFileNoteContentChange(value);
        return;
      }
      const { currentNote, currentFileNote } = useCurrentNoteStore.getState();
      if (currentNote) handleNoteContentChange(value);
      else if (currentFileNote) handleFileNoteContentChange(value);
    },
    [
      handleLeftNoteContentChange,
      handleLeftFileNoteContentChange,
      handleNoteContentChange,
      handleFileNoteContentChange,
    ],
  );

  const leftOnSave = useCallback(async () => {
    const { isSplit, leftFileNote } = useSplitEditorStore.getState();
    if (isSplit) {
      if (leftFileNote && isFileModified(leftFileNote.id)) {
        await handleSaveFile(leftFileNote);
      }
    } else {
      const cfn = useCurrentNoteStore.getState().currentFileNote;
      if (cfn && isFileModified(cfn.id)) {
        await handleSaveFile(cfn);
      }
    }
  }, [isFileModified, handleSaveFile]);

  const leftOnClose = useCallback(async () => {
    const { isSplit, leftFileNote, leftNote } = useSplitEditorStore.getState();
    if (isSplit) {
      if (leftFileNote) {
        await handleCloseFileWithSplit(leftFileNote);
      } else if (leftNote) {
        await handleArchiveNoteWithSplit(leftNote.id);
      }
    } else {
      const { currentNote, currentFileNote } = useCurrentNoteStore.getState();
      if (currentFileNote) {
        await handleCloseFileWithSplit(currentFileNote);
      } else if (currentNote) {
        await handleArchiveNoteWithSplit(currentNote.id);
      }
    }
  }, [handleCloseFileWithSplit, handleArchiveNoteWithSplit]);

  const rightOnTitleChange = useCallback(
    (title: string) => {
      const { rightNote } = useSplitEditorStore.getState();
      if (rightNote) handleRightNoteTitleChange(title);
    },
    [handleRightNoteTitleChange],
  );

  const rightOnLanguageChange = useCallback(
    (language: string) => {
      const { rightNote, rightFileNote } = useSplitEditorStore.getState();
      if (rightNote) {
        handleRightNoteLanguageChange(language);
      } else if (rightFileNote) {
        setRightFileNote({ ...rightFileNote, language });
      }
      // ハンドラから直接Monacoに言語を適用（useEffect不要）
      applyLanguageToEditor(rightEditorInstanceRef.current, language);
    },
    [handleRightNoteLanguageChange, setRightFileNote],
  );

  const rightOnChange = useCallback(
    (value: string) => {
      const { rightNote } = useSplitEditorStore.getState();
      if (rightNote) handleRightNoteContentChange(value);
      else handleRightFileNoteContentChange(value);
    },
    [handleRightNoteContentChange, handleRightFileNoteContentChange],
  );

  const rightOnSave = useCallback(async () => {
    const { rightFileNote } = useSplitEditorStore.getState();
    if (rightFileNote && isFileModified(rightFileNote.id)) {
      await handleSaveFile(rightFileNote);
    }
  }, [isFileModified, handleSaveFile]);

  const rightOnClose = useCallback(async () => {
    const { rightFileNote, rightNote } = useSplitEditorStore.getState();
    if (rightFileNote) {
      await handleCloseFileWithSplit(rightFileNote);
    } else if (rightNote) {
      await handleArchiveNoteWithSplit(rightNote.id);
    }
  }, [handleCloseFileWithSplit, handleArchiveNoteWithSplit]);

  // ConflictBackupsDialog の復元ハンドラを useDialogsStore に登録する。
  // ダイアログ自体は <DialogHost /> 経由で App ツリー外に切り出されているので、
  // notes / topLevelOrder / showArchived など App 配下の state を触る処理は
  // 「register/unregister」方式でブリッジする。
  const handleRestoreFromBackup = useCallback(
    async (sourceNote: Note) => {
      const baseTitle = sourceNote.title?.trim();
      const restoredTitle = baseTitle
        ? t('conflictBackups.restoredTitle', { title: baseTitle })
        : t('conflictBackups.restoredUntitled');
      const newNote: Note = {
        id: crypto.randomUUID(),
        title: restoredTitle,
        content: sourceNote.content || '',
        contentHeader: null,
        language: sourceNote.language || 'plaintext',
        modifiedTime: new Date().toISOString(),
        archived: false,
      };
      setShowArchived(false);
      setNotes((prev) => [newNote, ...prev]);
      setTopLevelOrder((prev) => [{ type: 'note', id: newNote.id }, ...prev]);
      setCurrentFileNote(null);
      setCurrentNote(newNote);
      SaveNote(backend.Note.createFrom(newNote), 'create').catch((err) =>
        console.error('SaveNote (restore) failed:', err),
      );
      void SetLastActiveNote(newNote.id, false);
    },
    [
      t,
      setShowArchived,
      setNotes,
      setTopLevelOrder,
      setCurrentFileNote,
      setCurrentNote,
    ],
  );

  useEffect(() => {
    useDialogsStore.getState().setRestoreHandler(handleRestoreFromBackup);
    return () => {
      useDialogsStore.getState().setRestoreHandler(null);
    };
  }, [handleRestoreFromBackup]);

  // 6) JSX
  // ThemeProvider / CssBaseline / MessageDialog は <Providers>（main.tsx）で
  // 注入されるので、App はレイアウト + dialog host のみを返す。
  return (
    <Box
      sx={{
        width: '100vw',
        height: '100vh',
        position: 'relative',
      }}
      component="main"
    >
      {/* macOS タイトルバー */}
      {platform !== 'windows' && (
        <Box
          sx={{
            height: 26,
            width: '100vw',
            '--wails-draggable': 'drag',
            backgroundColor: isDarkMode
              ? 'rgba(255, 255, 255, 0.2)'
              : 'rgba(0, 0, 0, 0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onDoubleClick={() => {
            WindowToggleMaximise();
          }}
        >
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              fontWeight: 'bold',
              userSelect: 'none',
              pointerEvents: 'none',
            }}
          >
            {t('app.titleBar')}
          </Typography>
        </Box>
      )}

      {/* メインレイアウト: サイドバー + エディタ領域 */}
      <Box
        sx={{
          position: 'absolute',
          top: TITLE_BAR_HEIGHT,
          left: 0,
          right: 0,
          bottom: 0,
        }}
      >
        <Allotment
          proportionalLayout={false}
          onDragStart={() => {
            isSidebarDraggingRef.current = true;
          }}
          onChange={(sizes) => {
            if (!isSidebarDraggingRef.current || !sizes[0]) return;
            handleSidebarWidthChange(sizes[0]);
          }}
          onDragEnd={(sizes) => {
            isSidebarDraggingRef.current = false;
            if (!sizes[0]) return;

            const nextSidebarWidth = clamp(sizes[0], 242, 500);
            handleSidebarWidthChange(nextSidebarWidth);
            savePaneSizes({
              sidebarWidth: nextSidebarWidth,
              splitPaneSize,
              markdownPreviewPaneSize,
            });
          }}
        >
          <Allotment.Pane
            preferredSize={sidebarWidth}
            minSize={242}
            maxSize={500}
          >
            <Sidebar
              platform={platform}
              systemLocale={systemLocale}
              onNew={handleNewNote}
              onOpen={handleOpenFile}
              onSaveAs={handleSaveAsFile}
              onNoteSelect={handleSidebarSelectAnyNote}
              onArchive={handleArchiveNoteWithSplit}
              onCloseFile={handleCloseFileWithSplit}
              onSaveFile={handleSaveFile}
              onConvertToNote={handleConvertToNoteWithPlacement}
              onDropFileNoteToNotes={handleDropFileNoteToNotes}
              onOpenInPane={handleOpenNoteInPane}
              isFileModified={isFileModified}
              onToggleFolderCollapse={toggleFolderCollapse}
              onMoveNoteToFolder={handleMoveNoteToFolder}
              onRenameFolder={handleRenameFolder}
              onDeleteFolder={handleDeleteFolder}
              onArchiveFolder={handleArchiveFolder}
              onCreateFolder={handleCreateFolder}
              onUpdateTopLevelOrder={handleUpdateTopLevelOrder}
              recentFiles={recentFiles}
              openRecentFile={openRecentFile}
              removeRecentFile={removeRecentFile}
              clearRecentFiles={clearRecentFiles}
              onToggleShowArchived={handleToggleShowArchived}
            />
          </Allotment.Pane>

          <Allotment.Pane>
            <EditorArea
              onUnarchive={handleUnarchiveNote}
              onDelete={handleDeleteNote}
              onDeleteAll={async () => {
                const confirmed = await showMessage(
                  t('archived.deleteAllDialogTitle'),
                  t('archived.deleteAllDialogMessage'),
                  true,
                  t('dialog.delete'),
                  t('dialog.cancel'),
                );
                if (confirmed) handleDeleteAllArchivedNotes();
              }}
              onCloseArchived={() => setShowArchived(false)}
              onUnarchiveFolder={handleUnarchiveFolder}
              onDeleteFolder={handleDeleteArchivedFolder}
              onUpdateArchivedTopLevelOrder={handleUpdateArchivedTopLevelOrder}
              onMoveNoteToFolder={handleMoveNoteToFolder}
              getAllotmentSizes={getAllotmentSizes}
              onAllotmentChange={handleEditorAllotmentChange}
              languages={languages}
              platform={platform}
              systemLocale={systemLocale}
              leftEditorInstanceRef={leftEditorInstanceRef}
              rightEditorInstanceRef={rightEditorInstanceRef}
              leftOnTitleChange={leftOnTitleChange}
              leftOnLanguageChange={leftOnLanguageChange}
              leftOnChange={leftOnChange}
              leftOnSave={leftOnSave}
              leftOnClose={leftOnClose}
              rightOnTitleChange={rightOnTitleChange}
              rightOnLanguageChange={rightOnLanguageChange}
              rightOnChange={rightOnChange}
              rightOnSave={rightOnSave}
              rightOnClose={rightOnClose}
              onFocusPane={handleFocusPane}
              onNew={handleNewNote}
              onOpen={handleOpenFile}
              leftOnSelectNext={leftOnSelectNext}
              leftOnSelectPrevious={leftOnSelectPrevious}
              rightOnSelectNext={rightOnSelectNext}
              rightOnSelectPrevious={rightOnSelectPrevious}
              onToggleSplit={handleToggleSplit}
              onToggleMarkdownPreview={toggleMarkdownPreview}
              onSettings={() => useDialogsStore.getState().openSettings()}
              showMessage={showMessage}
              onOpenFind={() =>
                useSearchReplaceStore.getState().focusFind('find')
              }
              onOpenReplace={() =>
                useSearchReplaceStore.getState().focusFind('replace')
              }
              onOpenFindInAll={() =>
                useSearchReplaceStore.getState().focusFind('find')
              }
            />
          </Allotment.Pane>
        </Allotment>
      </Box>
    </Box>
  );
}

export default App;
