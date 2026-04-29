import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CreateNewFolder, History, Inventory } from '@mui/icons-material';
import {
  Box,
  Button,
  Divider,
  IconButton,
  ListItemText,
  MenuItem,
  MenuList,
  Popover,
  Tooltip,
  Typography,
} from '@mui/material';
import SimpleBar from 'simplebar-react';
import 'simplebar-react/dist/simplebar.min.css';

import { AppBar } from './AppBar';
import { type FileDropInsertionTarget, NoteList } from './NoteList';
import { SearchReplacePanel } from './SearchReplacePanel';

import type {
  NoteMatchGroup,
  ReplaceResult,
  SearchPanelMode,
} from '../hooks/useSearchReplace';
import type { FileNote, Folder, Note, TopLevelItem } from '../types';
import type { SearchMatch } from '../utils/searchUtils';

interface SidebarProps {
  platform: string;
  onNew: () => Promise<void>;
  onOpen: () => Promise<void>;
  onSaveAs: () => Promise<void>;
  // 既存のサイドバー絞り込みフラグ（統合検索クエリが空でないとき true）
  noteSearch: string;
  // Search / Replace panel (統合検索・置換、常時表示)
  searchReplace: {
    mode: SearchPanelMode;
    query: string;
    replacement: string;
    caseSensitive: boolean;
    wholeWord: boolean;
    useRegex: boolean;
    patternError: string | null;
    currentMatches: SearchMatch[];
    currentMatchIndex: number;
    crossNoteResults: NoteMatchGroup[];
    activeNoteId: string | null;
    focusToken: number;
    replaceResult: ReplaceResult | null;
    sidebarMatchCount: number;
    onSetQuery: (v: string) => void;
    onSetReplacement: (v: string) => void;
    onToggleCaseSensitive: () => void;
    onToggleWholeWord: () => void;
    onToggleUseRegex: () => void;
    onSetMode: (m: SearchPanelMode) => void;
    onClear: () => void;
    onFindNext: () => void;
    onFindPrevious: () => void;
    onReplaceCurrent: () => void;
    onReplaceAllInCurrent: () => void;
    onReplaceAllInAllNotes: () => void;
    onJumpToNoteMatch: (noteId: string, indexInNote: number) => void;
    onSelectNote: (noteId: string) => Promise<void> | void;
  };
  // File notes
  fileNotes: FileNote[];
  filteredFileNotes: FileNote[];
  currentFileNote: FileNote | null;
  // Notes
  notes: Note[];
  filteredNotes: Note[];
  currentNote: Note | null;
  // Split
  isSplit: boolean;
  leftNote: Note | null;
  leftFileNote: FileNote | null;
  secondarySelectedNoteId?: string;
  canSplit: boolean;
  // Handlers
  onNoteSelect: (note: Note | FileNote) => Promise<void>;
  onArchive: (noteId: string) => Promise<void>;
  onCloseFile: (fileNote: FileNote) => Promise<void>;
  onSaveFile: (fileNote: FileNote) => Promise<void>;
  onConvertToNote: (fileNote: FileNote) => Promise<void>;
  onDropFileNoteToNotes: (
    fileNoteId: string,
    target: FileDropInsertionTarget,
  ) => Promise<void>;
  onOpenInPane: (note: Note | FileNote, pane: 'left' | 'right') => void;
  isFileModified: (fileId: string) => boolean;
  // Folders
  folders: Folder[];
  collapsedFolders: Set<string>;
  onToggleFolderCollapse: (folderId: string) => void;
  onMoveNoteToFolder: (noteId: string, folderId: string) => Promise<void>;
  onRenameFolder: (id: string, name: string) => Promise<void>;
  onDeleteFolder: (id: string) => Promise<void>;
  onArchiveFolder: (id: string) => Promise<void>;
  onCreateFolder: (name: string) => Promise<Folder>;
  topLevelOrder: TopLevelItem[];
  onUpdateTopLevelOrder: (order: TopLevelItem[]) => Promise<void>;
  // Recent files
  recentFiles: string[];
  openRecentFile: (filePath: string) => Promise<void>;
  clearRecentFiles: () => Promise<void>;
  // Archive
  showArchived: boolean;
  onToggleShowArchived: () => void;
  // State setters for NoteList reorder
  setNotes: React.Dispatch<React.SetStateAction<Note[]>>;
  setFileNotes: (files: FileNote[]) => void;
}

export const Sidebar: React.FC<SidebarProps> = memo(
  ({
    platform,
    onNew,
    onOpen,
    onSaveAs,
    noteSearch,
    searchReplace,
    fileNotes,
    filteredFileNotes,
    currentFileNote,
    notes,
    filteredNotes,
    currentNote,
    isSplit,
    leftNote,
    leftFileNote,
    secondarySelectedNoteId,
    canSplit,
    onNoteSelect,
    onArchive,
    onCloseFile,
    onSaveFile,
    onConvertToNote,
    onDropFileNoteToNotes,
    onOpenInPane,
    isFileModified,
    folders,
    collapsedFolders,
    onToggleFolderCollapse,
    onMoveNoteToFolder,
    onRenameFolder,
    onDeleteFolder,
    onArchiveFolder,
    onCreateFolder,
    topLevelOrder,
    onUpdateTopLevelOrder,
    recentFiles,
    openRecentFile,
    clearRecentFiles,
    showArchived,
    onToggleShowArchived,
    setNotes,
    setFileNotes,
  }) => {
    const { t } = useTranslation();
    const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
    const [recentFilesAnchorEl, setRecentFilesAnchorEl] =
      useState<HTMLElement | null>(null);

    const archivedCount = notes.filter((note) => note.archived).length;
    const hasArchivedFolders = folders.some((f) => f.archived);

    const handleFileNotesReorder = useCallback(
      async (newNotes: Note[] | FileNote[]) => {
        setFileNotes(newNotes as FileNote[]);
      },
      [setFileNotes],
    );

    const handleNotesReorder = useCallback(
      async (newNotes: Note[] | FileNote[]) => {
        setNotes(newNotes as Note[]);
      },
      [setNotes],
    );

    const handleEditingFolderDone = useCallback(() => {
      setEditingFolderId(null);
    }, []);

    return (
      <Box
        aria-label={t('app.noteListAriaLabel')}
        sx={{
          width: '100%',
          height: '100%',
          borderRight: 1,
          borderColor: 'divider',
          display: 'flex',
          flexDirection: 'column',
          '& .simplebar-track.simplebar-vertical .simplebar-scrollbar:before': {
            backgroundColor: 'text.secondary',
          },
        }}
      >
        <AppBar
          platform={platform}
          onNew={onNew}
          onOpen={onOpen}
          onSave={onSaveAs}
        />
        <Divider />
        <SearchReplacePanel
          mode={searchReplace.mode}
          query={searchReplace.query}
          replacement={searchReplace.replacement}
          caseSensitive={searchReplace.caseSensitive}
          wholeWord={searchReplace.wholeWord}
          useRegex={searchReplace.useRegex}
          patternError={searchReplace.patternError}
          currentMatches={searchReplace.currentMatches}
          currentMatchIndex={searchReplace.currentMatchIndex}
          crossNoteResults={searchReplace.crossNoteResults}
          activeNoteId={searchReplace.activeNoteId}
          focusToken={searchReplace.focusToken}
          replaceResult={searchReplace.replaceResult}
          sidebarMatchCount={searchReplace.sidebarMatchCount}
          onSetQuery={searchReplace.onSetQuery}
          onSetReplacement={searchReplace.onSetReplacement}
          onToggleCaseSensitive={searchReplace.onToggleCaseSensitive}
          onToggleWholeWord={searchReplace.onToggleWholeWord}
          onToggleUseRegex={searchReplace.onToggleUseRegex}
          onSetMode={searchReplace.onSetMode}
          onClear={searchReplace.onClear}
          onFindNext={searchReplace.onFindNext}
          onFindPrevious={searchReplace.onFindPrevious}
          onReplaceCurrent={searchReplace.onReplaceCurrent}
          onReplaceAllInCurrent={searchReplace.onReplaceAllInCurrent}
          onReplaceAllInAllNotes={searchReplace.onReplaceAllInAllNotes}
          onJumpToNoteMatch={searchReplace.onJumpToNoteMatch}
          onSelectNote={searchReplace.onSelectNote}
        />
        <Box sx={{ flex: '1 1 0', minHeight: 0, overflow: 'hidden' }}>
          <SimpleBar style={{ height: '100%' }}>
            {/* Local Files ヘッダー */}
            <Box
              sx={{
                height: 32,
                justifyContent: 'center',
                alignItems: 'center',
                display: 'flex',
                backgroundColor: 'action.disabledBackground',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
                m: 1,
                mb: 0,
                position: 'relative',
              }}
            >
              <Typography variant="body2" color="text.secondary">
                {t('app.localFiles')}{' '}
                <Typography
                  component="span"
                  variant="caption"
                  sx={{
                    fontWeight: 'normal',
                    display: 'inline-block',
                    ml: 1,
                  }}
                >
                  {noteSearch ? filteredFileNotes.length : fileNotes.length}
                </Typography>
              </Typography>
              {recentFiles.length > 0 && (
                <Tooltip title={t('file.recentFiles')}>
                  <IconButton
                    onClick={(e) => setRecentFilesAnchorEl(e.currentTarget)}
                    sx={{ position: 'absolute', right: 4 }}
                  >
                    <History sx={{ fontSize: 18 }} />
                  </IconButton>
                </Tooltip>
              )}
              <Popover
                anchorEl={recentFilesAnchorEl}
                open={Boolean(recentFilesAnchorEl)}
                onClose={() => setRecentFilesAnchorEl(null)}
                slotProps={{
                  paper: {
                    sx: {
                      width: 420,
                      overflow: 'hidden',
                      '& .simplebar-track.simplebar-vertical .simplebar-scrollbar:before':
                        {
                          backgroundColor: 'text.secondary',
                        },
                    },
                  },
                }}
              >
                <SimpleBar style={{ maxHeight: 320 }}>
                  <MenuList disablePadding>
                    {recentFiles.map((filePath) => (
                      <MenuItem
                        key={filePath}
                        onClick={async () => {
                          setRecentFilesAnchorEl(null);
                          await openRecentFile(filePath);
                        }}
                        sx={{ py: 0.5 }}
                      >
                        <ListItemText
                          primary={filePath.split(/[/\\]/).pop()}
                          secondary={filePath}
                          slotProps={{
                            primary: { variant: 'body2', noWrap: true },
                            secondary: {
                              variant: 'caption',
                              noWrap: true,
                              sx: { opacity: 0.7 },
                            },
                          }}
                        />
                      </MenuItem>
                    ))}
                  </MenuList>
                </SimpleBar>
                <Divider />
                <MenuList disablePadding>
                  <MenuItem
                    onClick={async () => {
                      setRecentFilesAnchorEl(null);
                      await clearRecentFiles();
                    }}
                    sx={{ py: 0.5 }}
                  >
                    <ListItemText
                      primary={t('file.clearRecentFiles')}
                      slotProps={{
                        primary: {
                          variant: 'body2',
                          color: 'text.secondary',
                          sx: { textAlign: 'center' },
                        },
                      }}
                    />
                  </MenuItem>
                </MenuList>
              </Popover>
            </Box>

            {/* File Notes リスト */}
            {(noteSearch
              ? filteredFileNotes.length > 0
              : fileNotes.length > 0) && (
              <>
                <NoteList
                  notes={noteSearch ? filteredFileNotes : fileNotes}
                  currentNote={isSplit ? leftFileNote : currentFileNote}
                  onNoteSelect={onNoteSelect}
                  allowReselect={showArchived}
                  onConvertToNote={onConvertToNote}
                  onSaveFile={onSaveFile}
                  onReorder={handleFileNotesReorder}
                  isFileMode={true}
                  onCloseFile={onCloseFile}
                  isFileModified={isFileModified}
                  platform={platform}
                  secondarySelectedNoteId={secondarySelectedNoteId}
                  onOpenInPane={onOpenInPane}
                  canSplit={canSplit}
                />
                <Divider />
              </>
            )}

            {/* Notes ヘッダー */}
            <Box
              sx={{
                height: 32,
                justifyContent: 'center',
                alignItems: 'center',
                display: 'flex',
                backgroundColor: 'action.disabledBackground',
                position: 'relative',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
                m: 1,
                mb: 0,
              }}
            >
              <Typography variant="body2" color="text.secondary">
                {t('app.notes')}{' '}
                <Typography
                  component="span"
                  variant="caption"
                  sx={{
                    fontWeight: 'normal',
                    display: 'inline-block',
                    ml: 1,
                  }}
                >
                  {noteSearch
                    ? filteredNotes.length
                    : notes.filter((note) => !note.archived).length}
                </Typography>
              </Typography>
              <Tooltip title={t('app.newFolder')} arrow placement="bottom">
                <IconButton
                  sx={{ position: 'absolute', right: 4 }}
                  onClick={async () => {
                    const folder = await onCreateFolder(t('app.newFolder'));
                    setEditingFolderId(folder.id);
                  }}
                >
                  <CreateNewFolder sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
            </Box>

            {/* Notes リスト */}
            <NoteList
              notes={noteSearch ? filteredNotes : notes}
              currentNote={isSplit ? leftNote : currentNote}
              onNoteSelect={onNoteSelect}
              allowReselect={showArchived}
              onArchive={onArchive}
              onReorder={handleNotesReorder}
              platform={platform}
              folders={folders}
              collapsedFolders={collapsedFolders}
              onToggleFolderCollapse={onToggleFolderCollapse}
              onMoveNoteToFolder={onMoveNoteToFolder}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
              onArchiveFolder={onArchiveFolder}
              editingFolderId={editingFolderId}
              onEditingFolderDone={handleEditingFolderDone}
              topLevelOrder={topLevelOrder}
              onUpdateTopLevelOrder={onUpdateTopLevelOrder}
              secondarySelectedNoteId={secondarySelectedNoteId}
              onOpenInPane={onOpenInPane}
              canSplit={canSplit}
              onDropFileNoteToNotes={onDropFileNoteToNotes}
            />
          </SimpleBar>
        </Box>

        {/* Archive ボタン */}
        <Button
          fullWidth
          disabled={archivedCount === 0 && !hasArchivedFolders}
          sx={{
            mt: 'auto',
            borderRadius: 0,
            borderTop: 1,
            borderColor: 'divider',
            zIndex: 1000,
            backgroundColor: 'background.paper',
            '&:hover': { backgroundColor: 'action.hover' },
          }}
          onClick={onToggleShowArchived}
          startIcon={<Inventory />}
        >
          {t('app.archives')} {archivedCount ? `(${archivedCount})` : ''}
        </Button>
      </Box>
    );
  },
);
