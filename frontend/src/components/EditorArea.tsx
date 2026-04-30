import React, { Suspense, useMemo } from 'react';
import { Box, CircularProgress } from '@mui/material';
import { Allotment } from 'allotment';

import {
  useCurrentFileNote,
  useCurrentNote,
} from '../stores/useCurrentNoteStore';
import { useEditorSettingsStore } from '../stores/useEditorSettingsStore';
import { useAllFileNotes } from '../stores/useFileNotesStore';
import {
  useActiveNotesCount,
  useAllNotes,
  useShowArchived,
  useTopLevelOrder,
} from '../stores/useNotesStore';
import { useSearchReplaceStore } from '../stores/useSearchReplaceStore';
import {
  useFocusedPane,
  useIsMarkdownPreview,
  useIsSplit,
  useLeftFileNote,
  useLeftNote,
  useRightFileNote,
  useRightNote,
} from '../stores/useSplitEditorStore';
import { EditorPane } from './EditorPane';
import { EditorStatusBar } from './EditorStatusBar';

import type { editor } from 'monaco-editor';
import type { LanguageInfo } from '../lib/monaco';
import type { FileNote, Note, TopLevelItem } from '../types';

// Lazy-loaded components
const ArchivedNoteList = React.lazy(() =>
  import('./ArchivedNoteList').then((m) => ({
    default: m.ArchivedNoteList,
  })),
);
const MarkdownPreview = React.lazy(() =>
  import('./MarkdownPreview').then((m) => ({
    default: m.MarkdownPreview,
  })),
);

interface EditorAreaProps {
  // Archived view（state は useNotesStore から直接購読する）
  onUnarchive: (noteId: string) => Promise<void>;
  onDelete: (noteId: string) => Promise<void>;
  onDeleteAll: () => void;
  onCloseArchived: () => void;
  onUnarchiveFolder: (folderId: string) => Promise<void>;
  onDeleteFolder: (folderId: string) => Promise<void>;
  onUpdateArchivedTopLevelOrder: (order: TopLevelItem[]) => Promise<void>;
  onMoveNoteToFolder: (noteId: string, folderId: string) => Promise<void>;
  // FileNote 一覧 / Split / Markdown / pane state は store 直購読
  getAllotmentSizes: (
    isSplit: boolean,
    isMarkdownPreview: boolean,
    previewOnLeft: boolean,
  ) => number[];
  onAllotmentChange: (sizes: number[]) => void;
  // Editor pane data
  languages: LanguageInfo[];
  platform: string;
  systemLocale: string;
  leftEditorInstanceRef: React.RefObject<editor.IStandaloneCodeEditor | null>;
  rightEditorInstanceRef: React.RefObject<editor.IStandaloneCodeEditor | null>;
  // Left pane handlers (state は store 直購読)
  leftOnTitleChange: (title: string) => void;
  leftOnLanguageChange: (language: string) => void;
  leftOnChange: (value: string) => void;
  leftOnSave: () => void;
  leftOnClose: () => void;
  // Right pane handlers
  rightOnTitleChange: (title: string) => void;
  rightOnLanguageChange: (language: string) => void;
  rightOnChange: (value: string) => void;
  rightOnSave: () => void;
  rightOnClose: () => void;
  onFocusPane: (pane: 'left' | 'right') => void;
  onNew: () => void;
  onOpen: () => void;
  leftOnSelectNext: () => Promise<void>;
  leftOnSelectPrevious: () => Promise<void>;
  rightOnSelectNext: () => Promise<void>;
  rightOnSelectPrevious: () => Promise<void>;
  // canSplit / canSelectAdjacent* は EditorArea 内で派生計算する
  // Status bar
  onToggleSplit: () => void;
  onToggleMarkdownPreview: () => void;
  onSettings: () => void;
  showMessage: (
    title: string,
    message: string,
    isTwoButton?: boolean,
  ) => Promise<boolean>;
  // Current note (非スプリット時の表示対象) は useCurrentNoteStore から直接購読する。
  // App.tsx の再レンダーに引きずられないようにするため、props として受け取らない。
  // 検索・置換パネル（パネル本体はサイドバー内。ここでは開閉要求コールバックのみ受け取る）
  onOpenFind: () => void;
  onOpenReplace: () => void;
  onOpenFindInAll: () => void;
}

export const EditorArea: React.FC<EditorAreaProps> = ({
  onUnarchive,
  onDelete,
  onDeleteAll,
  onCloseArchived,
  onUnarchiveFolder,
  onDeleteFolder,
  onUpdateArchivedTopLevelOrder,
  onMoveNoteToFolder,
  getAllotmentSizes,
  onAllotmentChange,
  languages,
  platform,
  systemLocale,
  leftEditorInstanceRef,
  rightEditorInstanceRef,
  leftOnTitleChange,
  leftOnLanguageChange,
  leftOnChange,
  leftOnSave,
  leftOnClose,
  rightOnTitleChange,
  rightOnLanguageChange,
  rightOnChange,
  rightOnSave,
  rightOnClose,
  onFocusPane,
  onNew,
  onOpen,
  leftOnSelectNext,
  leftOnSelectPrevious,
  rightOnSelectNext,
  rightOnSelectPrevious,
  onToggleSplit,
  onToggleMarkdownPreview,
  onSettings,
  showMessage,
  onOpenFind,
  onOpenReplace,
  onOpenFindInAll,
}) => {
  const settings = useEditorSettingsStore((s) => s.settings);
  // 非スプリット時に左ペインへ表示する currentNote / currentFileNote を購読する。
  const currentNote = useCurrentNote();
  const currentFileNote = useCurrentFileNote();
  // showArchived も store 直購読（archived ビューの表示切替）
  const showArchived = useShowArchived();
  // Editor が検索ハイライトに使うクエリは、ストアから直接購読する。
  // App.tsx を介さないので、note 切替や入力時に App ツリーを揺らさない。
  const noteSearch = useSearchReplaceStore((s) => s.query);
  // canSplit / canSelectAdjacent* の派生計算用
  const activeNotesCount = useActiveNotesCount();
  const allNotes = useAllNotes();
  const topLevelOrder = useTopLevelOrder();
  // FileNote 一覧は store から直接購読
  const fileNotes = useAllFileNotes();
  // 分割エディタの state は store から直接購読する（App.tsx は subscribe しない）
  const isSplit = useIsSplit();
  const isMarkdownPreview = useIsMarkdownPreview();
  const focusedPane = useFocusedPane();
  const leftNote = useLeftNote();
  const leftFileNote = useLeftFileNote();
  const rightNote = useRightNote();
  const rightFileNote = useRightFileNote();
  const editorInstanceRef = leftEditorInstanceRef;

  // 数値の閾値判定なので、件数が増減しても閾値跨ぎでない限り再描画されない。
  const canSplit = isSplit || fileNotes.length + activeNotesCount >= 2;

  // ノートリスト表示順序に従った巡回対象ノート列。
  // 「次／前のノート」ボタンの活性判定で使用するためここで派生する。
  const orderedAvailableNotes = useMemo<(Note | FileNote)[]>(() => {
    const activeNotes = allNotes.filter((n) => !n.archived);
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
  }, [allNotes, fileNotes, topLevelOrder]);

  // 隣接ノート選択が可能かを左右ペイン別に判定。PaneHeader のボタン活性に使う。
  const canSelectAdjacentForPane = (pane: 'left' | 'right'): boolean => {
    if (orderedAvailableNotes.length === 0) return false;
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
    return orderedAvailableNotes.some(
      (n) => n.id !== paneId && (!otherId || n.id !== otherId),
    );
  };
  const canSelectAdjacentLeft = canSelectAdjacentForPane('left');
  const canSelectAdjacentRight = canSelectAdjacentForPane('right');

  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}
    >
      {showArchived ? (
        <Suspense
          fallback={
            <Box
              sx={{
                flexGrow: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 0,
              }}
            >
              <CircularProgress />
            </Box>
          }
        >
          <ArchivedNoteList
            onUnarchive={onUnarchive}
            onDelete={onDelete}
            onDeleteAll={onDeleteAll}
            onClose={onCloseArchived}
            onUnarchiveFolder={onUnarchiveFolder}
            onDeleteFolder={onDeleteFolder}
            onUpdateArchivedTopLevelOrder={onUpdateArchivedTopLevelOrder}
            onMoveNoteToFolder={onMoveNoteToFolder}
            isDarkMode={settings.isDarkMode}
            systemLocale={systemLocale}
          />
        </Suspense>
      ) : (
        <Allotment
          defaultSizes={getAllotmentSizes(
            isSplit,
            isMarkdownPreview,
            settings.markdownPreviewOnLeft,
          )}
          onChange={onAllotmentChange}
        >
          {isMarkdownPreview && settings.markdownPreviewOnLeft && (
            <Allotment.Pane minSize={200}>
              <Suspense fallback={null}>
                <MarkdownPreview editorInstanceRef={leftEditorInstanceRef} />
              </Suspense>
            </Allotment.Pane>
          )}

          <Allotment.Pane minSize={200}>
            <EditorPane
              paneId="left"
              note={isSplit ? leftNote : currentNote}
              fileNote={isSplit ? leftFileNote : currentFileNote}
              languages={languages}
              editorInstanceRef={leftEditorInstanceRef}
              platform={platform}
              isSplit={isSplit}
              paneColor="primary"
              paneLabel={isSplit ? '1' : undefined}
              dimmed={isSplit && focusedPane !== 'left'}
              onActivatePane={isSplit ? () => onFocusPane('left') : undefined}
              onTitleChange={leftOnTitleChange}
              onLanguageChange={leftOnLanguageChange}
              onChange={leftOnChange}
              searchKeyword={
                !isSplit || focusedPane === 'left' ? noteSearch : undefined
              }
              onFocus={() => onFocusPane('left')}
              onNew={onNew}
              onOpen={onOpen}
              onSave={leftOnSave}
              onClose={leftOnClose}
              onSelectNext={leftOnSelectNext}
              onSelectPrevious={leftOnSelectPrevious}
              canSelectAdjacent={canSelectAdjacentLeft}
              onOpenFind={onOpenFind}
              onOpenReplace={onOpenReplace}
              onOpenFindInAll={onOpenFindInAll}
            />
          </Allotment.Pane>

          {isSplit && (
            <Allotment.Pane minSize={200}>
              <EditorPane
                paneId="right"
                note={rightNote}
                fileNote={rightFileNote}
                languages={languages}
                editorInstanceRef={rightEditorInstanceRef}
                platform={platform}
                isSplit={isSplit}
                paneColor="secondary"
                paneLabel="2"
                dimmed={focusedPane !== 'right'}
                onActivatePane={() => onFocusPane('right')}
                onTitleChange={rightOnTitleChange}
                onLanguageChange={rightOnLanguageChange}
                onChange={rightOnChange}
                searchKeyword={focusedPane === 'right' ? noteSearch : undefined}
                onFocus={() => onFocusPane('right')}
                onNew={onNew}
                onOpen={onOpen}
                onSave={rightOnSave}
                onClose={rightOnClose}
                onSelectNext={rightOnSelectNext}
                onSelectPrevious={rightOnSelectPrevious}
                canSelectAdjacent={canSelectAdjacentRight}
                onOpenFind={onOpenFind}
                onOpenReplace={onOpenReplace}
                onOpenFindInAll={onOpenFindInAll}
              />
            </Allotment.Pane>
          )}

          {isMarkdownPreview && !settings.markdownPreviewOnLeft && (
            <Allotment.Pane minSize={200}>
              <Suspense fallback={null}>
                <MarkdownPreview editorInstanceRef={leftEditorInstanceRef} />
              </Suspense>
            </Allotment.Pane>
          )}
        </Allotment>
      )}

      <EditorStatusBar
        editorInstanceRef={
          isSplit
            ? focusedPane === 'left'
              ? leftEditorInstanceRef
              : rightEditorInstanceRef
            : editorInstanceRef
        }
        isSplit={isSplit}
        isMarkdownPreview={isMarkdownPreview}
        canSplit={canSplit}
        onToggleSplit={onToggleSplit}
        onToggleMarkdownPreview={onToggleMarkdownPreview}
        onSettings={onSettings}
        showMessage={showMessage}
      />
    </Box>
  );
};
