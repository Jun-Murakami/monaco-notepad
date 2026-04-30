import { Box, CssBaseline, ThemeProvider, Typography } from '@mui/material';
import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import React, {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import {
  SaveNote,
  SetLastActiveNote,
  UpdateNoteOrder,
} from '../wailsjs/go/backend/App';
import { backend } from '../wailsjs/go/models';
import { WindowToggleMaximise } from '../wailsjs/runtime';
import { EditorArea } from './components/EditorArea';
import { MessageDialog } from './components/MessageDialog';
import { insertTopLevelNote } from './components/NoteList';
import { Sidebar } from './components/Sidebar';
import { applyLanguageToEditor } from './stores/useEditorSettingsStore';

import type { editor } from 'monaco-editor';

// Lazy-loaded components (not needed on first render)
const SettingsDialog = React.lazy(() =>
  import('./components/SettingsDialog').then((m) => ({
    default: m.SettingsDialog,
  })),
);
const LicenseDialog = React.lazy(() =>
  import('./components/LicenseDialog').then((m) => ({
    default: m.LicenseDialog,
  })),
);
const ConflictBackupsDialog = React.lazy(() =>
  import('./components/ConflictBackupsDialog').then((m) => ({
    default: m.ConflictBackupsDialog,
  })),
);

import { darkTheme, lightTheme } from './lib/theme';
import { useEditorSettings } from './hooks/useEditorSettings';
import { useFileNotes } from './hooks/useFileNotes';
import { useFileOperations } from './hooks/useFileOperations';
import { useInitialize } from './hooks/useInitialize';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useMessageDialog } from './hooks/useMessageDialog';
import { useNoteSearch } from './hooks/useNoteSearch';
import { useNoteSelecter } from './hooks/useNoteSelecter';
import { useNotes } from './hooks/useNotes';
import { usePaneSizes } from './hooks/usePaneSizes';
import { useRecentFiles } from './hooks/useRecentFiles';
import { useSearchReplace } from './hooks/useSearchReplace';
import { useSplitEditor } from './hooks/useSplitEditor';

import type { FileNote, Note, TopLevelItem } from './types';

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

function App() {
  const { t } = useTranslation();

  // 1) 内部状態（ref / useState）
  const onNotesReloadedRef = useRef<
    ((notes: Note[], topLevelOrder?: TopLevelItem[]) => void) | null
  >(null);
  const isSplitRef = useRef<boolean>(false);
  const focusedPaneRef = useRef<'left' | 'right'>('left');
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
  const settingsOpenCountRef = useRef(0);

  const leftEditorInstanceRef = useRef<editor.IStandaloneCodeEditor | null>(
    null,
  );
  const rightEditorInstanceRef = useRef<editor.IStandaloneCodeEditor | null>(
    null,
  );

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [isConflictBackupsOpen, setIsConflictBackupsOpen] = useState(false);

  // 2) カスタムフック
  // エディタ設定
  const { editorSettings, setEditorSettings } = useEditorSettings();

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
  } = usePaneSizes(editorSettings);

  // メッセージダイアログ
  const {
    isMessageDialogOpen,
    messageTitle,
    messageContent,
    showMessage,
    onResult,
    isTwoButton,
    primaryButtonText,
    secondaryButtonText,
  } = useMessageDialog();

  // ノート
  const {
    notes,
    setNotes,
    currentNote,
    setCurrentNote,
    showArchived,
    setShowArchived,
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
    pendingContentRef,
  } = useNotes({
    onNotesReloaded: onNotesReloadedRef,
    isSplit: false,
    focusedPane: 'left',
  });

  // ファイルノート
  const {
    fileNotes,
    setFileNotes,
    currentFileNote,
    setCurrentFileNote,
    handleSelectFileNote,
    handleSaveFileNotes,
    handleFileNoteContentChange,
    handleCloseFile,
    isFileModified,
  } = useFileNotes({
    notes,
    setCurrentNote,
    handleNewNote,
    handleSelectNote,
    showMessage,
  });

  // ノート選択ユーティリティ
  const { handleSelecAnyNote } = useNoteSelecter({
    currentNote,
    currentFileNote,
    notes,
    fileNotes,
    handleSelectNote,
    handleSelectFileNote,
    setCurrentNote,
    setCurrentFileNote,
  });

  // ファイル操作
  const {
    handleOpenFile,
    handleOpenFileByPath,
    handleSaveFile,
    handleSaveAsFile,
  } = useFileOperations(
    notes,
    setNotes,
    currentNote,
    currentFileNote,
    fileNotes,
    setFileNotes,
    handleSelecAnyNote,
    showMessage,
    handleSaveFileNotes,
    isSplitRef,
    openNoteInPaneRef,
    addRecentFileRef,
    pendingContentRef,
  );

  // ノート分割管理
  const {
    isSplit,
    isMarkdownPreview,
    toggleSplit,
    toggleMarkdownPreview,
    focusedPane,
    handleFocusPane,
    leftNote,
    setLeftNote,
    leftFileNote,
    setLeftFileNote,
    rightNote,
    setRightNote,
    rightFileNote,
    setRightFileNote,
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
    secondarySelectedNoteId,
    restorePaneNotes,
    saveSplitState,
    syncPaneNotes,
  } = useSplitEditor({
    currentNote,
    currentFileNote,
    setCurrentNote,
    setCurrentFileNote,
    setNotes,
  });

  // フック間で参照するため、現在の状態をrefへ同期
  onNotesReloadedRef.current = syncPaneNotes;
  isSplitRef.current = isSplit;
  focusedPaneRef.current = focusedPane;
  openNoteInPaneRef.current = openNoteInPane;
  archiveNoteRef.current = handleArchiveNote;
  closeFileRef.current = handleCloseFile;

  // 初期化
  const { languages, platform, systemLocale } = useInitialize(
    setNotes,
    setFileNotes,
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
    fileNotes,
    handleOpenFileByPath,
    showMessage,
  });
  addRecentFileRef.current = addRecentFile;

  // サイドバーノートリスト絞り込み（統合検索クエリから駆動、useEffect で同期）
  const {
    filteredNotes,
    filteredFileNotes,
    totalSearchMatches,
    searchMatchIndexInNote,
    handleSearchChange,
  } = useNoteSearch({
    notes,
    fileNotes,
    topLevelOrder,
    isSplit,
    onSelectInSplit: handleSelectNoteForPane,
    onSelectSingle: handleSelecAnyNote,
  });

  // 検索・置換パネル（アプリ統合、Monaco 標準検索は Editor 側で抑制済み）
  const getActiveEditor = useCallback(
    () =>
      (isSplit && focusedPane === 'right'
        ? rightEditorInstanceRef.current
        : leftEditorInstanceRef.current) ?? null,
    [isSplit, focusedPane],
  );
  const getActiveNoteId = useCallback((): string | null => {
    if (isSplit) {
      if (focusedPane === 'left') return leftNote?.id ?? null;
      return rightNote?.id ?? null;
    }
    return currentNote?.id ?? null;
  }, [isSplit, focusedPane, leftNote, rightNote, currentNote]);

  const searchReplace = useSearchReplace({
    notes,
    setNotes,
    getActiveEditor,
    getActiveNoteId,
    showMessage,
    t,
  });

  // 統合検索クエリを既存のサイドバー絞り込み（useNoteSearch）にも流し込む。
  // 正規表現/大小区別は編集面のみ適用し、絞り込みは従来通り部分一致で動作させる。
  useEffect(() => {
    handleSearchChange(searchReplace.query);
  }, [searchReplace.query, handleSearchChange]);

  // 3) ハンドラ・派生値
  // refを使って常に最新のeditorSettingsを参照し、デバウンスタイマー内のステールクロージャを防止する
  const editorSettingsRef = useRef(editorSettings);
  editorSettingsRef.current = editorSettings;
  const savePaneSizes = useCallback(
    (sizes: {
      sidebarWidth: number;
      splitPaneSize: number;
      markdownPreviewPaneSize: number;
    }) => {
      setEditorSettings({
        ...editorSettingsRef.current,
        sidebarWidth: sizes.sidebarWidth,
        splitPaneSize: sizes.splitPaneSize,
        markdownPreviewPaneSize: sizes.markdownPreviewPaneSize,
      });
    },
    [setEditorSettings],
  );

  const totalAvailableItems =
    fileNotes.length + notes.filter((n) => !n.archived).length;
  const canSplit = isSplit || totalAvailableItems >= 2;

  // ノートリスト表示順序に従った巡回対象ノート列
  // (ローカルファイル → topLevelOrder の順、フォルダ内ノートは folderId 一致順)
  const orderedAvailableNotes = ((): (Note | FileNote)[] => {
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

    // topLevelOrder にもフォルダにも紐づかないフォールバックノート
    for (const n of activeNotes) {
      if (!seen.has(n.id)) {
        result.push(n);
        seen.add(n.id);
      }
    }
    return result;
  })();

  // 指定ペインに対し、ノートリスト順序に従って隣接ノートを選択する
  // 2 ペイン分割時は反対ペインに表示中のノートをスキップする
  const handleSelectAdjacentForPane = useCallback(
    async (pane: 'left' | 'right', direction: 'next' | 'previous') => {
      const list = orderedAvailableNotes;
      if (list.length === 0) return;

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
          // ペインが現在フォーカスでなければ先にフォーカスを移す
          // (handleSelectNoteForPane は内部の focusedPaneRef を参照するため)
          handleFocusPane(pane);
          await handleSelectNoteForPane(candidate);
        } else {
          await handleSelecAnyNote(candidate);
        }
        return;
      }
    },
    [
      orderedAvailableNotes,
      isSplit,
      leftNote,
      leftFileNote,
      rightNote,
      rightFileNote,
      currentNote,
      currentFileNote,
      handleFocusPane,
      handleSelectNoteForPane,
      handleSelecAnyNote,
    ],
  );

  // 指定ペインに対し、隣接ノート選択が可能か判定する (UIの活性制御用)
  const canSelectAdjacentForPane = useCallback(
    (pane: 'left' | 'right'): boolean => {
      const list = orderedAvailableNotes;
      if (list.length === 0) return false;
      const paneId = isSplit
        ? pane === 'left'
          ? (leftNote?.id ?? leftFileNote?.id ?? null)
          : (rightNote?.id ?? rightFileNote?.id ?? null)
        : (currentNote?.id ?? currentFileNote?.id ?? null);
      const otherId = isSplit
        ? pane === 'left'
          ? (rightNote?.id ?? rightFileNote?.id)
          : (leftNote?.id ?? leftFileNote?.id)
        : undefined;
      return list.some(
        (n) => n.id !== paneId && (!otherId || n.id !== otherId),
      );
    },
    [
      orderedAvailableNotes,
      isSplit,
      leftNote,
      leftFileNote,
      rightNote,
      rightFileNote,
      currentNote,
      currentFileNote,
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
  const canSelectAdjacentLeft = canSelectAdjacentForPane('left');
  const canSelectAdjacentRight = canSelectAdjacentForPane('right');

  // フォーカス中ペインに対する隣接選択 (キーボードショートカット用)
  const handleSelectNextInFocusedPane = useCallback(
    () => handleSelectAdjacentForPane(isSplit ? focusedPane : 'left', 'next'),
    [handleSelectAdjacentForPane, isSplit, focusedPane],
  );
  const handleSelectPreviousInFocusedPane = useCallback(
    () =>
      handleSelectAdjacentForPane(isSplit ? focusedPane : 'left', 'previous'),
    [handleSelectAdjacentForPane, isSplit, focusedPane],
  );

  const handleToggleSplit = useCallback(() => {
    if (!isSplit) {
      if (!canSplit) return;
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
  }, [
    isSplit,
    canSplit,
    currentNote,
    currentFileNote,
    fileNotes,
    notes,
    topLevelOrder,
    toggleSplit,
  ]);

  const findFirstOtherNote = useCallback(
    (...excludeIds: string[]): Note | FileNote | undefined => {
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
    [fileNotes, notes, topLevelOrder],
  );

  // 指定 ID 直後のノート(orderedAvailableNotes 上)を返す。最後だった場合は直前。
  // skipIds は除外。アーカイブ等で「次のノート」を開きたいとき向け。
  const findNoteAfterPosition = useCallback(
    (afterId: string, ...skipIds: string[]): Note | FileNote | undefined => {
      const list = orderedAvailableNotes;
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
    [orderedAvailableNotes],
  );

  const handleOpenNoteInPane = useCallback(
    (note: Note | FileNote, pane: 'left' | 'right') => {
      if (!canSplit && !isSplit) return;
      const fallback = findFirstOtherNote(note.id);
      openNoteInPane(note, pane, fallback);
    },
    [openNoteInPane, findFirstOtherNote, canSplit, isSplit],
  );

  const replacePaneAfterClose = useCallback(
    (closedId: string, explicitReplacement?: Note | FileNote) => {
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
      isSplit,
      leftNote,
      leftFileNote,
      rightNote,
      rightFileNote,
      focusedPane,
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
    [
      handleArchiveNote,
      replacePaneAfterClose,
      isSplit,
      leftNote,
      leftFileNote,
      rightNote,
      rightFileNote,
      findNoteAfterPosition,
    ],
  );

  const handleCloseFileWithSplit = useCallback(
    async (fileNote: FileNote) => {
      // 閉じるファイルを最近開いたファイルに追加
      if (fileNote.filePath) {
        addRecentFile(fileNote.filePath);
      }
      await handleCloseFile(fileNote);
      if (!isSplit) {
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
      isSplit,
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
      const fileNote = fileNotes.find((value) => value.id === fileNoteId);
      if (!fileNote) return;
      const wasCurrentFile = currentFileNote?.id === fileNoteId;
      const wasLeftFile = leftFileNote?.id === fileNoteId;
      const wasRightFile = rightFileNote?.id === fileNoteId;

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

      await handleSaveFileNotes(remainingFileNotes);
      await SaveNote(backend.Note.createFrom(newNote), 'create');

      if (target.kind === 'top-level') {
        const nextOrder = insertTopLevelNote(
          topLevelOrder,
          newNote.id,
          target.topLevelInsertIndex ?? 0,
        );
        await handleUpdateTopLevelOrder(nextOrder);
      } else {
        try {
          await UpdateNoteOrder(newNote.id, destinationIndex);
        } catch (error) {
          console.error('Failed to update converted note order:', error);
        }
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
      currentFileNote,
      fileNotes,
      handleSaveFileNotes,
      handleSelecAnyNote,
      handleUpdateTopLevelOrder,
      isSplit,
      leftFileNote,
      rightFileNote,
      notes,
      saveSplitState,
      setFileNotes,
      setLeftFileNote,
      setLeftNote,
      setRightFileNote,
      setRightNote,
      setCurrentFileNote,
      setCurrentNote,
      setNotes,
      topLevelOrder,
    ],
  );

  const handleConvertToNoteWithPlacement = useCallback(
    async (fileNote: FileNote) => {
      const hasActiveFolders = folders.some((folder) => !folder.archived);
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
    [folders, handleDropFileNoteToNotes],
  );

  // ショートカット経由の操作を、分割対応ハンドラに差し替え
  archiveNoteRef.current = handleArchiveNoteWithSplit;
  closeFileRef.current = handleCloseFileWithSplit;

  // グローバルキーボードショートカット
  useKeyboardShortcuts({
    currentNote,
    currentFileNote,
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
      () => searchReplace.focusFind('find'),
      [searchReplace],
    ),
    onOpenReplace: useCallback(
      () => searchReplace.focusFind('replace'),
      [searchReplace],
    ),
    onOpenFindInAll: useCallback(
      () => searchReplace.focusFind('find'),
      [searchReplace],
    ),
  });

  const TITLE_BAR_HEIGHT = platform === 'darwin' ? 26 : 0;

  const handleToggleShowArchived = useCallback(() => {
    setShowArchived((prev) => !prev);
  }, [setShowArchived]);

  const handleSidebarSelectAnyNote = useCallback(
    async (note: Note | FileNote) => {
      if (showArchived) {
        setShowArchived(false);
      }
      if (isSplit) {
        await handleSelectNoteForPane(note);
      } else {
        await handleSelecAnyNote(note);
      }
    },
    [
      showArchived,
      setShowArchived,
      isSplit,
      handleSelectNoteForPane,
      handleSelecAnyNote,
    ],
  );

  // 4) Allotment onChange (エディタ領域)
  const handleEditorAllotmentChange = useCallback(
    (sizes: number[]) => {
      if (isSplit && sizes.length >= 2) {
        const total = sizes[0] + sizes[1];
        if (total > 0) {
          handleSplitPaneSizeChange(sizes[0] / total);
          schedulePaneSizeSave(savePaneSizes);
        }
      } else if (isMarkdownPreview && sizes.length >= 2) {
        const total = sizes[0] + sizes[1];
        if (total > 0) {
          const isPreviewOnLeft = editorSettings.markdownPreviewOnLeft;
          const previewSize = isPreviewOnLeft ? sizes[0] : sizes[1];
          handleMarkdownPreviewPaneSizeChange(previewSize / total);
          schedulePaneSizeSave(savePaneSizes);
        }
      }
    },
    [
      isSplit,
      isMarkdownPreview,
      editorSettings.markdownPreviewOnLeft,
      handleSplitPaneSizeChange,
      handleMarkdownPreviewPaneSizeChange,
      schedulePaneSizeSave,
      savePaneSizes,
    ],
  );

  // 5) 左右ペインのハンドラ
  const leftOnTitleChange = useCallback(
    (title: string) => {
      if (isSplit) {
        if (leftNote) handleLeftNoteTitleChange(title);
      } else {
        handleTitleChange(title);
      }
    },
    [isSplit, leftNote, handleLeftNoteTitleChange, handleTitleChange],
  );

  const leftOnLanguageChange = useCallback(
    (language: string) => {
      if (isSplit) {
        if (leftNote) {
          handleLeftNoteLanguageChange(language);
        } else if (leftFileNote) {
          setLeftFileNote((prev) => (prev ? { ...prev, language } : prev));
        }
      } else {
        handleLanguageChange(language);
      }
      // ハンドラから直接Monacoに言語を適用（useEffect不要）
      applyLanguageToEditor(leftEditorInstanceRef.current, language);
    },
    [
      isSplit,
      leftNote,
      leftFileNote,
      handleLeftNoteLanguageChange,
      setLeftFileNote,
      handleLanguageChange,
    ],
  );

  const leftOnChange = isSplit
    ? leftNote
      ? handleLeftNoteContentChange
      : handleLeftFileNoteContentChange
    : currentNote
      ? handleNoteContentChange
      : handleFileNoteContentChange;

  const leftOnSave = useCallback(async () => {
    if (isSplit) {
      if (leftFileNote && isFileModified(leftFileNote.id)) {
        await handleSaveFile(leftFileNote);
      }
    } else {
      if (currentFileNote && isFileModified(currentFileNote.id)) {
        await handleSaveFile(currentFileNote);
      }
    }
  }, [isSplit, leftFileNote, currentFileNote, isFileModified, handleSaveFile]);

  const leftOnClose = useCallback(async () => {
    if (isSplit) {
      if (leftFileNote) {
        await handleCloseFileWithSplit(leftFileNote);
      } else if (leftNote) {
        await handleArchiveNoteWithSplit(leftNote.id);
      }
    } else {
      if (currentFileNote) {
        await handleCloseFileWithSplit(currentFileNote);
      } else if (currentNote) {
        await handleArchiveNoteWithSplit(currentNote.id);
      }
    }
  }, [
    isSplit,
    leftFileNote,
    leftNote,
    currentFileNote,
    currentNote,
    handleCloseFileWithSplit,
    handleArchiveNoteWithSplit,
  ]);

  const rightOnTitleChange = useCallback(
    (title: string) => {
      if (rightNote) handleRightNoteTitleChange(title);
    },
    [rightNote, handleRightNoteTitleChange],
  );

  const rightOnLanguageChange = useCallback(
    (language: string) => {
      if (rightNote) {
        handleRightNoteLanguageChange(language);
      } else if (rightFileNote) {
        setRightFileNote((prev) => (prev ? { ...prev, language } : prev));
      }
      // ハンドラから直接Monacoに言語を適用（useEffect不要）
      applyLanguageToEditor(rightEditorInstanceRef.current, language);
    },
    [rightNote, rightFileNote, handleRightNoteLanguageChange, setRightFileNote],
  );

  const rightOnChange = rightNote
    ? handleRightNoteContentChange
    : handleRightFileNoteContentChange;

  const rightOnSave = useCallback(async () => {
    if (rightFileNote && isFileModified(rightFileNote.id)) {
      await handleSaveFile(rightFileNote);
    }
  }, [rightFileNote, isFileModified, handleSaveFile]);

  const rightOnClose = useCallback(async () => {
    if (rightFileNote) {
      await handleCloseFileWithSplit(rightFileNote);
    } else if (rightNote) {
      await handleArchiveNoteWithSplit(rightNote.id);
    }
  }, [
    rightFileNote,
    rightNote,
    handleCloseFileWithSplit,
    handleArchiveNoteWithSplit,
  ]);

  // 6) JSX
  return (
    <ThemeProvider theme={editorSettings.isDarkMode ? darkTheme : lightTheme}>
      <CssBaseline />
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
              backgroundColor: editorSettings.isDarkMode
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
                noteSearch={searchReplace.query}
                searchReplace={{
                  mode: searchReplace.mode,
                  query: searchReplace.query,
                  replacement: searchReplace.replacement,
                  caseSensitive: searchReplace.caseSensitive,
                  wholeWord: searchReplace.wholeWord,
                  useRegex: searchReplace.useRegex,
                  patternError: searchReplace.patternError,
                  currentMatches: searchReplace.currentMatches,
                  currentMatchIndex: searchReplace.currentMatchIndex,
                  crossNoteResults: searchReplace.crossNoteResults,
                  activeNoteId: getActiveNoteId(),
                  focusToken: searchReplace.focusToken,
                  replaceResult: searchReplace.replaceResult,
                  sidebarMatchCount: totalSearchMatches,
                  onSetQuery: searchReplace.setQuery,
                  onSetReplacement: searchReplace.setReplacement,
                  onToggleCaseSensitive: () =>
                    searchReplace.setCaseSensitive(
                      !searchReplace.caseSensitive,
                    ),
                  onToggleWholeWord: () =>
                    searchReplace.setWholeWord(!searchReplace.wholeWord),
                  onToggleUseRegex: () =>
                    searchReplace.setUseRegex(!searchReplace.useRegex),
                  onSetMode: searchReplace.setMode,
                  onClear: searchReplace.clearQuery,
                  onFindNext: searchReplace.findNext,
                  onFindPrevious: searchReplace.findPrevious,
                  onReplaceCurrent: searchReplace.replaceCurrent,
                  onReplaceAllInCurrent: searchReplace.replaceAllInCurrent,
                  onReplaceAllInAllNotes: searchReplace.replaceAllInAllNotes,
                  onJumpToNoteMatch: searchReplace.jumpToNoteMatch,
                  onSelectNote: async (noteId: string) => {
                    const n = notes.find((note) => note.id === noteId);
                    if (!n) return;
                    if (isSplit) await handleSelectNoteForPane(n);
                    else await handleSelecAnyNote(n);
                  },
                }}
                fileNotes={fileNotes}
                filteredFileNotes={filteredFileNotes}
                currentFileNote={currentFileNote}
                notes={notes}
                filteredNotes={filteredNotes}
                currentNote={currentNote}
                isSplit={isSplit}
                leftNote={leftNote}
                leftFileNote={leftFileNote}
                secondarySelectedNoteId={secondarySelectedNoteId}
                canSplit={canSplit}
                onNoteSelect={handleSidebarSelectAnyNote}
                onArchive={handleArchiveNoteWithSplit}
                onCloseFile={handleCloseFileWithSplit}
                onSaveFile={handleSaveFile}
                onConvertToNote={handleConvertToNoteWithPlacement}
                onDropFileNoteToNotes={handleDropFileNoteToNotes}
                onOpenInPane={handleOpenNoteInPane}
                isFileModified={isFileModified}
                folders={folders}
                collapsedFolders={collapsedFolders}
                onToggleFolderCollapse={toggleFolderCollapse}
                onMoveNoteToFolder={handleMoveNoteToFolder}
                onRenameFolder={handleRenameFolder}
                onDeleteFolder={handleDeleteFolder}
                onArchiveFolder={handleArchiveFolder}
                onCreateFolder={handleCreateFolder}
                topLevelOrder={topLevelOrder}
                onUpdateTopLevelOrder={handleUpdateTopLevelOrder}
                recentFiles={recentFiles}
                openRecentFile={openRecentFile}
                removeRecentFile={removeRecentFile}
                clearRecentFiles={clearRecentFiles}
                showArchived={showArchived}
                onToggleShowArchived={handleToggleShowArchived}
                setNotes={setNotes}
                setFileNotes={setFileNotes}
              />
            </Allotment.Pane>

            <Allotment.Pane>
              <EditorArea
                showArchived={showArchived}
                notes={notes}
                folders={folders}
                archivedTopLevelOrder={archivedTopLevelOrder}
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
                onUpdateArchivedTopLevelOrder={
                  handleUpdateArchivedTopLevelOrder
                }
                onMoveNoteToFolder={handleMoveNoteToFolder}
                isSplit={isSplit}
                isMarkdownPreview={isMarkdownPreview}
                getAllotmentSizes={getAllotmentSizes}
                onAllotmentChange={handleEditorAllotmentChange}
                languages={languages}
                platform={platform}
                systemLocale={systemLocale}
                leftEditorInstanceRef={leftEditorInstanceRef}
                rightEditorInstanceRef={rightEditorInstanceRef}
                leftNote={leftNote}
                leftFileNote={leftFileNote}
                leftOnTitleChange={leftOnTitleChange}
                leftOnLanguageChange={leftOnLanguageChange}
                leftOnChange={leftOnChange}
                leftOnSave={leftOnSave}
                leftOnClose={leftOnClose}
                rightNote={rightNote}
                rightFileNote={rightFileNote}
                rightOnTitleChange={rightOnTitleChange}
                rightOnLanguageChange={rightOnLanguageChange}
                rightOnChange={rightOnChange}
                rightOnSave={rightOnSave}
                rightOnClose={rightOnClose}
                focusedPane={focusedPane}
                onFocusPane={handleFocusPane}
                noteSearch={searchReplace.query}
                searchMatchIndexInNote={searchMatchIndexInNote}
                onNew={handleNewNote}
                onOpen={handleOpenFile}
                leftOnSelectNext={leftOnSelectNext}
                leftOnSelectPrevious={leftOnSelectPrevious}
                rightOnSelectNext={rightOnSelectNext}
                rightOnSelectPrevious={rightOnSelectPrevious}
                canSelectAdjacentLeft={canSelectAdjacentLeft}
                canSelectAdjacentRight={canSelectAdjacentRight}
                canSplit={canSplit}
                onToggleSplit={handleToggleSplit}
                onToggleMarkdownPreview={toggleMarkdownPreview}
                onSettings={() => {
                  settingsOpenCountRef.current += 1;
                  setIsSettingsOpen(true);
                }}
                showMessage={showMessage}
                currentNote={currentNote}
                currentFileNote={currentFileNote}
                onOpenFind={() => searchReplace.focusFind('find')}
                onOpenReplace={() => searchReplace.focusFind('replace')}
                onOpenFindInAll={() => searchReplace.focusFind('find')}
              />
            </Allotment.Pane>
          </Allotment>
        </Box>
      </Box>

      <Suspense fallback={null}>
        <SettingsDialog
          key={settingsOpenCountRef.current}
          open={isSettingsOpen}
          settings={editorSettings}
          onClose={() => setIsSettingsOpen(false)}
          onChange={setEditorSettings}
          onOpenAbout={() => {
            setIsSettingsOpen(false);
            setIsAboutOpen(true);
          }}
          onOpenConflictBackups={() => {
            setIsSettingsOpen(false);
            setIsConflictBackupsOpen(true);
          }}
          showMessage={showMessage}
        />
      </Suspense>
      <Suspense fallback={null}>
        <LicenseDialog
          open={isAboutOpen}
          onClose={() => setIsAboutOpen(false)}
        />
      </Suspense>
      <Suspense fallback={null}>
        <ConflictBackupsDialog
          open={isConflictBackupsOpen}
          onClose={() => setIsConflictBackupsOpen(false)}
          onRestore={async (sourceNote) => {
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
            setTopLevelOrder((prev) => [
              { type: 'note', id: newNote.id },
              ...prev,
            ]);
            setCurrentFileNote(null);
            setCurrentNote(newNote);
            await SaveNote(backend.Note.createFrom(newNote), 'create');
            void SetLastActiveNote(newNote.id, false);
          }}
          showMessage={showMessage}
          isDarkMode={editorSettings.isDarkMode}
        />
      </Suspense>
      <MessageDialog
        isOpen={isMessageDialogOpen}
        title={messageTitle}
        message={messageContent}
        isTwoButton={isTwoButton}
        primaryButtonText={primaryButtonText}
        secondaryButtonText={secondaryButtonText}
        onResult={onResult}
      />
    </ThemeProvider>
  );
}

export default App;
