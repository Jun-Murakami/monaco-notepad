import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { pointerOutsideOfPreview } from '@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview';
import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview';
import { reorder } from '@atlaskit/pragmatic-drag-and-drop/reorder';
import {
  attachClosestEdge,
  type Edge,
  extractClosestEdge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { getReorderDestinationIndex } from '@atlaskit/pragmatic-drag-and-drop-hitbox/util/get-reorder-destination-index';
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
import {
  type ComponentProps,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { SaveFileNotes, UpdateNoteOrder } from '../../wailsjs/go/backend/App';
import type { FileNote, Folder, Note, TopLevelItem } from '../types';
import { NotePreviewPopper } from './NotePreviewPopper';

const detectTargetPane = (x: number, y: number): 'left' | 'right' | null => {
  const elements = document.elementsFromPoint(x, y);
  for (const el of elements) {
    const paneEl = (el as HTMLElement).closest('[data-pane]');
    if (paneEl) {
      return paneEl.getAttribute('data-pane') as 'left' | 'right';
    }
  }
  return null;
};

const getNoteTitle = (
  note: Note | FileNote,
  t: (key: string) => string,
): { text: string; isFallback: boolean } => {
  if ('filePath' in note) {
    return { text: note.fileName, isFallback: false };
  }

  if (note.title.trim()) return { text: note.title, isFallback: false };

  if (note.syncing) return { text: t('notes.loading'), isFallback: true };

  if (note.archived && note.contentHeader) {
    return {
      text: note.contentHeader.replace(/\r\n|\n|\r/g, ' ').slice(0, 30),
      isFallback: true,
    };
  }

  const content = note.content?.trim() || '';
  if (!content) return { text: t('notes.newNote'), isFallback: true };

  const lines = content.split('\n');
  const firstNonEmptyLine = lines.find((line) => line.trim().length > 0);
  if (!firstNonEmptyLine) return { text: t('notes.newNote'), isFallback: true };

  return {
    text: content.replace(/\r\n|\n|\r/g, ' ').slice(0, 30),
    isFallback: true,
  };
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const DRAG_ITEM_KEY = Symbol('note-list-drag-item');
const DROP_TARGET_KEY = Symbol('note-list-drop-target');

const FOLDER_BOUNDARY_INDENT_THRESHOLD = 96;
const INDENT_INDICATOR_OFFSET = 12;
const INDICATOR_INSET = 8;

interface NoteListProps {
  notes: Note[] | FileNote[];
  currentNote: Note | FileNote | null;
  onNoteSelect: (note: Note | FileNote) => Promise<void>;
  allowReselect?: boolean;
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
  onDropFileNoteToNotes?: (
    fileNoteId: string,
    target: FileDropInsertionTarget,
  ) => Promise<void>;
}

interface NoteItemProps {
  note: Note | FileNote;
  currentNote: Note | FileNote | null;
  onNoteSelect: (note: Note | FileNote) => Promise<void>;
  allowReselect?: boolean;
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
    allowReselect,
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
    const { t } = useTranslation();
    const noteTitle = getNoteTitle(note);
    const [contextMenu, setContextMenu] = useState<{
      mouseX: number;
      mouseY: number;
    } | null>(null);

    const isFileNote = (value: Note | FileNote): value is FileNote =>
      'filePath' in value;
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
        modifiedTime={note.modifiedTime}
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
              if (!isSyncing && (allowReselect || currentNote?.id !== note.id)) {
                await onNoteSelect(note);
              }
            }}
            onContextMenu={handleContextMenu}
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              py: 0.75,
              px: 1.5,
              ...(theme.palette.mode === 'light' && {
                '&.Mui-selected': {
                  backgroundColor: alpha(theme.palette.primary.main, 0.16),
                },
                '&.Mui-selected:hover': {
                  backgroundColor: alpha(theme.palette.primary.main, 0.24),
                },
              }),
              ...(currentNote?.id !== note.id &&
                note.id === secondarySelectedNoteId && {
                  backgroundColor: alpha(
                    theme.palette.secondary.main,
                    theme.palette.mode === 'dark' ? 0.16 : 0.16,
                  ),
                  '&:hover': {
                    backgroundColor: alpha(
                      theme.palette.secondary.main,
                      theme.palette.mode === 'dark' ? 0.24 : 0.24,
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
          </ListItemButton>
          {isFileMode ? (
            <>
              <Tooltip
                title={t('notes.saveShortcut', { shortcut: cmdKey })}
                arrow
                placement="bottom"
              >
                <span
                  style={{
                    position: 'absolute',
                    right: 72,
                    top: '50%',
                    transform: 'translateY(-50%)',
                  }}
                >
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
              <Tooltip title={t('notes.convertToNote')} arrow placement="bottom">
                <span
                  style={{
                    position: 'absolute',
                    right: 40,
                    top: '50%',
                    transform: 'translateY(-50%)',
                  }}
                >
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
              <Tooltip
                title={t('notes.closeShortcut', { shortcut: cmdKey })}
                arrow
                placement="bottom"
              >
                <span
                  style={{
                    position: 'absolute',
                    right: 8,
                    top: '50%',
                    transform: 'translateY(-50%)',
                  }}
                >
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
                title={t('notes.archiveShortcut', { shortcut: cmdKey })}
                arrow
                placement="bottom"
              >
                <span
                  style={{
                    position: 'absolute',
                    right: 8,
                    top: '50%',
                    transform: 'translateY(-50%)',
                  }}
                >
                  <IconButton
                    className="action-button"
                    aria-label={t('notes.archiveShortcut', { shortcut: cmdKey })}
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
                {t('notes.openIn')}
              </Typography>
              <Typography
                variant="caption"
                sx={{ fontWeight: 'bold', color: 'primary.main' }}
              >
                {t('notes.leftPane')}
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
                {t('notes.openIn')}
              </Typography>
              <Typography
                variant="caption"
                sx={{ fontWeight: 'bold', color: 'secondary.main' }}
              >
                {t('notes.rightPane')}
              </Typography>
            </MenuItem>
          </Menu>
        </Box>
      </NotePreviewPopper>
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
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(folder.name);
  const inputRef = useRef<HTMLInputElement>(null);

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
          <Tooltip title={t('notes.rename')} arrow>
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
            <Tooltip title={t('notes.delete')} arrow>
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
            <Tooltip title={t('notes.archive')} arrow>
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

type DragData =
  | {
      kind: 'note';
      noteId: string;
      source: 'note' | 'file';
    }
  | {
      kind: 'folder';
      folderId: string;
    };

export type FileDropInsertionTarget =
  | {
      kind: 'flat';
      destinationIndex: number;
    }
  | {
      kind: 'top-level';
      topLevelInsertIndex: number;
    }
  | {
      kind: 'folder';
      folderId: string;
      positionInFolder: number;
      destinationIndex: number;
    };

type NativePreviewState = {
  item: DragData;
  container: HTMLElement;
  width: number;
};

type DropRowKind =
  | 'flat-note'
  | 'flat-tail'
  | 'top-note'
  | 'folder'
  | 'folder-note'
  | 'folder-tail'
  | 'unfiled-bottom';

type DropData = {
  kind: DropRowKind;
  rowId: string;
  noteId?: string;
  folderId?: string;
  topLevelIndex?: number;
  isLastInFolder?: boolean;
};

type HoverState = {
  target: DropData;
  edge: Edge | null;
  boundaryIndented: boolean;
  indicatorTop: number;
  indicatorIndented: boolean;
};

type ActiveDragState = {
  item: DragData;
  pointer: { x: number; y: number };
  hover: HoverState | null;
};

type DisplayRow =
  | {
      kind: 'flat-note';
      rowId: string;
      note: Note | FileNote;
    }
  | {
      kind: 'flat-tail';
      rowId: 'flat-tail';
    }
  | {
      kind: 'top-note';
      rowId: string;
      note: Note;
      topLevelIndex: number;
    }
  | {
      kind: 'folder';
      rowId: string;
      folder: Folder;
      topLevelIndex: number;
      noteCount: number;
      isCollapsed: boolean;
    }
  | {
      kind: 'folder-note';
      rowId: string;
      note: Note;
      folderId: string;
      topLevelIndex: number;
      isLastInFolder: boolean;
    }
  | {
      kind: 'folder-tail';
      rowId: string;
      folderId: string;
      topLevelIndex: number;
    }
  | {
      kind: 'unfiled-bottom';
      rowId: 'unfiled-bottom';
    };

const isSameTopLevelOrder = (a: TopLevelItem[], b: TopLevelItem[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.type !== b[i]?.type || a[i]?.id !== b[i]?.id) {
      return false;
    }
  }
  return true;
};

const removeTopLevelNote = (
  order: TopLevelItem[],
  noteId: string,
): TopLevelItem[] =>
  order.filter((item) => !(item.type === 'note' && item.id === noteId));

export const insertTopLevelNote = (
  order: TopLevelItem[],
  noteId: string,
  index: number,
): TopLevelItem[] => {
  const currentIndex = order.findIndex(
    (item) => item.type === 'note' && item.id === noteId,
  );
  const without = removeTopLevelNote(order, noteId);
  let insertAt = index;
  if (currentIndex !== -1 && currentIndex < insertAt) {
    insertAt -= 1;
  }
  insertAt = clamp(insertAt, 0, without.length);
  without.splice(insertAt, 0, { type: 'note', id: noteId });
  return without;
};

export const moveTopLevelItem = (
  order: TopLevelItem[],
  itemType: 'note' | 'folder',
  itemId: string,
  insertIndex: number,
): TopLevelItem[] => {
  const currentIndex = order.findIndex(
    (item) => item.type === itemType && item.id === itemId,
  );
  if (currentIndex === -1) return order;
  const moving = order[currentIndex];
  const without = order.filter((_, index) => index !== currentIndex);
  let safeIndex = insertIndex;
  if (currentIndex < safeIndex) {
    safeIndex -= 1;
  }
  safeIndex = clamp(safeIndex, 0, without.length);
  without.splice(safeIndex, 0, moving);
  return without;
};

const readDragData = (
  data: Record<string | symbol, unknown>,
): DragData | null => {
  const value = data[DRAG_ITEM_KEY];
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<DragData>;
  if (candidate.kind === 'note' && typeof candidate.noteId === 'string') {
    return {
      kind: 'note',
      noteId: candidate.noteId,
      source: candidate.source === 'file' ? 'file' : 'note',
    };
  }
  if (candidate.kind === 'folder' && typeof candidate.folderId === 'string') {
    return { kind: 'folder', folderId: candidate.folderId };
  }
  return null;
};

const readDropData = (
  data: Record<string | symbol, unknown>,
): DropData | null => {
  const value = data[DROP_TARGET_KEY];
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<DropData>;
  if (typeof candidate.kind !== 'string' || typeof candidate.rowId !== 'string')
    return null;
  return candidate as DropData;
};

const canDropOnTarget = (dragData: DragData, dropData: DropData): boolean => {
  if (dragData.kind === 'folder') {
    return (
      dropData.kind === 'folder' ||
      dropData.kind === 'top-note' ||
      dropData.kind === 'unfiled-bottom'
    );
  }

  if (
    dropData.kind === 'flat-note' ||
    dropData.kind === 'flat-tail' ||
    dropData.kind === 'top-note' ||
    dropData.kind === 'folder-note'
  ) {
    return dropData.noteId !== dragData.noteId;
  }

  return (
    dropData.kind === 'folder' ||
    dropData.kind === 'folder-tail' ||
    dropData.kind === 'unfiled-bottom'
  );
};

const computeBoundaryIndented = (
  dropData: DropData,
  edge: Edge | null,
  clientX: number,
  element: Element,
): boolean => {
  const rect = element.getBoundingClientRect();
  if (dropData.kind === 'folder-note') {
    if (dropData.isLastInFolder && edge === 'bottom') {
      return clientX > rect.left + FOLDER_BOUNDARY_INDENT_THRESHOLD;
    }
    return true;
  }
  if (dropData.kind === 'folder-tail') {
    return clientX > rect.left + FOLDER_BOUNDARY_INDENT_THRESHOLD;
  }
  if (dropData.kind === 'folder' && edge === 'bottom') {
    return clientX > rect.left + FOLDER_BOUNDARY_INDENT_THRESHOLD;
  }
  return false;
};

const computeIndicatorIndented = (
  dropData: DropData,
  edge: Edge | null,
  boundaryIndented: boolean,
): boolean => {
  if (dropData.kind === 'folder-note') {
    if (dropData.isLastInFolder && edge === 'bottom') {
      return boundaryIndented;
    }
    return true;
  }
  if (dropData.kind === 'folder-tail') {
    return boundaryIndented;
  }
  if (dropData.kind === 'folder' && edge === 'bottom') {
    return boundaryIndented;
  }
  return false;
};

const isDropEdge = (value: Edge | null): value is 'top' | 'bottom' =>
  value === 'top' || value === 'bottom';

const moveNoteWithinActiveList = (
  activeNotes: Note[],
  noteId: string,
  targetFolderId: string,
  positionInFolder: number,
): {
  newActive: Note[];
  insertIndex: number;
} | null => {
  const source = activeNotes.find((note) => note.id === noteId);
  if (!source) return null;

  const notesWithout = activeNotes.filter((note) => note.id !== noteId);
  const sourceIndex = activeNotes.findIndex((note) => note.id === noteId);
  const normalizedFolderId = targetFolderId || '';

  const targetPositions: number[] = [];
  notesWithout.forEach((note, index) => {
    if ((note.folderId ?? '') === normalizedFolderId) {
      targetPositions.push(index);
    }
  });

  let insertIndex = sourceIndex;
  if (targetPositions.length === 0) {
    insertIndex = clamp(sourceIndex, 0, notesWithout.length);
  } else if (positionInFolder <= 0) {
    insertIndex = targetPositions[0];
  } else if (positionInFolder >= targetPositions.length) {
    insertIndex = targetPositions[targetPositions.length - 1] + 1;
  } else {
    insertIndex = targetPositions[positionInFolder];
  }

  const moved: Note =
    (source.folderId ?? '') === normalizedFolderId
      ? source
      : {
          ...source,
          folderId: normalizedFolderId || undefined,
        };

  const newActive = [
    ...notesWithout.slice(0, insertIndex),
    moved,
    ...notesWithout.slice(insertIndex),
  ];
  return { newActive, insertIndex };
};

const getInsertIndexForFolder = (
  activeNotes: Note[],
  targetFolderId: string,
  positionInFolder: number,
): number => {
  const normalizedFolderId = targetFolderId || '';
  const targetPositions: number[] = [];
  activeNotes.forEach((note, index) => {
    if ((note.folderId ?? '') === normalizedFolderId) {
      targetPositions.push(index);
    }
  });

  if (targetPositions.length === 0) {
    return activeNotes.length;
  }
  if (positionInFolder <= 0) {
    return targetPositions[0] ?? activeNotes.length;
  }
  if (positionInFolder >= targetPositions.length) {
    return (targetPositions[targetPositions.length - 1] ?? activeNotes.length) + 1;
  }
  return targetPositions[positionInFolder] ?? activeNotes.length;
};

const PragmaticRow: React.FC<{
  isTestEnv: boolean;
  dragData?: DragData;
  dropData: DropData;
  isDragSource?: boolean;
  onNativePreviewChange?: (preview: NativePreviewState | null) => void;
  children: React.ReactNode;
  sx?: ComponentProps<typeof Box>['sx'];
}> = ({
  isTestEnv,
  dragData,
  dropData,
  isDragSource,
  onNativePreviewChange,
  children,
  sx,
}) => {
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isTestEnv) return;
    const element = rowRef.current;
    if (!element) return;

    const cleanups: Array<() => void> = [];

    cleanups.push(
      dropTargetForElements({
        element,
        canDrop: ({ source }) => {
          const drag = readDragData(source.data);
          if (!drag) return false;
          return canDropOnTarget(drag, dropData);
        },
        getData: ({ input, element: targetElement }) => {
          const baseData = {
            [DROP_TARGET_KEY]: dropData,
          } as Record<string | symbol, unknown>;

          if (dropData.kind === 'unfiled-bottom') {
            return baseData;
          }

          const allowedEdges: Edge[] =
            dropData.kind === 'folder-tail' || dropData.kind === 'flat-tail'
              ? ['top']
              : ['top', 'bottom'];
          return attachClosestEdge(baseData, {
            input,
            element: targetElement,
            allowedEdges,
          });
        },
      }),
    );

    if (dragData) {
      cleanups.push(
        draggable({
          element,
          getInitialData: () =>
            ({
              [DRAG_ITEM_KEY]: dragData,
            }) as Record<string | symbol, unknown>,
          onGenerateDragPreview: ({ nativeSetDragImage }) => {
            setCustomNativeDragPreview({
              nativeSetDragImage,
              getOffset: pointerOutsideOfPreview({ x: '12px', y: '8px' }),
              render: ({ container }) => {
                onNativePreviewChange?.({
                  item: dragData,
                  container,
                  width: element.getBoundingClientRect().width,
                });
                return () => onNativePreviewChange?.(null);
              },
            });
          },
        }),
      );
    }

    return combine(...cleanups);
  }, [dragData, dropData, isTestEnv, onNativePreviewChange]);

  return (
    <Box
      ref={rowRef}
      data-note-list-row-id={dropData.rowId}
      sx={{
        opacity: isDragSource ? 0.35 : 1,
        ...sx,
      }}
    >
      {children}
    </Box>
  );
};

export const NoteList: React.FC<NoteListProps> = ({
  notes,
  currentNote,
  onNoteSelect,
  allowReselect,
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
  onDropFileNoteToNotes,
}) => {
  const isTestEnv = import.meta.env.MODE === 'test';
  const { t } = useTranslation();
  const listContentRef = useRef<HTMLDivElement>(null);
  const [nativePreview, setNativePreview] = useState<NativePreviewState | null>(
    null,
  );
  const [activeDrag, setActiveDrag] = useState<ActiveDragState | null>(null);

  const activeNotes = useMemo(
    () =>
      isFileMode ? notes : (notes as Note[]).filter((note) => !note.archived),
    [isFileMode, notes],
  );
  const archivedNotes = useMemo(
    () => (isFileMode ? [] : (notes as Note[]).filter((note) => note.archived)),
    [isFileMode, notes],
  );

  const activeFolders = useMemo(
    () => (isFileMode ? [] : folders.filter((folder) => !folder.archived)),
    [folders, isFileMode],
  );

  const isFolderMode = !isFileMode && activeFolders.length > 0;

  const normalizedTopLevelOrder = useMemo(() => {
    if (!isFolderMode) return [];
    const unfiledNoteMap = new Map(
      (activeNotes as Note[])
        .filter((note) => !note.folderId)
        .map((note) => [note.id, note]),
    );
    const folderMap = new Map(
      activeFolders.map((folder) => [folder.id, folder]),
    );
    const result: TopLevelItem[] = [];
    const seen = new Set<string>();

    for (const item of topLevelOrder) {
      const key = `${item.type}:${item.id}`;
      if (seen.has(key)) continue;
      if (item.type === 'folder' && folderMap.has(item.id)) {
        result.push(item);
        seen.add(key);
      }
      if (item.type === 'note' && unfiledNoteMap.has(item.id)) {
        result.push(item);
        seen.add(key);
      }
    }

    for (const folder of activeFolders) {
      const key = `folder:${folder.id}`;
      if (!seen.has(key)) {
        result.push({ type: 'folder', id: folder.id });
        seen.add(key);
      }
    }

    for (const note of activeNotes as Note[]) {
      if (note.folderId) continue;
      const key = `note:${note.id}`;
      if (!seen.has(key)) {
        result.push({ type: 'note', id: note.id });
        seen.add(key);
      }
    }

    return result;
  }, [activeFolders, activeNotes, isFolderMode, topLevelOrder]);

  const folderMap = useMemo(
    () => new Map(activeFolders.map((folder) => [folder.id, folder])),
    [activeFolders],
  );

  const folderNotesMap = useMemo(() => {
    const map = new Map<string, Note[]>();
    if (!isFolderMode) return map;
    for (const folder of activeFolders) {
      map.set(
        folder.id,
        (activeNotes as Note[]).filter((note) => note.folderId === folder.id),
      );
    }
    return map;
  }, [activeFolders, activeNotes, isFolderMode]);

  const noteMap = useMemo(
    () => new Map(activeNotes.map((note) => [note.id, note])),
    [activeNotes],
  );

  const rows = useMemo<DisplayRow[]>(() => {
    if (!isFolderMode) {
      const flatRows: DisplayRow[] = activeNotes.map((note) => ({
        kind: 'flat-note',
        rowId: `flat-note:${note.id}`,
        note,
      }));
      if (flatRows.length === 0) return flatRows;
      flatRows.push({ kind: 'flat-tail', rowId: 'flat-tail' });
      return flatRows;
    }

    const result: DisplayRow[] = [];
    normalizedTopLevelOrder.forEach((item, index) => {
      if (item.type === 'note') {
        const note = noteMap.get(item.id) as Note | undefined;
        if (!note) return;
        result.push({
          kind: 'top-note',
          rowId: `top-note:${note.id}`,
          note,
          topLevelIndex: index,
        });
        return;
      }

      const folder = folderMap.get(item.id);
      if (!folder) return;
      const notesInFolder = folderNotesMap.get(folder.id) ?? [];
      const isCollapsed = collapsedFolders.has(folder.id);

      result.push({
        kind: 'folder',
        rowId: `folder:${folder.id}`,
        folder,
        topLevelIndex: index,
        noteCount: notesInFolder.length,
        isCollapsed,
      });

      if (!isCollapsed) {
        notesInFolder.forEach((note, folderIndex) => {
          result.push({
            kind: 'folder-note',
            rowId: `folder-note:${note.id}`,
            note,
            folderId: folder.id,
            topLevelIndex: index,
            isLastInFolder: folderIndex === notesInFolder.length - 1,
          });
        });
        if (notesInFolder.length > 0) {
          result.push({
            kind: 'folder-tail',
            rowId: `folder-tail:${folder.id}`,
            folderId: folder.id,
            topLevelIndex: index,
          });
        }
      }
    });

    result.push({ kind: 'unfiled-bottom', rowId: 'unfiled-bottom' });
    return result;
  }, [
    activeNotes,
    collapsedFolders,
    folderMap,
    folderNotesMap,
    isFolderMode,
    normalizedTopLevelOrder,
    noteMap,
  ]);

  const handleNativePreviewChange = useCallback(
    (preview: NativePreviewState | null) => {
      setNativePreview(preview);
    },
    [],
  );

  const getLocalizedNoteTitle = useCallback(
    (note: Note | FileNote) => getNoteTitle(note, t),
    [t],
  );

  const renderNoteItem = useCallback(
    (note: Note | FileNote, isDraggingAny: boolean) => (
      <NoteItem
        note={note}
        currentNote={currentNote}
        onNoteSelect={onNoteSelect}
        allowReselect={allowReselect}
        onArchive={onArchive}
        onConvertToNote={onConvertToNote}
        onSaveFile={onSaveFile}
        getNoteTitle={getLocalizedNoteTitle}
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
      canSplit,
      currentNote,
      isFileMode,
      isFileModified,
      allowReselect,
      onArchive,
      onCloseFile,
      onConvertToNote,
      onNoteSelect,
      onOpenInPane,
      onSaveFile,
      platform,
      secondarySelectedNoteId,
      getLocalizedNoteTitle,
    ],
  );

  const resolveHoverState = useCallback(
    (
      currentLocation: {
        input: { clientX: number; clientY: number };
        dropTargets: Array<{
          element: Element;
          data: Record<string | symbol, unknown>;
        }>;
      },
      dragItem: DragData,
    ): HoverState | null => {
      const contentEl = listContentRef.current;
      if (!contentEl) return null;

      const matched = currentLocation.dropTargets.find(
        (target) =>
          contentEl.contains(target.element) && readDropData(target.data),
      );
      if (!matched) return null;
      const dropData = readDropData(matched.data);
      if (!dropData) return null;
      if (!canDropOnTarget(dragItem, dropData)) return null;

      if (dragItem.kind === 'note' && dropData.noteId === dragItem.noteId) {
        return null;
      }
      if (
        dragItem.kind === 'folder' &&
        dropData.folderId === dragItem.folderId &&
        dropData.kind === 'folder'
      ) {
        return null;
      }

      const rawEdge = extractClosestEdge(matched.data);
      const edge: Edge | null =
        dropData.kind === 'unfiled-bottom' || dropData.kind === 'flat-tail'
          ? 'top'
          : rawEdge;
      const boundaryIndented = computeBoundaryIndented(
        dropData,
        edge,
        currentLocation.input.clientX,
        matched.element,
      );
      const indicatorIndented = computeIndicatorIndented(
        dropData,
        edge,
        boundaryIndented,
      );
      const contentRect = contentEl.getBoundingClientRect();
      const rowRect = matched.element.getBoundingClientRect();
      const y = edge === 'bottom' ? rowRect.bottom : rowRect.top;

      return {
        target: dropData,
        edge,
        boundaryIndented,
        indicatorIndented,
        indicatorTop: y - contentRect.top,
      };
    },
    [],
  );

  const moveNoteIntoFolder = useCallback(
    async (
      noteId: string,
      targetFolderId: string,
      positionInFolder: number,
      sourceFolderId: string,
    ) => {
      const moved = moveNoteWithinActiveList(
        activeNotes as Note[],
        noteId,
        targetFolderId,
        positionInFolder,
      );
      if (!moved) return;
      onReorder?.([...moved.newActive, ...archivedNotes]);

      if (sourceFolderId !== targetFolderId) {
        onMoveNoteToFolder?.(noteId, targetFolderId);
      }

      const withoutTop = removeTopLevelNote(normalizedTopLevelOrder, noteId);
      if (!isSameTopLevelOrder(withoutTop, normalizedTopLevelOrder)) {
        onUpdateTopLevelOrder?.(withoutTop);
      }

      try {
        await UpdateNoteOrder(noteId, moved.insertIndex);
      } catch (error) {
        console.error('Failed to update note order:', error);
      }
    },
    [
      activeNotes,
      archivedNotes,
      normalizedTopLevelOrder,
      onMoveNoteToFolder,
      onReorder,
      onUpdateTopLevelOrder,
    ],
  );

  const moveNoteToTopLevel = useCallback(
    (noteId: string, insertIndex: number, sourceFolderId: string) => {
      const nextOrder = insertTopLevelNote(
        normalizedTopLevelOrder,
        noteId,
        insertIndex,
      );
      if (!isSameTopLevelOrder(nextOrder, normalizedTopLevelOrder)) {
        onUpdateTopLevelOrder?.(nextOrder);
      }
      if (sourceFolderId) {
        onMoveNoteToFolder?.(noteId, '');
      }
    },
    [normalizedTopLevelOrder, onMoveNoteToFolder, onUpdateTopLevelOrder],
  );

  const handleFolderModeDrop = useCallback(
    async (dragItem: DragData, hover: HoverState) => {
      if (dragItem.kind === 'folder') {
        if (
          hover.target.kind !== 'folder' &&
          hover.target.kind !== 'top-note' &&
          hover.target.kind !== 'unfiled-bottom'
        ) {
          return;
        }

        const baseOrder = normalizedTopLevelOrder;
        if (baseOrder.length === 0) return;

        let insertIndex = baseOrder.length;
        if (hover.target.kind !== 'unfiled-bottom') {
          const targetIndex = hover.target.topLevelIndex ?? -1;
          if (targetIndex === -1) return;
          const edge = isDropEdge(hover.edge) ? hover.edge : 'top';
          insertIndex = edge === 'bottom' ? targetIndex + 1 : targetIndex;
        }

        const nextOrder = moveTopLevelItem(
          baseOrder,
          'folder',
          dragItem.folderId,
          insertIndex,
        );
        if (!isSameTopLevelOrder(nextOrder, baseOrder)) {
          onUpdateTopLevelOrder?.(nextOrder);
        }
        return;
      }

      if (dragItem.source === 'file') {
        if (!onDropFileNoteToNotes || isFileMode) return;
        const folderModeNotes = activeNotes as Note[];

        switch (hover.target.kind) {
          case 'unfiled-bottom': {
            await onDropFileNoteToNotes(dragItem.noteId, {
              kind: 'top-level',
              topLevelInsertIndex: normalizedTopLevelOrder.length,
            });
            return;
          }
          case 'top-note': {
            const targetIndex = hover.target.topLevelIndex ?? -1;
            if (targetIndex === -1) return;
            const edge = isDropEdge(hover.edge) ? hover.edge : 'top';
            const insertIndex = edge === 'bottom' ? targetIndex + 1 : targetIndex;
            await onDropFileNoteToNotes(dragItem.noteId, {
              kind: 'top-level',
              topLevelInsertIndex: insertIndex,
            });
            return;
          }
          case 'folder': {
            const targetIndex = hover.target.topLevelIndex ?? -1;
            const targetFolderId = hover.target.folderId ?? '';
            if (targetIndex === -1 || !targetFolderId) return;
            const edge = isDropEdge(hover.edge) ? hover.edge : 'top';
            if (edge === 'top') {
              await onDropFileNoteToNotes(dragItem.noteId, {
                kind: 'top-level',
                topLevelInsertIndex: targetIndex,
              });
              return;
            }
            if (!hover.boundaryIndented) {
              await onDropFileNoteToNotes(dragItem.noteId, {
                kind: 'top-level',
                topLevelInsertIndex: targetIndex + 1,
              });
              return;
            }
            const targetFolderNotes = folderNotesMap.get(targetFolderId) ?? [];
            const positionInFolder = targetFolderNotes.length;
            await onDropFileNoteToNotes(dragItem.noteId, {
              kind: 'folder',
              folderId: targetFolderId,
              positionInFolder,
              destinationIndex: getInsertIndexForFolder(
                folderModeNotes,
                targetFolderId,
                positionInFolder,
              ),
            });
            return;
          }
          case 'folder-tail': {
            const targetFolderId = hover.target.folderId ?? '';
            const targetIndex = hover.target.topLevelIndex ?? -1;
            if (!targetFolderId || targetIndex === -1) return;
            if (!hover.boundaryIndented) {
              await onDropFileNoteToNotes(dragItem.noteId, {
                kind: 'top-level',
                topLevelInsertIndex: targetIndex + 1,
              });
              return;
            }
            const targetFolderNotes = folderNotesMap.get(targetFolderId) ?? [];
            const positionInFolder = targetFolderNotes.length;
            await onDropFileNoteToNotes(dragItem.noteId, {
              kind: 'folder',
              folderId: targetFolderId,
              positionInFolder,
              destinationIndex: getInsertIndexForFolder(
                folderModeNotes,
                targetFolderId,
                positionInFolder,
              ),
            });
            return;
          }
          case 'folder-note': {
            const targetFolderId = hover.target.folderId ?? '';
            const targetTopIndex = hover.target.topLevelIndex ?? -1;
            if (!targetFolderId || targetTopIndex === -1) return;
            const edge = isDropEdge(hover.edge) ? hover.edge : 'top';
            if (
              hover.target.isLastInFolder &&
              edge === 'bottom' &&
              !hover.boundaryIndented
            ) {
              await onDropFileNoteToNotes(dragItem.noteId, {
                kind: 'top-level',
                topLevelInsertIndex: targetTopIndex + 1,
              });
              return;
            }

            const targetFolderNotes = folderNotesMap.get(targetFolderId) ?? [];
            const overIndex = targetFolderNotes.findIndex(
              (value) => value.id === hover.target.noteId,
            );
            if (overIndex === -1) return;
            const positionInFolder = edge === 'bottom' ? overIndex + 1 : overIndex;
            await onDropFileNoteToNotes(dragItem.noteId, {
              kind: 'folder',
              folderId: targetFolderId,
              positionInFolder,
              destinationIndex: getInsertIndexForFolder(
                folderModeNotes,
                targetFolderId,
                positionInFolder,
              ),
            });
            return;
          }
          default:
            return;
        }
      }

      const note = (activeNotes as Note[]).find(
        (value) => value.id === dragItem.noteId,
      );
      if (!note) return;
      const sourceFolderId = note.folderId ?? '';

      switch (hover.target.kind) {
        case 'unfiled-bottom': {
          moveNoteToTopLevel(
            dragItem.noteId,
            normalizedTopLevelOrder.length,
            sourceFolderId,
          );
          return;
        }
        case 'top-note': {
          const targetIndex = hover.target.topLevelIndex ?? -1;
          if (targetIndex === -1) return;
          const edge = isDropEdge(hover.edge) ? hover.edge : 'top';
          const insertIndex = edge === 'bottom' ? targetIndex + 1 : targetIndex;
          moveNoteToTopLevel(dragItem.noteId, insertIndex, sourceFolderId);
          return;
        }
        case 'folder': {
          const targetIndex = hover.target.topLevelIndex ?? -1;
          const targetFolderId = hover.target.folderId ?? '';
          if (targetIndex === -1 || !targetFolderId) return;
          const edge = isDropEdge(hover.edge) ? hover.edge : 'top';
          if (edge === 'top') {
            moveNoteToTopLevel(dragItem.noteId, targetIndex, sourceFolderId);
            return;
          }
          if (!hover.boundaryIndented) {
            moveNoteToTopLevel(
              dragItem.noteId,
              targetIndex + 1,
              sourceFolderId,
            );
            return;
          }
          const targetFolderNotes = folderNotesMap.get(targetFolderId) ?? [];
          await moveNoteIntoFolder(
            dragItem.noteId,
            targetFolderId,
            targetFolderNotes.length,
            sourceFolderId,
          );
          return;
        }
        case 'folder-tail': {
          const targetFolderId = hover.target.folderId ?? '';
          const targetIndex = hover.target.topLevelIndex ?? -1;
          if (!targetFolderId || targetIndex === -1) return;
          if (!hover.boundaryIndented) {
            moveNoteToTopLevel(
              dragItem.noteId,
              targetIndex + 1,
              sourceFolderId,
            );
            return;
          }
          const targetFolderNotes = folderNotesMap.get(targetFolderId) ?? [];
          await moveNoteIntoFolder(
            dragItem.noteId,
            targetFolderId,
            targetFolderNotes.length,
            sourceFolderId,
          );
          return;
        }
        case 'folder-note': {
          const targetFolderId = hover.target.folderId ?? '';
          const targetTopIndex = hover.target.topLevelIndex ?? -1;
          if (!targetFolderId || targetTopIndex === -1) return;
          const edge = isDropEdge(hover.edge) ? hover.edge : 'top';
          if (
            hover.target.isLastInFolder &&
            edge === 'bottom' &&
            !hover.boundaryIndented
          ) {
            moveNoteToTopLevel(
              dragItem.noteId,
              targetTopIndex + 1,
              sourceFolderId,
            );
            return;
          }

          const targetFolderNotes = folderNotesMap.get(targetFolderId) ?? [];
          const overIndex = targetFolderNotes.findIndex(
            (value) => value.id === hover.target.noteId,
          );
          if (overIndex === -1) return;

          let insertPos = edge === 'bottom' ? overIndex + 1 : overIndex;
          if (sourceFolderId === targetFolderId) {
            const startIndex = targetFolderNotes.findIndex(
              (value) => value.id === dragItem.noteId,
            );
            if (startIndex !== -1) {
              insertPos = getReorderDestinationIndex({
                startIndex,
                indexOfTarget: overIndex,
                closestEdgeOfTarget: edge,
                axis: 'vertical',
              });
            }
          }

          await moveNoteIntoFolder(
            dragItem.noteId,
            targetFolderId,
            insertPos,
            sourceFolderId,
          );
          return;
        }
        default:
          return;
      }
    },
    [
      activeNotes,
      folderNotesMap,
      isFileMode,
      moveNoteIntoFolder,
      moveNoteToTopLevel,
      normalizedTopLevelOrder,
      onDropFileNoteToNotes,
      onUpdateTopLevelOrder,
    ],
  );

  const handleFlatModeDrop = useCallback(
    async (dragItem: DragData, hover: HoverState) => {
      if (dragItem.kind !== 'note') return;
      if (hover.target.kind !== 'flat-note' && hover.target.kind !== 'flat-tail')
        return;

      if (dragItem.source === 'file' && !isFileMode) {
        if (!onDropFileNoteToNotes) return;
        let destinationIndex = activeNotes.length;
        if (hover.target.kind === 'flat-note') {
          const edge = isDropEdge(hover.edge) ? hover.edge : 'top';
          const targetIndex = activeNotes.findIndex(
            (note) => note.id === hover.target.noteId,
          );
          if (targetIndex === -1) return;
          destinationIndex = edge === 'bottom' ? targetIndex + 1 : targetIndex;
        }
        await onDropFileNoteToNotes(dragItem.noteId, {
          kind: 'flat',
          destinationIndex,
        });
        return;
      }

      const sourceIndex = activeNotes.findIndex(
        (note) => note.id === dragItem.noteId,
      );
      if (sourceIndex === -1) return;

      let destinationIndex = sourceIndex;
      if (hover.target.kind === 'flat-tail') {
        destinationIndex = activeNotes.length - 1;
      } else {
        const edge = isDropEdge(hover.edge) ? hover.edge : 'top';
        const targetIndex = activeNotes.findIndex(
          (note) => note.id === hover.target.noteId,
        );
        if (targetIndex === -1) return;
        destinationIndex = getReorderDestinationIndex({
          startIndex: sourceIndex,
          indexOfTarget: targetIndex,
          closestEdgeOfTarget: edge,
          axis: 'vertical',
        });
      }
      if (destinationIndex === sourceIndex) return;

      if (isFileMode) {
        const reordered = reorder({
          list: activeNotes as FileNote[],
          startIndex: sourceIndex,
          finishIndex: destinationIndex,
        });
        onReorder?.(reordered);
        await SaveFileNotes(reordered);
        return;
      }

      const reorderedActive = reorder({
        list: activeNotes as Note[],
        startIndex: sourceIndex,
        finishIndex: destinationIndex,
      });
      onReorder?.([...reorderedActive, ...archivedNotes]);
      try {
        await UpdateNoteOrder(dragItem.noteId, destinationIndex);
      } catch (error) {
        console.error('Failed to update note order:', error);
      }
    },
    [activeNotes, archivedNotes, isFileMode, onDropFileNoteToNotes, onReorder],
  );

  useEffect(() => {
    if (isTestEnv) return;

    return monitorForElements({
      canMonitor: ({ source }) => readDragData(source.data) !== null,
      onDragStart: ({ source, location }) => {
        const dragItem = readDragData(source.data);
        if (!dragItem) return;
        const hover = resolveHoverState(location.current, dragItem);

        setActiveDrag({
          item: dragItem,
          pointer: {
            x: location.current.input.clientX,
            y: location.current.input.clientY,
          },
          hover,
        });
      },
      onDrag: ({ location }) => {
        setActiveDrag((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            pointer: {
              x: location.current.input.clientX,
              y: location.current.input.clientY,
            },
            hover: resolveHoverState(location.current, prev.item),
          };
        });
      },
      onDropTargetChange: ({ location }) => {
        setActiveDrag((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            pointer: {
              x: location.current.input.clientX,
              y: location.current.input.clientY,
            },
            hover: resolveHoverState(location.current, prev.item),
          };
        });
      },
      onDrop: ({ source, location }) => {
        const dragItem = readDragData(source.data);
        if (!dragItem) {
          setActiveDrag(null);
          setNativePreview(null);
          return;
        }

        const pane = detectTargetPane(
          location.current.input.clientX,
          location.current.input.clientY,
        );
        if (pane && dragItem.kind === 'note') {
          const note = activeNotes.find(
            (value) => value.id === dragItem.noteId,
          );
          if (note) {
            if (onOpenInPane) {
              onOpenInPane(note, pane);
            } else {
              void onNoteSelect(note);
            }
          }
          setActiveDrag(null);
          setNativePreview(null);
          return;
        }

        const hover = resolveHoverState(location.current, dragItem);
        if (!hover) {
          setActiveDrag(null);
          setNativePreview(null);
          return;
        }

        if (isFolderMode) {
          void handleFolderModeDrop(dragItem, hover);
        } else {
          void handleFlatModeDrop(dragItem, hover);
        }

        setActiveDrag(null);
        setNativePreview(null);
      },
    });
  }, [
    activeNotes,
    handleFlatModeDrop,
    handleFolderModeDrop,
    isFolderMode,
    onNoteSelect,
    onOpenInPane,
    resolveHoverState,
  ]);

  useEffect(() => {
    if (!activeDrag) return;
    const style = document.createElement('style');
    style.textContent = '* { cursor: grabbing !important; }';
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, [activeDrag]);

  const indicator = activeDrag?.hover;

  return (
    <List
      sx={{
        flexGrow: isFileMode ? 0 : 1,
        overflow: 'auto',
      }}
    >
      <Box ref={listContentRef} sx={{ position: 'relative', pb: 0.5 }}>
        {rows.map((row) => {
          if (row.kind === 'flat-note') {
            const isDraggingThis =
              activeDrag?.item.kind === 'note' &&
              activeDrag.item.noteId === row.note.id;
            const dropData: DropData = {
              kind: 'flat-note',
              rowId: row.rowId,
              noteId: row.note.id,
            };
            const dragData: DragData | undefined = {
              kind: 'note',
              noteId: row.note.id,
              source: isFileMode ? 'file' : 'note',
            };
            return (
              <PragmaticRow
                key={row.rowId}
                isTestEnv={isTestEnv}
                dropData={dropData}
                dragData={dragData}
                onNativePreviewChange={handleNativePreviewChange}
                isDragSource={isDraggingThis}
                sx={{ mx: 1 }}
              >
                {renderNoteItem(row.note, !!activeDrag)}
              </PragmaticRow>
            );
          }

          if (row.kind === 'flat-tail') {
            const shouldRender =
              isFileMode ||
              (activeDrag !== null && activeDrag.item.kind === 'note');
            if (!shouldRender) {
              return null;
            }
            const tailHeight = isFileMode ? 2 : 8;
            return (
              <PragmaticRow
                key={row.rowId}
                isTestEnv={isTestEnv}
                dropData={{ kind: 'flat-tail', rowId: row.rowId }}
                sx={{ mx: 1, minHeight: tailHeight }}
              >
                <Box sx={{ minHeight: tailHeight }} />
              </PragmaticRow>
            );
          }

          if (row.kind === 'top-note') {
            const isDraggingThis =
              activeDrag?.item.kind === 'note' &&
              activeDrag.item.noteId === row.note.id;
            const dropData: DropData = {
              kind: 'top-note',
              rowId: row.rowId,
              noteId: row.note.id,
              topLevelIndex: row.topLevelIndex,
            };
            const dragData: DragData | undefined = row.note.syncing
              ? undefined
              : {
                  kind: 'note',
                  noteId: row.note.id,
                  source: 'note',
                };
            return (
              <PragmaticRow
                key={row.rowId}
                isTestEnv={isTestEnv}
                dropData={dropData}
                dragData={dragData}
                onNativePreviewChange={handleNativePreviewChange}
                isDragSource={isDraggingThis}
                sx={{ mx: 1 }}
              >
                {renderNoteItem(row.note, !!activeDrag)}
              </PragmaticRow>
            );
          }

          if (row.kind === 'folder') {
            const isDraggingThis =
              activeDrag?.item.kind === 'folder' &&
              activeDrag.item.folderId === row.folder.id;
            const dropData: DropData = {
              kind: 'folder',
              rowId: row.rowId,
              folderId: row.folder.id,
              topLevelIndex: row.topLevelIndex,
            };
            const dragData: DragData = {
              kind: 'folder',
              folderId: row.folder.id,
            };
            return (
              <PragmaticRow
                key={row.rowId}
                isTestEnv={isTestEnv}
                dropData={dropData}
                dragData={dragData}
                onNativePreviewChange={handleNativePreviewChange}
                isDragSource={isDraggingThis}
                sx={{
                  mx: 1,
                  border: '1px solid',
                  borderColor: 'action.disabled',
                  borderRadius:
                    row.isCollapsed || row.noteCount === 0 || isDraggingThis
                      ? 1
                      : '4px 4px 0 0',
                  borderBottomWidth:
                    row.noteCount > 0 && !row.isCollapsed && !isDraggingThis
                      ? 0
                      : undefined,
                }}
              >
                <FolderHeader
                  folder={row.folder}
                  isCollapsed={row.isCollapsed || isDraggingThis}
                  onToggle={() => onToggleFolderCollapse?.(row.folder.id)}
                  onRename={(name) => onRenameFolder?.(row.folder.id, name)}
                  onDelete={() => onDeleteFolder?.(row.folder.id)}
                  onArchive={() => onArchiveFolder?.(row.folder.id)}
                  isEmpty={row.noteCount === 0}
                  noteCount={row.noteCount}
                  autoEdit={editingFolderId === row.folder.id}
                  onAutoEditDone={onEditingFolderDone}
                />
              </PragmaticRow>
            );
          }

          if (row.kind === 'folder-note') {
            const isDraggingThis =
              activeDrag?.item.kind === 'note' &&
              activeDrag.item.noteId === row.note.id;
            const dropData: DropData = {
              kind: 'folder-note',
              rowId: row.rowId,
              noteId: row.note.id,
              folderId: row.folderId,
              topLevelIndex: row.topLevelIndex,
              isLastInFolder: row.isLastInFolder,
            };
            const dragData: DragData | undefined = row.note.syncing
              ? undefined
              : {
                  kind: 'note',
                  noteId: row.note.id,
                  source: 'note',
                };
            return (
              <PragmaticRow
                key={row.rowId}
                isTestEnv={isTestEnv}
                dropData={dropData}
                dragData={dragData}
                onNativePreviewChange={handleNativePreviewChange}
                isDragSource={isDraggingThis}
                sx={{
                  mx: 1,
                  borderLeft: '1px solid',
                  borderRight: '1px solid',
                  borderColor: 'action.disabled',
                }}
              >
                <Box
                  sx={(theme) => ({
                    borderLeft: `${theme.spacing(1.5)} solid ${
                      theme.palette.mode === 'dark'
                        ? 'rgba(255,255,255,0.08)'
                        : 'rgba(0,0,0,0.06)'
                    }`,
                    backgroundColor:
                      theme.palette.mode === 'dark'
                        ? 'rgba(255,255,255,0.04)'
                        : 'rgba(0,0,0,0.06)',
                  })}
                >
                  {renderNoteItem(row.note, !!activeDrag)}
                </Box>
              </PragmaticRow>
            );
          }

          if (row.kind === 'folder-tail') {
            const dropData: DropData = {
              kind: 'folder-tail',
              rowId: row.rowId,
              folderId: row.folderId,
              topLevelIndex: row.topLevelIndex,
            };
            return (
              <PragmaticRow
                key={row.rowId}
                isTestEnv={isTestEnv}
                dropData={dropData}
                sx={{ mx: 1, minHeight: 8 }}
              >
                <Box
                  sx={(theme) => ({
                    height: 2,
                    borderLeft: '1px solid',
                    borderRight: '1px solid',
                    borderColor: 'action.disabled',
                    borderBottom: '1px solid',
                    borderBottomColor: 'action.disabled',
                    borderRadius: '0 0 4px 4px',
                    backgroundColor:
                      theme.palette.mode === 'dark'
                        ? 'rgba(255,255,255,0.02)'
                        : 'rgba(0,0,0,0.03)',
                  })}
                />
              </PragmaticRow>
            );
          }

          return (
            <PragmaticRow
              key={row.rowId}
              isTestEnv={isTestEnv}
              dropData={{ kind: 'unfiled-bottom', rowId: row.rowId }}
              sx={{ mx: 1, minHeight: 14 }}
            >
              <Box sx={{ minHeight: 14 }} />
            </PragmaticRow>
          );
        })}

        {indicator && (
          <Box
            sx={{
              position: 'absolute',
              top: indicator.indicatorTop,
              left:
                INDICATOR_INSET +
                (indicator.indicatorIndented ? INDENT_INDICATOR_OFFSET : 0),
              right: INDICATOR_INSET,
              height: 2,
              bgcolor: 'primary.main',
              zIndex: 2,
              pointerEvents: 'none',
            }}
          />
        )}
      </Box>

      {nativePreview &&
        createPortal(
          <Box
            sx={{
              px: 1.25,
              py: 0.75,
              borderRadius: 1,
              border: '1px solid',
              borderColor: 'divider',
              bgcolor: 'background.paper',
              boxShadow: 6,
              maxWidth: 360,
              width: Math.min(nativePreview.width, 360),
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: 'text.primary',
            }}
          >
            {nativePreview.item.kind === 'note'
              ? (() => {
                  const note = noteMap.get(nativePreview.item.noteId);
                  if (!note) return null;
                  return (
                    <Typography variant="body2" noWrap>
                      {getLocalizedNoteTitle(note).text}
                    </Typography>
                  );
                })()
              : (() => {
                  const folder = folderMap.get(nativePreview.item.folderId);
                  if (!folder) return null;
                  return (
                    <Typography variant="body2" noWrap>
                      {folder.name}
                    </Typography>
                  );
                })()}
          </Box>,
          nativePreview.container,
        )}
    </List>
  );
};
