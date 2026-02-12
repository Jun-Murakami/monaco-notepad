import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Archive,
  ChevronRight,
  Close,
  Delete,
  DriveFileRenameOutline,
  ExpandMore,
  Folder as FolderIcon,
  FolderOpen,
  Save,
  SimCardDownload,
} from '@mui/icons-material';
import {
  alpha,
  Box,
  IconButton,
  InputBase,
  List,
  ListItemButton,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SaveFileNotes, UpdateNoteOrder } from '../../wailsjs/go/backend/App';
import type { FileNote, Folder, Note, TopLevelItem } from '../types';
import dayjs from '../utils/dayjs';
import { NotePreviewPopper } from './NotePreviewPopper';

const getNoteTitle = (
  note: Note | FileNote,
): { text: string; isFallback: boolean } => {
  if ('filePath' in note) {
    return { text: note.fileName, isFallback: false };
  }

  if (note.title.trim()) return { text: note.title, isFallback: false };

  if (note.syncing) return { text: 'Loading...', isFallback: true };

  if (note.archived && note.contentHeader) {
    return {
      text: note.contentHeader.replace(/\r\n|\n|\r/g, ' ').slice(0, 30),
      isFallback: true,
    };
  }

  const content = note.content?.trim() || '';
  if (!content) return { text: 'New Note', isFallback: true };

  const lines = content.split('\n');
  const firstNonEmptyLine = lines.find((line) => line.trim().length > 0);
  if (!firstNonEmptyLine) return { text: 'New Note', isFallback: true };

  return {
    text: content.replace(/\r\n|\n|\r/g, ' ').slice(0, 30),
    isFallback: true,
  };
};

interface NoteListProps {
  notes: Note[] | FileNote[];
  currentNote: Note | FileNote | null;
  onNoteSelect: (note: Note | FileNote) => Promise<void>;
  onArchive?: (noteId: string) => Promise<void>;
  onConvertToNote?: (fileNote: FileNote) => Promise<void>;
  onSaveFile?: (fileNote: FileNote) => Promise<void>;
  onReorder?: (notes: Note[] | FileNote[]) => void;
  isFileMode?: boolean;
  onCloseFile?: (note: FileNote) => Promise<void>;
  isFileModified?: (fileId: string) => boolean;
  platform: string;
  folders?: Folder[];
  collapsedFolders?: Set<string>;
  onToggleFolderCollapse?: (folderId: string) => void;
  onRenameFolder?: (id: string, name: string) => void;
  onDeleteFolder?: (id: string) => void;
  onMoveNoteToFolder?: (noteID: string, folderID: string) => void;
  editingFolderId?: string | null;
  onEditingFolderDone?: () => void;
  topLevelOrder?: TopLevelItem[];
  onUpdateTopLevelOrder?: (order: TopLevelItem[]) => void;
  onArchiveFolder?: (folderId: string) => Promise<void>;
  secondarySelectedNoteId?: string;
  onOpenInPane?: (note: Note | FileNote, pane: 'left' | 'right') => void;
  canSplit?: boolean;
}

interface NoteItemProps {
  note: Note | FileNote;
  currentNote: Note | FileNote | null;
  onNoteSelect: (note: Note | FileNote) => Promise<void>;
  onArchive?: (noteId: string) => Promise<void>;
  onConvertToNote?: (fileNote: FileNote) => Promise<void>;
  onSaveFile?: (fileNote: FileNote) => Promise<void>;
  getNoteTitle: (note: Note | FileNote) => {
    text: string;
    isFallback: boolean;
  };
  isFileMode?: boolean;
  onCloseFile?: (note: FileNote) => Promise<void>;
  isFileModified?: (fileId: string) => boolean;
  platform: string;
  secondarySelectedNoteId?: string;
  onOpenInPane?: (note: Note | FileNote, pane: 'left' | 'right') => void;
  canSplit?: boolean;
  isDragging?: boolean;
}

const NoteItem: React.FC<NoteItemProps> = memo(
  ({
    note,
    currentNote,
    onNoteSelect,
    onArchive,
    onConvertToNote,
    onSaveFile,
    getNoteTitle,
    isFileMode,
    onCloseFile,
    isFileModified,
    platform,
    secondarySelectedNoteId,
    onOpenInPane,
    canSplit,
    isDragging,
  }) => {
    const theme = useTheme();
    const cmdKey = platform === 'darwin' ? 'Cmd' : 'Ctrl';
    const noteTitle = getNoteTitle(note);
    const [contextMenu, setContextMenu] = useState<{
      mouseX: number;
      mouseY: number;
    } | null>(null);

    const isFileNote = (note: Note | FileNote): note is FileNote => {
      return 'filePath' in note;
    };

    const isSyncing = !isFileNote(note) && !!(note as Note).syncing;

    const handleContextMenu = (event: React.MouseEvent) => {
      if (isSyncing) return;
      event.preventDefault();
      event.stopPropagation();
      setContextMenu(
        contextMenu === null
          ? { mouseX: event.clientX + 2, mouseY: event.clientY - 6 }
          : null,
      );
    };

    const handleCloseContextMenu = () => {
      setContextMenu(null);
    };

    return (
      <NotePreviewPopper
        content={'content' in note ? (note.content ?? undefined) : undefined}
        anchorX={242}
        disabled={contextMenu !== null || isSyncing || !!isDragging}
      >
        <Box
          sx={{
            position: 'relative',
            '&:hover .action-button': { opacity: isSyncing ? 0 : 1 },
          }}
        >
          <ListItemButton
            selected={!isSyncing && currentNote?.id === note.id}
            disabled={isSyncing}
            onClick={async () => {
              if (!isSyncing && currentNote?.id !== note.id) {
                await onNoteSelect(note);
              }
            }}
            onContextMenu={handleContextMenu}
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              pt: 0.5,
              pb: 0.25,
              px: 1.5,
              ...(currentNote?.id !== note.id &&
                note.id === secondarySelectedNoteId && {
                  backgroundColor: alpha(
                    theme.palette.secondary.main,
                    theme.palette.mode === 'dark' ? 0.16 : 0.12,
                  ),
                  '&:hover': {
                    backgroundColor: alpha(
                      theme.palette.secondary.main,
                      theme.palette.mode === 'dark' ? 0.24 : 0.18,
                    ),
                  },
                }),
            }}
          >
            <Typography
              noWrap
              variant="body2"
              sx={{
                width: '100%',
                fontStyle:
                  isFileModified?.(note.id) || noteTitle.isFallback
                    ? 'italic'
                    : 'normal',
                opacity: noteTitle.isFallback ? 0.6 : 1,
              }}
            >
              {isFileModified?.(note.id) && (
                <DriveFileRenameOutline
                  sx={{
                    mb: -0.5,
                    mr: 0.5,
                    width: 18,
                    height: 18,
                    color: 'text.secondary',
                  }}
                />
              )}
              {noteTitle.text}
            </Typography>
            <Typography
              variant="caption"
              sx={{
                color:
                  theme.palette.mode === 'dark'
                    ? 'rgba(255, 255, 255, 0.20)'
                    : 'rgba(0, 0, 0, 0.20)',
                width: '100%',
                textAlign: 'right',
              }}
            >
              {dayjs(note.modifiedTime).format('L _ HH:mm:ss')}
            </Typography>
          </ListItemButton>
          {isFileMode ? (
            <>
              <Tooltip title={`Save (${cmdKey} + S)`} arrow placement="bottom">
                <span style={{ position: 'absolute', right: 72, top: 8 }}>
                  <IconButton
                    className="action-button"
                    disabled={
                      !isFileModified?.(note.id) ||
                      (isFileNote(note) && note.filePath === '')
                    }
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (
                        isFileNote(note) &&
                        isFileModified?.(note.id) &&
                        onSaveFile
                      ) {
                        await onSaveFile(note);
                      }
                    }}
                    sx={{
                      opacity: 0,
                      transition: 'opacity 0.2s',
                      width: 26,
                      height: 26,
                      backgroundColor: 'background.default',
                      '&:hover': {
                        backgroundColor: 'success.main',
                        color: 'text.primary',
                      },
                    }}
                  >
                    <Save sx={{ width: 18, height: 18 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Convert to Note" arrow placement="bottom">
                <span style={{ position: 'absolute', right: 40, top: 8 }}>
                  <IconButton
                    className="action-button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (isFileNote(note) && onConvertToNote) {
                        await onConvertToNote(note);
                      }
                    }}
                    sx={{
                      opacity: 0,
                      transition: 'opacity 0.2s',
                      width: 26,
                      height: 26,
                      backgroundColor: 'background.default',
                      '&:hover': {
                        backgroundColor: 'primary.main',
                        color: 'text.primary',
                      },
                    }}
                  >
                    <SimCardDownload sx={{ width: 18, height: 18 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title={`Close (${cmdKey} + W)`} arrow placement="bottom">
                <span style={{ position: 'absolute', right: 8, top: 8 }}>
                  <IconButton
                    className="action-button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (isFileNote(note) && onCloseFile) {
                        await onCloseFile(note);
                      }
                    }}
                    sx={{
                      opacity: 0,
                      transition: 'opacity 0.2s',
                      width: 26,
                      height: 26,
                      backgroundColor: 'background.default',
                      '&:hover': {
                        backgroundColor: 'error.main',
                        color: 'text.primary',
                      },
                    }}
                  >
                    <Close sx={{ width: 18, height: 18 }} />
                  </IconButton>
                </span>
              </Tooltip>
            </>
          ) : (
            onArchive && (
              <Tooltip
                title={`Archive (${cmdKey} + W)`}
                arrow
                placement="bottom"
              >
                <span style={{ position: 'absolute', right: 8, top: 8 }}>
                  <IconButton
                    className="action-button"
                    aria-label={`Archive (${cmdKey} + W)`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={async (e) => {
                      e.stopPropagation();
                      await onArchive(note.id);
                    }}
                    sx={{
                      opacity: 0,
                      transition: 'opacity 0.2s',
                      width: 26,
                      height: 26,
                      backgroundColor: 'background.default',
                      // ホバー時はプライマリ背景＋前景は text.primary で反転させない
                      '&:hover': {
                        backgroundColor: 'primary.main',
                        color: 'text.primary',
                      },
                    }}
                  >
                    <Archive sx={{ width: 18, height: 18 }} />
                  </IconButton>
                </span>
              </Tooltip>
            )
          )}
          <Menu
            open={contextMenu !== null}
            onClose={handleCloseContextMenu}
            anchorReference="anchorPosition"
            anchorPosition={
              contextMenu !== null
                ? { top: contextMenu.mouseY, left: contextMenu.mouseX }
                : undefined
            }
            sx={{ zIndex: 1400 }}
            slotProps={{ paper: { sx: { minWidth: 0 } } }}
          >
            <MenuItem
              dense
              disabled={!canSplit}
              onClick={() => {
                onOpenInPane?.(note, 'left');
                handleCloseContextMenu();
              }}
              sx={{ py: 0.25, fontSize: '0.75rem' }}
            >
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mr: 0.5 }}
              >
                Open in
              </Typography>
              <Typography
                variant="caption"
                sx={{ fontWeight: 'bold', color: 'primary.main' }}
              >
                1: Left Pane
              </Typography>
            </MenuItem>
            <MenuItem
              dense
              disabled={!canSplit}
              onClick={() => {
                onOpenInPane?.(note, 'right');
                handleCloseContextMenu();
              }}
              sx={{ py: 0.25, fontSize: '0.75rem' }}
            >
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mr: 0.5 }}
              >
                Open in
              </Typography>
              <Typography
                variant="caption"
                sx={{ fontWeight: 'bold', color: 'secondary.main' }}
              >
                2: Right Pane
              </Typography>
            </MenuItem>
          </Menu>
        </Box>
      </NotePreviewPopper>
    );
  },
);

const DroppableZone: React.FC<{
  id: string;
  children: React.ReactNode;
}> = ({ id, children }) => {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <Box
      ref={setNodeRef}
      sx={{
        bgcolor: isOver ? 'action.hover' : 'transparent',
        transition: 'background-color 0.2s',
        minHeight: 4,
      }}
    >
      {children}
    </Box>
  );
};

const SortableWrapper: React.FC<{
  id: string;
  children: React.ReactNode;
  dropIndicator?: 'top' | 'bottom' | null;
  indentedIndicator?: boolean;
  insetIndicator?: boolean;
  staticMode?: boolean;
}> = memo(
  ({
    id,
    children,
    dropIndicator,
    indentedIndicator,
    insetIndicator,
    staticMode,
  }) => {
    const {
      attributes,
      listeners,
      setNodeRef,
      transform,
      transition,
      isDragging,
    } = useSortable({ id });

    const style = staticMode
      ? { opacity: isDragging ? 0.3 : 1 }
      : { transform: CSS.Transform.toString(transform), transition };

    const handlePointerDown: React.PointerEventHandler = (e) => {
      e.stopPropagation();
      (listeners?.onPointerDown as (e: React.PointerEvent) => void)?.(e);
    };

    const insetPx = insetIndicator ? 8 : 0;
    const indentPx = indentedIndicator ? 12 : 0;
    const leftPx = insetPx + indentPx;

    return (
      <Box
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        onPointerDown={handlePointerDown}
        sx={{ position: 'relative' }}
      >
        {dropIndicator === 'top' && (
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              left: leftPx,
              right: insetPx,
              height: 2,
              bgcolor: 'primary.main',
              zIndex: 1,
            }}
          />
        )}
        {children}
        {dropIndicator === 'bottom' && (
          <Box
            sx={{
              position: 'absolute',
              bottom: 0,
              left: leftPx,
              right: insetPx,
              height: 2,
              bgcolor: 'primary.main',
              zIndex: 1,
            }}
          />
        )}
      </Box>
    );
  },
);

interface FolderHeaderProps {
  folder: Folder;
  isCollapsed: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onArchive: () => void;
  isEmpty: boolean;
  noteCount: number;
  autoEdit?: boolean;
  onAutoEditDone?: () => void;
}

const FolderHeader: React.FC<FolderHeaderProps> = ({
  folder,
  isCollapsed,
  onToggle,
  onRename,
  onDelete,
  onArchive,
  isEmpty,
  noteCount,
  autoEdit,
  onAutoEditDone,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(folder.name);
  const inputRef = useRef<HTMLInputElement>(null);

  // 新規作成直後に自動で編集モードに入る
  useEffect(() => {
    if (autoEdit) {
      setEditValue(folder.name);
      setIsEditing(true);
      setTimeout(() => inputRef.current?.select(), 0);
      onAutoEditDone?.();
    }
  }, [autoEdit, folder.name, onAutoEditDone]);

  const handleStartEdit = () => {
    setEditValue(folder.name);
    setIsEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const handleFinishEdit = () => {
    setIsEditing(false);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== folder.name) {
      onRename(trimmed);
    }
  };

  return (
    <Box
      onClick={isEditing ? undefined : onToggle}
      sx={{
        height: 28,
        display: 'flex',
        alignItems: 'center',
        px: 0.5,
        backgroundColor: 'action.disabledBackground',
        borderRadius: isCollapsed ? '4px 4px 4px 4px' : '4px 4px 0 0',
        cursor: 'pointer',
        '&:hover .folder-action': { opacity: 1 },
      }}
    >
      <IconButton
        size="small"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        sx={{
          p: 0.25,
          '&:hover': {
            backgroundColor: 'action.hover',
            color: 'text.primary',
          },
        }}
      >
        {isCollapsed ? (
          <ChevronRight
            sx={{ width: 16, height: 16, color: 'text.secondary' }}
          />
        ) : (
          <ExpandMore sx={{ width: 16, height: 16, color: 'text.secondary' }} />
        )}
      </IconButton>
      {isCollapsed ? (
        <FolderIcon
          sx={{ width: 16, height: 16, color: 'text.secondary', mr: 0.5 }}
        />
      ) : (
        <FolderOpen
          sx={{ width: 16, height: 16, color: 'text.secondary', mr: 0.5 }}
        />
      )}
      {isEditing ? (
        <InputBase
          inputRef={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleFinishEdit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') handleFinishEdit();
            if (e.key === 'Escape') setIsEditing(false);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          autoFocus
          sx={{
            flex: 1,
            fontSize: '0.875rem',
            color: 'text.secondary',
            '& input': { py: 0, px: 0.5 },
          }}
        />
      ) : (
        <Typography
          variant="body2"
          color="text.secondary"
          noWrap
          sx={{ flex: 1, cursor: 'pointer', userSelect: 'none' }}
          onDoubleClick={handleStartEdit}
        >
          {folder.name}
        </Typography>
      )}
      <Typography variant="caption" color="text.disabled" sx={{ mx: 0.5 }}>
        {noteCount}
      </Typography>
      {!isEditing && (
        <>
          <Tooltip title="Rename" arrow>
            <IconButton
              className="folder-action"
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                handleStartEdit();
              }}
              onPointerDown={(e) => e.stopPropagation()}
              sx={{
                opacity: 0,
                transition: 'opacity 0.2s',
                p: 0.25,
                mx: 1,
                '&:hover': {
                  backgroundColor: 'primary.main',
                  color: 'text.primary',
                  '& .MuiSvgIcon-root': { color: 'text.primary' },
                },
              }}
            >
              <DriveFileRenameOutline
                sx={{ fontSize: 18, color: 'text.secondary' }}
              />
            </IconButton>
          </Tooltip>
          {isEmpty ? (
            <Tooltip title="Delete" arrow>
              <IconButton
                className="folder-action"
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                sx={{
                  opacity: 0,
                  transition: 'opacity 0.2s',
                  p: 0.25,
                  '&:hover': {
                    backgroundColor: 'error.main',
                    color: 'text.primary',
                    '& .MuiSvgIcon-root': { color: 'text.primary' },
                  },
                }}
              >
                <Delete sx={{ fontSize: 18, color: 'text.secondary' }} />
              </IconButton>
            </Tooltip>
          ) : (
            <Tooltip title="Archive" arrow>
              <IconButton
                className="folder-action"
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  onArchive();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                sx={{
                  opacity: 0,
                  transition: 'opacity 0.2s',
                  p: 0.25,
                  '&:hover': {
                    backgroundColor: 'primary.main',
                    color: 'text.primary',
                    '& .MuiSvgIcon-root': { color: 'text.primary' },
                  },
                }}
              >
                <Archive sx={{ fontSize: 18, color: 'text.secondary' }} />
              </IconButton>
            </Tooltip>
          )}
        </>
      )}
    </Box>
  );
};

export const NoteList: React.FC<NoteListProps> = ({
  notes,
  currentNote,
  onNoteSelect,
  onArchive,
  onConvertToNote,
  onSaveFile,
  onReorder,
  isFileMode,
  onCloseFile,
  isFileModified,
  platform,
  folders = [],
  collapsedFolders = new Set(),
  onToggleFolderCollapse,
  onRenameFolder,
  onDeleteFolder,
  onMoveNoteToFolder,
  editingFolderId,
  onEditingFolderDone,
  topLevelOrder = [],
  onUpdateTopLevelOrder,
  onArchiveFolder,
  secondarySelectedNoteId,
  onOpenInPane,
  canSplit,
}) => {
  const activeNotes = isFileMode
    ? notes
    : (notes as Note[]).filter((note) => !note.archived);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const folderAwareCollision: CollisionDetection = useCallback((args) => {
    const activeId = args.active.id as string;
    const isDraggingFolder = activeId.startsWith('folder:');
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0 && !isDraggingFolder) {
      const preferred = pointerCollisions.find((c) => {
        const id = c.id as string;
        return (
          id.startsWith('folder-drop:') ||
          id.startsWith('folder-note:') ||
          id === 'unfiled-bottom'
        );
      });
      if (preferred) return [preferred];
    }
    const results = closestCenter(args).filter(
      (c) => (c.id as string) !== activeId,
    );
    if (isDraggingFolder) {
      const filtered = results.filter((c) => {
        const id = c.id as string;
        return (
          !id.startsWith('folder-drop:') &&
          !id.startsWith('folder-note:') &&
          id !== 'unfiled-bottom'
        );
      });
      if (filtered.length > 0) return filtered;
    }
    return results;
  }, []);

  const renderNoteItem = useCallback(
    (note: Note | FileNote, isDraggingAny: boolean) => (
      <NoteItem
        key={note.id}
        note={note}
        currentNote={currentNote}
        onNoteSelect={onNoteSelect}
        onArchive={onArchive}
        onConvertToNote={onConvertToNote}
        onSaveFile={onSaveFile}
        getNoteTitle={getNoteTitle}
        isFileMode={isFileMode}
        onCloseFile={onCloseFile}
        isFileModified={isFileModified}
        platform={platform}
        secondarySelectedNoteId={secondarySelectedNoteId}
        onOpenInPane={onOpenInPane}
        canSplit={canSplit}
        isDragging={isDraggingAny}
      />
    ),
    [
      currentNote,
      onNoteSelect,
      onArchive,
      onConvertToNote,
      onSaveFile,
      isFileMode,
      onCloseFile,
      isFileModified,
      platform,
      secondarySelectedNoteId,
      onOpenInPane,
      canSplit,
    ],
  );

  const handleDragEndFlat = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = activeNotes.findIndex((note) => note.id === active.id);
      const newIndex = activeNotes.findIndex((note) => note.id === over.id);

      if (isFileMode) {
        const newFileNotes = arrayMove(
          activeNotes as FileNote[],
          oldIndex,
          newIndex,
        );
        onReorder?.(newFileNotes);
        await SaveFileNotes(newFileNotes);
      } else {
        const archivedNotes = (notes as Note[]).filter((note) => note.archived);
        const newActiveNotes = arrayMove(
          activeNotes as Note[],
          oldIndex,
          newIndex,
        );
        const newNotes = [...newActiveNotes, ...archivedNotes];
        onReorder?.(newNotes);

        try {
          await UpdateNoteOrder(active.id as string, newIndex);
        } catch (error) {
          console.error('Failed to update note order:', error);
        }
      }
    },
    [activeNotes, isFileMode, notes, onReorder],
  );

  // トップレベルアイテムのID生成ヘルパー ----
  const toTopLevelId = useCallback(
    (item: TopLevelItem) => `${item.type}:${item.id}`,
    [],
  );

  const parseTopLevelId = useCallback((id: string): TopLevelItem | null => {
    const idx = id.indexOf(':');
    if (idx === -1) return null;
    const type = id.slice(0, idx) as 'note' | 'folder';
    return { type, id: id.slice(idx + 1) };
  }, []);

  const precedingFolderIds = useMemo(() => {
    const map = new Map<string, string>();
    for (let i = 1; i < topLevelOrder.length; i++) {
      const prev = topLevelOrder[i - 1];
      if (prev.type === 'folder' && !collapsedFolders.has(prev.id)) {
        const hasNotes = (activeNotes as Note[]).some(
          (n) => n.folderId === prev.id,
        );
        if (hasNotes) {
          map.set(toTopLevelId(topLevelOrder[i]), prev.id);
        }
      }
    }
    return map;
  }, [topLevelOrder, toTopLevelId, collapsedFolders, activeNotes]);

  const expandedFolderWithNotesIds = useMemo(() => {
    const set = new Set<string>();
    for (const item of topLevelOrder) {
      if (item.type === 'folder' && !collapsedFolders.has(item.id)) {
        if ((activeNotes as Note[]).some((n) => n.folderId === item.id)) {
          set.add(toTopLevelId(item));
        }
      }
    }
    return set;
  }, [topLevelOrder, toTopLevelId, collapsedFolders, activeNotes]);

  const lastFolderNoteIds = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of topLevelOrder) {
      if (item.type === 'folder' && !collapsedFolders.has(item.id)) {
        const folderNotes = (activeNotes as Note[]).filter(
          (n) => n.folderId === item.id,
        );
        if (folderNotes.length > 0) {
          map.set(
            `folder-note:${folderNotes[folderNotes.length - 1].id}`,
            item.id,
          );
        }
      }
    }
    return map;
  }, [topLevelOrder, collapsedFolders, activeNotes]);

  // folderId → 最後のfolder-note IDの逆引き ----
  const lastFolderNoteByFolderId = useMemo(() => {
    const map = new Map<string, string>();
    for (const [fnId, folderId] of lastFolderNoteIds) {
      map.set(folderId, fnId);
    }
    return map;
  }, [lastFolderNoteIds]);

  // DnDハンドラ: topLevelOrder対応 ----
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // ドラッグ中のインジケータ描画用 state（RAF でバッチ更新）
  const [dragIndicatorState, setDragIndicatorState] = useState<{
    overId: string | null;
    boundaryIndented: boolean;
    insertAbove: boolean;
  }>({ overId: null, boundaryIndented: false, insertAbove: false });
  const overId = dragIndicatorState.overId;
  const boundaryIndented = dragIndicatorState.boundaryIndented;
  const insertAbove = dragIndicatorState.insertAbove;

  const pointerXRef = useRef<number>(0);
  const pointerYRef = useRef<number>(0);
  const overRectRef = useRef<{ top: number; height: number } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [listElement, setListElement] = useState<HTMLUListElement | null>(null);
  const lastBoundaryIndented = useRef(false);
  const lastInsertAbove = useRef(false);
  const lastOverIdRef = useRef<string | null>(null);
  const overIdTimestampRef = useRef(0);
  const rafIdRef = useRef<number>(0);

  const handleListRef = useCallback((node: HTMLUListElement | null) => {
    listRef.current = node;
    setListElement(node);
  }, []);

  const getScrollElement = useCallback((): HTMLElement | null => {
    const listEl = listElement;
    if (!listEl) return null;
    const simpleBarScrollEl = listEl.closest('.simplebar-content-wrapper');
    if (simpleBarScrollEl instanceof HTMLElement) {
      return simpleBarScrollEl;
    }
    return listEl;
  }, [listElement]);

  // ref の最新値を1つの setState にまとめて flush する
  const scheduleDragIndicatorFlush = useCallback(() => {
    if (rafIdRef.current) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = 0;
      setDragIndicatorState({
        overId: lastOverIdRef.current,
        boundaryIndented: lastBoundaryIndented.current,
        insertAbove: lastInsertAbove.current,
      });
    });
  }, []);

  useEffect(() => {
    if (!activeDragId) return;
    const style = document.createElement('style');
    style.textContent = '* { cursor: grabbing !important; }';
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, [activeDragId]);

  const handleDragStartWithFolders = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  const isBoundaryTarget = useCallback(
    (id: string) => {
      if (id.startsWith('folder-drop:')) return true;
      if (lastFolderNoteIds.has(id)) return true;
      return precedingFolderIds.has(id) || expandedFolderWithNotesIds.has(id);
    },
    [precedingFolderIds, expandedFolderWithNotesIds, lastFolderNoteIds],
  );

  const handleDragOverWithFolders = useCallback(
    (event: DragOverEvent) => {
      const newOverId = event.over ? (event.over.id as string) : null;
      const now = Date.now();
      const prev = lastOverIdRef.current;
      if (newOverId !== prev) {
        if (
          now - overIdTimestampRef.current < 80 &&
          prev !== null &&
          newOverId !== null
        ) {
          return;
        }
        lastOverIdRef.current = newOverId;
        overIdTimestampRef.current = now;
      }
      if (newOverId && isBoundaryTarget(newOverId)) {
        const listEl = listRef.current;
        if (listEl) {
          const rect = listEl.getBoundingClientRect();
          const relativeX = pointerXRef.current - rect.left;
          const indented = relativeX > 120;
          lastBoundaryIndented.current = indented;
        }
      }
      // ポインタY座標によるドロップ方向判定 ----
      if (event.over) {
        const overRect = event.over.rect;
        overRectRef.current = { top: overRect.top, height: overRect.height };
        const centerY = overRect.top + overRect.height / 2;
        const above = pointerYRef.current < centerY;
        lastInsertAbove.current = above;
      }
      scheduleDragIndicatorFlush();
    },
    [isBoundaryTarget, scheduleDragIndicatorFlush],
  );

  useEffect(() => {
    if (!activeDragId) return;
    const isBoundary = isBoundaryTarget;
    const handlePointerMove = (e: PointerEvent) => {
      pointerXRef.current = e.clientX;
      pointerYRef.current = e.clientY;
      let changed = false;
      if (lastOverIdRef.current && isBoundary(lastOverIdRef.current)) {
        const listEl = listRef.current;
        if (listEl) {
          const rect = listEl.getBoundingClientRect();
          const relativeX = e.clientX - rect.left;
          const indented = relativeX > 120;
          if (indented !== lastBoundaryIndented.current) {
            lastBoundaryIndented.current = indented;
            changed = true;
          }
        }
      }
      if (lastOverIdRef.current && overRectRef.current) {
        const centerY =
          overRectRef.current.top + overRectRef.current.height / 2;
        const above = e.clientY < centerY;
        if (above !== lastInsertAbove.current) {
          lastInsertAbove.current = above;
          changed = true;
        }
      }
      if (changed) {
        scheduleDragIndicatorFlush();
      }
    };
    document.addEventListener('pointermove', handlePointerMove);
    return () => document.removeEventListener('pointermove', handlePointerMove);
  }, [activeDragId, isBoundaryTarget, scheduleDragIndicatorFlush]);

  const extractNoteId = useCallback((id: string): string | null => {
    if (id.startsWith('folder-note:')) return id.slice('folder-note:'.length);
    if (id.startsWith('note:')) return id.slice('note:'.length);
    return null;
  }, []);

  const getTopLevelIndex = useCallback(
    (id: string): number => {
      const idx = topLevelOrder.findIndex((item) => toTopLevelId(item) === id);
      if (idx !== -1) return idx;
      if (id.startsWith('folder-note:')) {
        const noteId = id.slice('folder-note:'.length);
        const note = (activeNotes as Note[]).find((n) => n.id === noteId);
        if (note?.folderId) {
          return topLevelOrder.findIndex(
            (item) => item.type === 'folder' && item.id === note.folderId,
          );
        }
      }
      return -1;
    },
    [topLevelOrder, toTopLevelId, activeNotes],
  );

  const flatItems = useMemo(() => {
    const items: string[] = [];
    for (const item of topLevelOrder) {
      const itemId = toTopLevelId(item);
      items.push(itemId);
      if (item.type === 'folder' && !collapsedFolders.has(item.id)) {
        const folderNotes = (activeNotes as Note[]).filter(
          (n) => n.folderId === item.id,
        );
        for (const note of folderNotes) {
          items.push(`folder-note:${note.id}`);
        }
      }
    }
    return items;
  }, [topLevelOrder, toTopLevelId, collapsedFolders, activeNotes]);

  const handleDragEndWithFolders = useCallback(
    async (event: DragEndEvent) => {
      setActiveDragId(null);
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
      setDragIndicatorState({
        overId: null,
        boundaryIndented: false,
        insertAbove: false,
      });
      overRectRef.current = null;
      lastOverIdRef.current = null;
      overIdTimestampRef.current = 0;
      const { active, over, delta } = event;

      if (Math.abs(delta.x) < 5 && Math.abs(delta.y) < 5) {
        const parsed = parseTopLevelId(active.id as string);
        if (parsed?.type === 'folder') {
          onToggleFolderCollapse?.(parsed.id);
          return;
        }
      }

      if (!over) return;

      const activeId = active.id as string;
      const dropId = over.id as string;
      const isFolderNoteActive = activeId.startsWith('folder-note:');

      // フォルダヘッダーへのドロップ ----
      if (dropId.startsWith('folder-drop:')) {
        const targetFolderId = dropId.slice('folder-drop:'.length);
        const noteId = extractNoteId(activeId);
        if (noteId) {
          const draggedNote = (activeNotes as Note[]).find(
            (n) => n.id === noteId,
          );
          if (!draggedNote) return;

          if (!lastBoundaryIndented.current) {
            if (draggedNote.folderId) {
              onMoveNoteToFolder?.(noteId, '');
            }
            const folderSortId = `folder:${targetFolderId}`;
            const newOrder = topLevelOrder.filter(
              (item) => !(item.type === 'note' && item.id === noteId),
            );
            const folderIdx = newOrder.findIndex(
              (item) => toTopLevelId(item) === folderSortId,
            );
            newOrder.splice(folderIdx, 0, { type: 'note', id: noteId });
            onUpdateTopLevelOrder?.(newOrder);
            return;
          }

          if ((draggedNote.folderId || '') !== targetFolderId) {
            onMoveNoteToFolder?.(noteId, targetFolderId);
            try {
              await UpdateNoteOrder(noteId, 0);
            } catch (error) {
              console.error('Failed to update note order:', error);
            }
          }
          return;
        }
        if (parseTopLevelId(activeId)?.type === 'folder') return;
        return;
      }

      // 未分類ゾーンにドロップした場合 ----
      if (dropId === 'unfiled-bottom') {
        const noteId = extractNoteId(activeId);
        if (noteId) {
          const draggedNote = (activeNotes as Note[]).find(
            (n) => n.id === noteId,
          );
          if (draggedNote?.folderId) {
            onMoveNoteToFolder?.(noteId, '');
          }
        }
        return;
      }

      // フォルダ内ノートの並び替え（folder-note: プレフィクス同士） ----
      if (isFolderNoteActive && dropId.startsWith('folder-note:')) {
        const activeNoteId = activeId.slice('folder-note:'.length);
        const overNoteId = dropId.slice('folder-note:'.length);
        if (activeNoteId === overNoteId) return;

        const activeNote = (activeNotes as Note[]).find(
          (n) => n.id === activeNoteId,
        );
        const overNote = (activeNotes as Note[]).find(
          (n) => n.id === overNoteId,
        );
        if (!activeNote || !overNote) return;

        if (activeNote.folderId && activeNote.folderId === overNote.folderId) {
          const boundaryFolderIdSame = lastFolderNoteIds.get(dropId);
          if (boundaryFolderIdSame && !lastBoundaryIndented.current) {
            onMoveNoteToFolder?.(activeNoteId, '');
            const folderSortId = `folder:${boundaryFolderIdSame}`;
            const newOrder = [...topLevelOrder];
            const folderIdx = newOrder.findIndex(
              (item) => toTopLevelId(item) === folderSortId,
            );
            newOrder.splice(folderIdx + 1, 0, {
              type: 'note',
              id: activeNoteId,
            });
            onUpdateTopLevelOrder?.(newOrder);
            return;
          }

          const folderNotes = (activeNotes as Note[]).filter(
            (n) => n.folderId === activeNote.folderId,
          );
          const oldIndex = folderNotes.findIndex((n) => n.id === activeNoteId);
          const overIndex = folderNotes.findIndex((n) => n.id === overNoteId);
          const newIndex =
            lastInsertAbove.current && overIndex > oldIndex
              ? overIndex - 1
              : !lastInsertAbove.current && overIndex < oldIndex
                ? overIndex + 1
                : overIndex;

          const archivedNotes = (notes as Note[]).filter(
            (note) => note.archived,
          );
          const otherActiveNotes = (activeNotes as Note[]).filter(
            (n) => n.folderId !== activeNote.folderId,
          );
          const reorderedGroup = arrayMove(folderNotes, oldIndex, newIndex);
          const newNotes = [
            ...otherActiveNotes,
            ...reorderedGroup,
            ...archivedNotes,
          ];
          onReorder?.(newNotes);

          try {
            await UpdateNoteOrder(activeNoteId, newIndex);
          } catch (error) {
            console.error('Failed to update note order:', error);
          }
        } else if (
          overNote.folderId &&
          activeNote.folderId !== overNote.folderId
        ) {
          const targetFolderId = overNote.folderId;
          const folderNotes = (activeNotes as Note[]).filter(
            (n) => n.folderId === targetFolderId,
          );
          const overPosInFolder = folderNotes.findIndex(
            (n) => n.id === overNoteId,
          );
          const insertPos = lastInsertAbove.current
            ? overPosInFolder
            : overPosInFolder + 1;

          const movedNote = { ...activeNote, folderId: targetFolderId } as Note;
          const rest = (activeNotes as Note[]).filter(
            (n) => n.id !== activeNoteId,
          );
          const updatedFolderNotes = rest.filter(
            (n) => n.folderId === targetFolderId,
          );
          updatedFolderNotes.splice(insertPos, 0, movedNote);
          const otherActive = rest.filter((n) => n.folderId !== targetFolderId);
          const archivedNotes = (notes as Note[]).filter(
            (note) => (note as Note).archived,
          );
          onReorder?.([
            ...otherActive,
            ...updatedFolderNotes,
            ...archivedNotes,
          ] as Note[]);

          onMoveNoteToFolder?.(activeNoteId, targetFolderId);

          try {
            await UpdateNoteOrder(activeNoteId, insertPos);
          } catch (error) {
            console.error('Failed to update note order:', error);
          }
        }
        return;
      }

      // 外部ノートをフォルダ内ノートの間にドロップ ----
      if (dropId.startsWith('folder-note:')) {
        const noteId = extractNoteId(activeId);
        if (!noteId) return;
        const overNoteId = dropId.slice('folder-note:'.length);
        const overNote = (activeNotes as Note[]).find(
          (n) => n.id === overNoteId,
        );
        if (!overNote?.folderId) return;
        const draggedNote = (activeNotes as Note[]).find(
          (n) => n.id === noteId,
        );
        if (!draggedNote || draggedNote.folderId === overNote.folderId) return;

        const boundaryFolderId = lastFolderNoteIds.get(dropId);
        if (boundaryFolderId) {
          const folderSortId = `folder:${boundaryFolderId}`;
          const aIdx = getTopLevelIndex(activeId);
          const fIdx = topLevelOrder.findIndex(
            (item) => toTopLevelId(item) === folderSortId,
          );
          if (aIdx !== -1 && fIdx !== -1) {
            if (lastBoundaryIndented.current) {
              if ((draggedNote.folderId || '') !== boundaryFolderId) {
                const folderNotes = (activeNotes as Note[]).filter(
                  (n) => n.folderId === boundaryFolderId,
                );
                onMoveNoteToFolder?.(noteId, boundaryFolderId);
                try {
                  await UpdateNoteOrder(noteId, folderNotes.length);
                } catch (error) {
                  console.error('Failed to update note order:', error);
                }
              }
            } else {
              if (draggedNote.folderId) {
                onMoveNoteToFolder?.(noteId, '');
              }
              const newOrder = topLevelOrder.filter(
                (item) => toTopLevelId(item) !== activeId,
              );
              const newFolderIdx = newOrder.findIndex(
                (item) => toTopLevelId(item) === folderSortId,
              );
              newOrder.splice(newFolderIdx + 1, 0, {
                type: 'note',
                id: noteId,
              });
              onUpdateTopLevelOrder?.(newOrder);
            }
            return;
          }
        }

        const targetFolderId = overNote.folderId;
        const folderNotes = (activeNotes as Note[]).filter(
          (n) => n.folderId === targetFolderId,
        );
        const insertAfterTarget = !lastInsertAbove.current;
        const overPosInFolder = folderNotes.findIndex(
          (n) => n.id === overNoteId,
        );
        const insertPos = insertAfterTarget
          ? overPosInFolder + 1
          : overPosInFolder;

        const movedNote = { ...draggedNote, folderId: targetFolderId } as Note;
        const rest = (activeNotes as Note[]).filter((n) => n.id !== noteId);
        const updatedFolderNotes = rest.filter(
          (n) => n.folderId === targetFolderId,
        );
        updatedFolderNotes.splice(insertPos, 0, movedNote);
        const otherActive = rest.filter((n) => n.folderId !== targetFolderId);
        const archivedNotes = (notes as Note[]).filter(
          (note) => (note as Note).archived,
        );
        onReorder?.([
          ...otherActive,
          ...updatedFolderNotes,
          ...archivedNotes,
        ] as Note[]);

        onMoveNoteToFolder?.(noteId, targetFolderId);

        const oldGlobalIdx = (activeNotes as Note[]).findIndex(
          (n) => n.id === noteId,
        );
        const globalOverIdx = (activeNotes as Note[]).findIndex(
          (n) => n.id === overNoteId,
        );
        const postRemovalOverIdx =
          oldGlobalIdx < globalOverIdx ? globalOverIdx - 1 : globalOverIdx;
        const backendInsertIdx = insertAfterTarget
          ? postRemovalOverIdx + 1
          : postRemovalOverIdx;

        try {
          await UpdateNoteOrder(noteId, backendInsertIdx);
        } catch (error) {
          console.error('Failed to update note order:', error);
        }
        return;
      }

      // フォルダ境界の左右判定: インデント側→フォルダ末尾に追加 ----
      if (lastBoundaryIndented.current) {
        let targetFolderIdForBoundary: string | undefined;

        const fromBelow = precedingFolderIds.get(dropId);
        if (fromBelow) {
          targetFolderIdForBoundary = fromBelow;
        }

        if (
          !targetFolderIdForBoundary &&
          expandedFolderWithNotesIds.has(dropId)
        ) {
          const activeIdx = getTopLevelIndex(activeId);
          const overIdx = topLevelOrder.findIndex(
            (item) => toTopLevelId(item) === dropId,
          );
          if (activeIdx !== -1 && overIdx !== -1 && activeIdx < overIdx) {
            targetFolderIdForBoundary = dropId.slice('folder:'.length);
          }
        }

        if (targetFolderIdForBoundary) {
          const noteId = extractNoteId(activeId);
          if (noteId) {
            const draggedNote = (activeNotes as Note[]).find(
              (n) => n.id === noteId,
            );
            if (
              draggedNote &&
              (draggedNote.folderId || '') !== targetFolderIdForBoundary
            ) {
              const folderNotes = (activeNotes as Note[]).filter(
                (n) => n.folderId === targetFolderIdForBoundary,
              );
              onMoveNoteToFolder?.(noteId, targetFolderIdForBoundary);
              try {
                await UpdateNoteOrder(noteId, folderNotes.length);
              } catch (error) {
                console.error('Failed to update note order:', error);
              }
            }
            return;
          }
        }
      }

      // フォルダ内ノートをトップレベルアイテムにドロップ → フォルダから出す ----
      if (isFolderNoteActive) {
        const noteId = extractNoteId(activeId);
        if (!noteId) return;
        const draggedNote = (activeNotes as Note[]).find(
          (n) => n.id === noteId,
        );
        if (!draggedNote?.folderId) return;

        const parsedOver = parseTopLevelId(dropId);
        if (!parsedOver) return;

        const overIndex = topLevelOrder.findIndex(
          (item) => toTopLevelId(item) === dropId,
        );
        if (overIndex === -1) return;

        onMoveNoteToFolder?.(noteId, '');
        const newItem: TopLevelItem = { type: 'note', id: noteId };
        const newOrder = [...topLevelOrder];
        const insertIdx = lastInsertAbove.current ? overIndex : overIndex + 1;
        newOrder.splice(insertIdx, 0, newItem);
        onUpdateTopLevelOrder?.(newOrder);
        return;
      }

      // トップレベルアイテムの並び替え ----
      if (activeId === dropId) return;

      const parsedActive = parseTopLevelId(activeId);
      const parsedOver = parseTopLevelId(dropId);
      if (!parsedActive || !parsedOver) return;

      const oldIndex = topLevelOrder.findIndex(
        (item) => toTopLevelId(item) === activeId,
      );
      const overIndex = topLevelOrder.findIndex(
        (item) => toTopLevelId(item) === dropId,
      );
      if (oldIndex === -1 || overIndex === -1) return;
      const newIndex =
        lastInsertAbove.current && overIndex > oldIndex
          ? overIndex - 1
          : !lastInsertAbove.current && overIndex < oldIndex
            ? overIndex + 1
            : overIndex;

      const newOrder = arrayMove(topLevelOrder, oldIndex, newIndex);
      onUpdateTopLevelOrder?.(newOrder);
    },
    [
      activeNotes,
      notes,
      topLevelOrder,
      onMoveNoteToFolder,
      onReorder,
      onUpdateTopLevelOrder,
      onToggleFolderCollapse,
      parseTopLevelId,
      toTopLevelId,
      extractNoteId,
      getTopLevelIndex,
      precedingFolderIds,
      expandedFolderWithNotesIds,
      lastFolderNoteIds,
    ],
  );

  const isLastFolderNoteBoundary = useCallback(
    (targetId: string): boolean => {
      if (!activeDragId || activeDragId === targetId) return false;
      const folderId = lastFolderNoteIds.get(targetId);
      if (!folderId) return false;
      const folderSortId = `folder:${folderId}`;
      return expandedFolderWithNotesIds.has(folderSortId);
    },
    [activeDragId, expandedFolderWithNotesIds, lastFolderNoteIds],
  );

  const getDropIndicator = useCallback(
    (itemId: string): 'top' | 'bottom' | null => {
      if (!activeDragId || !overId || activeDragId === itemId) return null;
      if (overId.startsWith('folder-drop:')) {
        if (!boundaryIndented && extractNoteId(activeDragId)) {
          const folderId = overId.slice('folder-drop:'.length);
          if (itemId === `folder:${folderId}`) return 'top';
        }
        return null;
      }
      if (lastFolderNoteIds.has(overId) && isLastFolderNoteBoundary(overId)) {
        if (itemId === overId) return 'bottom';
        return null;
      }
      if (
        activeDragId.startsWith('folder:') &&
        overId.startsWith('folder:') &&
        !insertAbove
      ) {
        const lastFnId = lastFolderNoteByFolderId.get(
          overId.slice('folder:'.length),
        );
        if (lastFnId) {
          return itemId === lastFnId ? 'bottom' : null;
        }
      }
      if (overId !== itemId) return null;
      return insertAbove ? 'top' : 'bottom';
    },
    [
      activeDragId,
      overId,
      isLastFolderNoteBoundary,
      lastFolderNoteIds,
      lastFolderNoteByFolderId,
      boundaryIndented,
      extractNoteId,
      insertAbove,
    ],
  );

  const hasFolders = !isFileMode && folders.length > 0;
  const isTestEnv = import.meta.env.MODE === 'test';

  const hasFoldersVirtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement,
    estimateSize: () => 52,
    initialRect: { width: 0, height: 800 },
    overscan: 8,
  });

  const flatModeVirtualizer = useVirtualizer({
    count: activeNotes.length,
    getScrollElement,
    estimateSize: () => 52,
    initialRect: { width: 0, height: 800 },
    overscan: 8,
  });

  if (hasFolders) {
    const noteMap = new Map((activeNotes as Note[]).map((n) => [n.id, n]));
    const folderMap = new Map(folders.map((f) => [f.id, f]));
    const folderRows = isTestEnv
      ? flatItems.map((id, index) => ({
          id,
          key: `${id}-${index}`,
          index,
          start: 0,
        }))
      : hasFoldersVirtualizer.getVirtualItems().map((virtualRow) => ({
          id: flatItems[virtualRow.index],
          key: `${flatItems[virtualRow.index]}-${virtualRow.key}`,
          index: virtualRow.index,
          start: virtualRow.start,
        }));

    return (
      <List ref={handleListRef} sx={{ flexGrow: 1, overflow: 'auto' }}>
        <DndContext
          sensors={sensors}
          collisionDetection={folderAwareCollision}
          onDragStart={handleDragStartWithFolders}
          onDragOver={handleDragOverWithFolders}
          onDragEnd={handleDragEndWithFolders}
          modifiers={[restrictToVerticalAxis]}
        >
          <SortableContext
            items={flatItems}
            strategy={verticalListSortingStrategy}
          >
            <Box
              sx={{
                height: isTestEnv
                  ? 'auto'
                  : hasFoldersVirtualizer.getTotalSize(),
                position: isTestEnv ? 'static' : 'relative',
                width: '100%',
              }}
            >
              {folderRows.map((row) => {
                const id = row.id;
                const indicator = getDropIndicator(id);
                const isAtBoundary =
                  boundaryIndented &&
                  ((indicator === 'top' && precedingFolderIds.has(id)) ||
                    (indicator === 'bottom' && lastFolderNoteIds.has(id)));

                let content: React.ReactNode = null;

                if (id.startsWith('folder-note:')) {
                  const noteId = id.slice('folder-note:'.length);
                  const note = noteMap.get(noteId);
                  if (!note) return null;
                  const isLastBoundary =
                    indicator === 'bottom' && lastFolderNoteIds.has(id);
                  const isLastInFolder = lastFolderNoteIds.has(id);
                  content = (
                    <SortableWrapper
                      id={id}
                      dropIndicator={indicator}
                      indentedIndicator={
                        isLastBoundary ? boundaryIndented : true
                      }
                      insetIndicator
                      staticMode
                    >
                      <Box
                        sx={{
                          mx: 1,
                          borderLeft: '1px solid',
                          borderRight: '1px solid',
                          borderColor: 'action.disabled',
                          ...(isLastInFolder && {
                            borderBottom: '1px solid',
                            borderBottomColor: 'action.disabled',
                            borderColor: 'action.disabled',
                            borderRadius: '0 0 4px 4px',
                          }),
                        }}
                      >
                        <Box
                          sx={(theme) => ({
                            borderLeft: `${theme.spacing(1.5)} solid ${theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}`,
                            backgroundColor:
                              theme.palette.mode === 'dark'
                                ? 'rgba(255,255,255,0.04)'
                                : 'rgba(0,0,0,0.06)',
                          })}
                        >
                          {renderNoteItem(note, !!activeDragId)}
                        </Box>
                      </Box>
                    </SortableWrapper>
                  );
                } else {
                  const parsed = parseTopLevelId(id);

                  if (parsed?.type === 'note') {
                    const note = noteMap.get(parsed.id);
                    if (!note) return null;
                    content = (
                      <SortableWrapper
                        id={id}
                        dropIndicator={indicator}
                        indentedIndicator={isAtBoundary}
                        insetIndicator
                        staticMode
                      >
                        <Box sx={{ mx: 1 }}>
                          {renderNoteItem(note, !!activeDragId)}
                        </Box>
                      </SortableWrapper>
                    );
                  }

                  if (parsed?.type === 'folder') {
                    const folder = folderMap.get(parsed.id);
                    if (!folder) return null;
                    const folderNotes = (activeNotes as Note[]).filter(
                      (n) => n.folderId === folder.id,
                    );
                    const isDraggingThis = activeDragId === id;
                    content = (
                      <SortableWrapper
                        id={id}
                        dropIndicator={indicator}
                        indentedIndicator={isAtBoundary}
                        insetIndicator
                        staticMode
                      >
                        <Box
                          sx={{
                            mx: 1,
                            border: '1px solid',
                            borderColor: 'action.disabled',
                            borderRadius:
                              folderNotes.length === 0 ||
                              collapsedFolders.has(folder.id) ||
                              isDraggingThis
                                ? 1
                                : '4px 4px 0 0',
                            borderBottomWidth:
                              folderNotes.length > 0 &&
                              !collapsedFolders.has(folder.id) &&
                              !isDraggingThis
                                ? 0
                                : undefined,
                          }}
                        >
                          <DroppableZone id={`folder-drop:${folder.id}`}>
                            <FolderHeader
                              folder={folder}
                              isCollapsed={
                                collapsedFolders.has(folder.id) ||
                                isDraggingThis
                              }
                              onToggle={() =>
                                onToggleFolderCollapse?.(folder.id)
                              }
                              onRename={(name) =>
                                onRenameFolder?.(folder.id, name)
                              }
                              onDelete={() => onDeleteFolder?.(folder.id)}
                              onArchive={() => onArchiveFolder?.(folder.id)}
                              isEmpty={folderNotes.length === 0}
                              noteCount={folderNotes.length}
                              autoEdit={editingFolderId === folder.id}
                              onAutoEditDone={onEditingFolderDone}
                            />
                          </DroppableZone>
                          {overId === `folder-drop:${folder.id}` &&
                            activeDragId &&
                            extractNoteId(activeDragId) &&
                            boundaryIndented && (
                              <Box
                                sx={(theme) => ({
                                  height: 2,
                                  bgcolor: 'primary.main',
                                  ml: theme.spacing(1.5),
                                })}
                              />
                            )}
                        </Box>
                      </SortableWrapper>
                    );
                  }
                }

                if (!content) return null;

                return (
                  <Box
                    key={row.key}
                    data-index={isTestEnv ? undefined : row.index}
                    ref={
                      isTestEnv
                        ? undefined
                        : hasFoldersVirtualizer.measureElement
                    }
                    sx={{
                      position: isTestEnv ? 'relative' : 'absolute',
                      top: isTestEnv ? undefined : row.start,
                      left: 0,
                      width: '100%',
                    }}
                  >
                    {content}
                  </Box>
                );
              })}
            </Box>
          </SortableContext>

          {/* 最下部の未分類ドロップゾーン ---- */}
          <DroppableZone id="unfiled-bottom">
            <Box sx={{ minHeight: 8 }} />
          </DroppableZone>

          <DragOverlay dropAnimation={null}>
            {activeDragId &&
              (() => {
                const fnId = activeDragId.startsWith('folder-note:')
                  ? activeDragId.slice('folder-note:'.length)
                  : null;
                if (fnId) {
                  const note = noteMap.get(fnId);
                  if (note) return renderNoteItem(note, true);
                }
                const parsed = parseTopLevelId(activeDragId);
                if (parsed?.type === 'note') {
                  const note = noteMap.get(parsed.id);
                  if (note) return renderNoteItem(note, true);
                }
                if (parsed?.type === 'folder') {
                  const folder = folderMap.get(parsed.id);
                  if (folder) {
                    const fNotes = (activeNotes as Note[]).filter(
                      (n) => n.folderId === folder.id,
                    );
                    return (
                      <FolderHeader
                        folder={folder}
                        isCollapsed
                        onToggle={() => {}}
                        onRename={() => {}}
                        onDelete={() => {}}
                        onArchive={() => {}}
                        isEmpty={fNotes.length === 0}
                        noteCount={fNotes.length}
                      />
                    );
                  }
                }
                return null;
              })()}
          </DragOverlay>
        </DndContext>
      </List>
    );
  }

  return (
    <List ref={handleListRef} sx={{ flexGrow: 1, overflow: 'auto' }}>
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStartWithFolders}
        onDragOver={handleDragOverWithFolders}
        onDragEnd={handleDragEndFlat}
        modifiers={[restrictToVerticalAxis]}
      >
        <SortableContext
          items={activeNotes.map((note) => note.id)}
          strategy={verticalListSortingStrategy}
        >
          {(() => {
            const flatRows = isTestEnv
              ? activeNotes.map((note, index) => ({
                  note,
                  key: `${note.id}-${index}`,
                  index,
                  start: 0,
                }))
              : flatModeVirtualizer.getVirtualItems().map((virtualRow) => ({
                  note: activeNotes[virtualRow.index],
                  key: `${activeNotes[virtualRow.index]?.id ?? virtualRow.index}-${virtualRow.key}`,
                  index: virtualRow.index,
                  start: virtualRow.start,
                }));

            if (flatRows.length === 0) return null;

            return (
              <Box
                sx={{
                  height: isTestEnv
                    ? 'auto'
                    : flatModeVirtualizer.getTotalSize(),
                  position: isTestEnv ? 'static' : 'relative',
                  width: '100%',
                }}
              >
                {flatRows.map((row) => {
                  const note = row.note;
                  if (!note) return null;
                  return (
                    <Box
                      key={row.key}
                      data-index={isTestEnv ? undefined : row.index}
                      ref={
                        isTestEnv
                          ? undefined
                          : flatModeVirtualizer.measureElement
                      }
                      sx={{
                        position: isTestEnv ? 'relative' : 'absolute',
                        top: isTestEnv ? undefined : row.start,
                        left: 0,
                        width: '100%',
                      }}
                    >
                      <Box sx={{ mx: 1 }}>
                        <SortableWrapper id={note.id} staticMode>
                          {renderNoteItem(note, !!activeDragId)}
                        </SortableWrapper>
                      </Box>
                    </Box>
                  );
                })}
              </Box>
            );
          })()}
        </SortableContext>
      </DndContext>
    </List>
  );
};
