import React, { Suspense } from 'react';
import { Box } from '@mui/material';
import { Allotment } from 'allotment';

import { useEditorSettingsStore } from '../stores/useEditorSettingsStore';
import { EditorPane } from './EditorPane';
import { EditorStatusBar } from './EditorStatusBar';

import type { editor } from 'monaco-editor';
import type { LanguageInfo } from '../lib/monaco';
import type { FileNote, Folder, Note, TopLevelItem } from '../types';

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
  // Archived view
  showArchived: boolean;
  notes: Note[];
  folders: Folder[];
  archivedTopLevelOrder: TopLevelItem[];
  onUnarchive: (noteId: string) => Promise<void>;
  onDelete: (noteId: string) => Promise<void>;
  onDeleteAll: () => void;
  onCloseArchived: () => void;
  onUnarchiveFolder: (folderId: string) => Promise<void>;
  onDeleteFolder: (folderId: string) => Promise<void>;
  onUpdateArchivedTopLevelOrder: (order: TopLevelItem[]) => Promise<void>;
  onMoveNoteToFolder: (noteId: string, folderId: string) => Promise<void>;
  // Split / Markdown
  isSplit: boolean;
  isMarkdownPreview: boolean;
  getAllotmentSizes: (
    isSplit: boolean,
    isMarkdownPreview: boolean,
    previewOnLeft: boolean,
  ) => number[];
  onAllotmentChange: (sizes: number[]) => void;
  // Editor pane data
  languages: LanguageInfo[];
  platform: string;
  leftEditorInstanceRef: React.RefObject<editor.IStandaloneCodeEditor | null>;
  rightEditorInstanceRef: React.RefObject<editor.IStandaloneCodeEditor | null>;
  // Left pane
  leftNote: Note | null;
  leftFileNote: FileNote | null;
  leftOnTitleChange: (title: string) => void;
  leftOnLanguageChange: (language: string) => void;
  leftOnChange: (value: string) => void;
  leftOnSave: () => void;
  leftOnClose: () => void;
  // Right pane
  rightNote: Note | null;
  rightFileNote: FileNote | null;
  rightOnTitleChange: (title: string) => void;
  rightOnLanguageChange: (language: string) => void;
  rightOnChange: (value: string) => void;
  rightOnSave: () => void;
  rightOnClose: () => void;
  // Shared editor handlers
  focusedPane: 'left' | 'right';
  onFocusPane: (pane: 'left' | 'right') => void;
  noteSearch: string;
  searchMatchIndexInNote: number;
  onNew: () => void;
  onOpen: () => void;
  onSelectNext: () => Promise<void>;
  onSelectPrevious: () => Promise<void>;
  // Status bar
  canSplit: boolean;
  onToggleSplit: () => void;
  onToggleMarkdownPreview: () => void;
  onSettings: () => void;
  showMessage: (
    title: string,
    message: string,
    isTwoButton?: boolean,
  ) => Promise<boolean>;
  // Current note (for non-split mode)
  currentNote: Note | null;
  currentFileNote: FileNote | null;
}

export const EditorArea: React.FC<EditorAreaProps> = ({
  showArchived,
  notes,
  folders,
  archivedTopLevelOrder,
  onUnarchive,
  onDelete,
  onDeleteAll,
  onCloseArchived,
  onUnarchiveFolder,
  onDeleteFolder,
  onUpdateArchivedTopLevelOrder,
  onMoveNoteToFolder,
  isSplit,
  isMarkdownPreview,
  getAllotmentSizes,
  onAllotmentChange,
  languages,
  platform,
  leftEditorInstanceRef,
  rightEditorInstanceRef,
  leftNote,
  leftFileNote,
  leftOnTitleChange,
  leftOnLanguageChange,
  leftOnChange,
  leftOnSave,
  leftOnClose,
  rightNote,
  rightFileNote,
  rightOnTitleChange,
  rightOnLanguageChange,
  rightOnChange,
  rightOnSave,
  rightOnClose,
  focusedPane,
  onFocusPane,
  noteSearch,
  searchMatchIndexInNote,
  onNew,
  onOpen,
  onSelectNext,
  onSelectPrevious,
  canSplit,
  onToggleSplit,
  onToggleMarkdownPreview,
  onSettings,
  showMessage,
  currentNote,
  currentFileNote,
}) => {
  const settings = useEditorSettingsStore((s) => s.settings);
  const editorInstanceRef = leftEditorInstanceRef;

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
        <Suspense fallback={null}>
          <ArchivedNoteList
            notes={notes}
            folders={folders}
            archivedTopLevelOrder={archivedTopLevelOrder}
            onUnarchive={onUnarchive}
            onDelete={onDelete}
            onDeleteAll={onDeleteAll}
            onClose={onCloseArchived}
            onUnarchiveFolder={onUnarchiveFolder}
            onDeleteFolder={onDeleteFolder}
            onUpdateArchivedTopLevelOrder={onUpdateArchivedTopLevelOrder}
            onMoveNoteToFolder={onMoveNoteToFolder}
            isDarkMode={settings.isDarkMode}
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
              searchMatchIndexInNote={
                !isSplit || focusedPane === 'left' ? searchMatchIndexInNote : 0
              }
              onFocus={() => onFocusPane('left')}
              onNew={onNew}
              onOpen={onOpen}
              onSave={leftOnSave}
              onClose={leftOnClose}
              onSelectNext={onSelectNext}
              onSelectPrevious={onSelectPrevious}
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
                searchMatchIndexInNote={
                  focusedPane === 'right' ? searchMatchIndexInNote : 0
                }
                onFocus={() => onFocusPane('right')}
                onNew={onNew}
                onOpen={onOpen}
                onSave={rightOnSave}
                onClose={rightOnClose}
                onSelectNext={onSelectNext}
                onSelectPrevious={onSelectPrevious}
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
