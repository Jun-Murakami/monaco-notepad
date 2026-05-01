import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Close,
  CreateNewFolder,
  History,
  Inventory,
} from '@mui/icons-material';
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

import { useNoteSearch } from '../hooks/useNoteSearch';
import {
  useCurrentFileNoteId,
  useCurrentNoteId,
} from '../stores/useCurrentNoteStore';
import {
  useAllFileNotes,
  useFileNotesStore,
} from '../stores/useFileNotesStore';
import {
  useActiveNotesCount,
  useAllNotes,
  useCollapsedFolders,
  useFolders,
  useNotesStore,
  useShowArchived,
  useTopLevelOrder,
} from '../stores/useNotesStore';
import { useSearchReplaceStore } from '../stores/useSearchReplaceStore';
import {
  useIsSplit,
  useLeftFileNote,
  useLeftNote,
  useSecondarySelectedNoteId,
} from '../stores/useSplitEditorStore';
import { AppBar } from './AppBar';
import { type FileDropInsertionTarget, NoteList } from './NoteList';
import { SearchReplacePanel } from './SearchReplacePanel';

import type { FileNote, Folder, Note, TopLevelItem } from '../types';

interface SidebarProps {
  platform: string;
  systemLocale: string;
  onNew: () => Promise<void>;
  onOpen: () => Promise<void>;
  onSaveAs: () => Promise<void>;
  // File notes / Split editor の state は store 直購読する
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
  // Folders 関連 handlers (state は store 直購読)
  onToggleFolderCollapse: (folderId: string) => void;
  onMoveNoteToFolder: (noteId: string, folderId: string) => Promise<void>;
  onRenameFolder: (id: string, name: string) => Promise<void>;
  onDeleteFolder: (id: string) => Promise<void>;
  onArchiveFolder: (id: string) => Promise<void>;
  onCreateFolder: (name: string) => Promise<Folder>;
  onUpdateTopLevelOrder: (order: TopLevelItem[]) => Promise<void>;
  // Recent files
  recentFiles: string[];
  openRecentFile: (filePath: string) => Promise<void>;
  removeRecentFile: (filePath: string) => Promise<void>;
  clearRecentFiles: () => Promise<void>;
  // Archive
  onToggleShowArchived: () => void;
}

export const Sidebar: React.FC<SidebarProps> = memo(
  ({
    platform,
    systemLocale,
    onNew,
    onOpen,
    onSaveAs,
    onNoteSelect,
    onArchive,
    onCloseFile,
    onSaveFile,
    onConvertToNote,
    onDropFileNoteToNotes,
    onOpenInPane,
    isFileModified,
    onToggleFolderCollapse,
    onMoveNoteToFolder,
    onRenameFolder,
    onDeleteFolder,
    onArchiveFolder,
    onCreateFolder,
    onUpdateTopLevelOrder,
    recentFiles,
    openRecentFile,
    removeRecentFile,
    clearRecentFiles,
    onToggleShowArchived,
  }) => {
    const { t } = useTranslation();
    const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
    const [recentFilesAnchorEl, setRecentFilesAnchorEl] =
      useState<HTMLElement | null>(null);
    // currentNote / currentFileNote は ID のみ購読する。
    const currentNoteId = useCurrentNoteId();
    const currentFileNoteId = useCurrentFileNoteId();
    // 検索クエリ・notes 系は store 直購読
    const noteSearch = useSearchReplaceStore((s) => s.query);
    const notes = useAllNotes();
    const folders = useFolders();
    const collapsedFolders = useCollapsedFolders();
    const topLevelOrder = useTopLevelOrder();
    const showArchived = useShowArchived();
    // setNotes は Zustand action（参照不変）。NoteList の reorder で利用する。
    const setNotes = useNotesStore((s) => s.setNotes);
    // FileNote 一覧 / 並び替え action もストア直購読
    const fileNotes = useAllFileNotes();
    const setFileNotes = useFileNotesStore((s) => s.setFileNotes);
    // Split editor 状態も store 直購読
    const isSplit = useIsSplit();
    const leftNote = useLeftNote();
    const leftFileNote = useLeftFileNote();
    const secondarySelectedNoteId = useSecondarySelectedNoteId();

    // フィルタリング・件数集計は Sidebar の中で完結させる
    // （App.tsx を notes 変化で再レンダーさせないための要）
    const { filteredNotes, filteredFileNotes, totalSearchMatches } =
      useNoteSearch();

    // canSplit は note + fileNote が 2 件以上あれば true。
    // 数値の閾値判定なので Sidebar の再レンダーは閾値跨ぎでしか起きない。
    const activeNotesCount = useActiveNotesCount();
    const canSplit = isSplit || fileNotes.length + activeNotesCount >= 2;

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
        {/* SearchReplacePanel はストア駆動。サイドバー件数だけ Sidebar 側で計算して渡す */}
        <SearchReplacePanel sidebarMatchCount={totalSearchMatches} />
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
              <Typography
                variant="body2"
                color={noteSearch ? 'primary' : 'text.secondary'}
              >
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
                  {noteSearch
                    ? `(${filteredFileNotes.length}/${fileNotes.length})`
                    : fileNotes.length}
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
                        sx={{
                          py: 0.5,
                          pr: 5,
                          '&:hover .recent-file-remove': { opacity: 1 },
                        }}
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
                        <Tooltip
                          title={t('file.removeFromRecent')}
                          arrow
                          placement="left"
                        >
                          <IconButton
                            className="recent-file-remove"
                            size="small"
                            onClick={(e) => {
                              e.stopPropagation();
                              void removeRecentFile(filePath);
                            }}
                            sx={{
                              position: 'absolute',
                              right: 8,
                              top: '50%',
                              transform: 'translateY(-50%)',
                              opacity: 0,
                              transition: 'opacity 0.15s',
                              p: 0.5,
                            }}
                          >
                            <Close sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Tooltip>
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
                  currentNoteId={
                    isSplit ? (leftFileNote?.id ?? null) : currentFileNoteId
                  }
                  onNoteSelect={onNoteSelect}
                  allowReselect={showArchived}
                  onConvertToNote={onConvertToNote}
                  onSaveFile={onSaveFile}
                  onReorder={handleFileNotesReorder}
                  isFileMode={true}
                  onCloseFile={onCloseFile}
                  isFileModified={isFileModified}
                  platform={platform}
                  systemLocale={systemLocale}
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
              <Typography
                variant="body2"
                color={noteSearch ? 'primary' : 'text.secondary'}
              >
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
                    ? `(${filteredNotes.length}/${notes.filter((note) => !note.archived).length})`
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
              currentNoteId={isSplit ? (leftNote?.id ?? null) : currentNoteId}
              onNoteSelect={onNoteSelect}
              allowReselect={showArchived}
              onArchive={onArchive}
              onReorder={handleNotesReorder}
              platform={platform}
              systemLocale={systemLocale}
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
