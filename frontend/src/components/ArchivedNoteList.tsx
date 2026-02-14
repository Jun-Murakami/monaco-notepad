import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { pointerOutsideOfPreview } from '@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview';
import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview';
import {
  attachClosestEdge,
  type Edge,
  extractClosestEdge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { getReorderDestinationIndex } from '@atlaskit/pragmatic-drag-and-drop-hitbox/util/get-reorder-destination-index';
import {
  ArrowBack,
  ChevronRight,
  Close,
  DeleteForever,
  DeleteSweep,
  ExpandMore,
  Folder as FolderIcon,
  FolderOpen,
  Search,
  Unarchive,
} from '@mui/icons-material';
import {
  alpha,
  Box,
  Button,
  Divider,
  IconButton,
  InputAdornment,
  InputBase,
  List,
  ListItemButton,
  Tooltip,
  Typography,
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
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import SimpleBar from 'simplebar-react';
import { UpdateNoteOrder } from '../../wailsjs/go/backend/App';
import type { Folder, Note, TopLevelItem } from '../types';
import { ArchivedNoteContentDialog } from './ArchivedNoteContentDialog';
import { NotePreviewPopper } from './NotePreviewPopper';
import {
  insertTopLevelNote,
  isSameTopLevelOrder,
  moveNoteWithinActiveList,
  moveTopLevelItem,
  removeTopLevelNote,
} from './noteListShared';
import 'simplebar-react/dist/simplebar.min.css';

interface ArchivedNoteListProps {
  notes: Note[];
  folders: Folder[];
  archivedTopLevelOrder: TopLevelItem[];
  onUnarchive: (noteId: string) => void;
  onDelete: (noteId: string) => void;
  onDeleteAll: () => void;
  onClose: () => void;
  onUnarchiveFolder: (folderId: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onUpdateArchivedTopLevelOrder: (order: TopLevelItem[]) => void;
  onMoveNoteToFolder?: (noteID: string, folderID: string) => void;
  isDarkMode: boolean;
}

// 1) DnDメタ情報
const DRAG_ITEM_KEY = Symbol('archived-note-list-drag-item');
const DROP_TARGET_KEY = Symbol('archived-note-list-drop-target');

const FOLDER_BOUNDARY_INDENT_THRESHOLD = 96;
const INDENT_INDICATOR_OFFSET = 12;
const INDICATOR_INSET = 8;

export { insertTopLevelNote, moveTopLevelItem };

type DragData =
  | {
      kind: 'note';
      noteId: string;
    }
  | {
      kind: 'folder';
      folderId: string;
    };

type NativePreviewState = {
  item: DragData;
  container: HTMLElement;
  width: number;
};

type DropRowKind =
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

const readDragData = (
  data: Record<string | symbol, unknown>,
): DragData | null => {
  const value = data[DRAG_ITEM_KEY];
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<DragData>;
  if (candidate.kind === 'note' && typeof candidate.noteId === 'string') {
    return { kind: 'note', noteId: candidate.noteId };
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
  if (
    typeof candidate.kind !== 'string' ||
    typeof candidate.rowId !== 'string'
  ) {
    return null;
  }
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

  if (dropData.kind === 'top-note' || dropData.kind === 'folder-note') {
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

const getNoteTitle = (
  note: Note,
  t: (key: string) => string,
): { text: string; isFallback: boolean } => {
  if (note.title.trim()) return { text: note.title, isFallback: false };
  if (note.contentHeader) {
    return {
      text: note.contentHeader.replace(/\r\n|\n|\r/g, ' ').slice(0, 30),
      isFallback: true,
    };
  }
  return { text: t('notes.emptyNote'), isFallback: true };
};

interface ArchivedNoteItemProps {
  note: Note;
  indented: boolean;
  onUnarchive: (noteId: string) => void;
  onDelete: (noteId: string) => void;
  onSelect: (note: Note) => void;
  selected?: boolean;
  isDragging?: boolean;
  hideBottomBorder?: boolean;
}

const ArchivedNoteItem: React.FC<ArchivedNoteItemProps> = memo(
  ({
    note,
    indented,
    onUnarchive,
    onDelete,
    onSelect,
    selected,
    isDragging,
    hideBottomBorder,
  }) => {
    const { t } = useTranslation();
    const titleInfo = getNoteTitle(note, t);
    const actionButtonSx = { width: 28, height: 28 };

    return (
      <NotePreviewPopper
        content={note.content || note.contentHeader || undefined}
        modifiedTime={note.modifiedTime}
        disabled={isDragging}
      >
        <ListItemButton
          onClick={() => onSelect(note)}
          selected={!!selected}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            px: indented ? 3 : 2,
            py: 0.5,
            minHeight: 40,
            borderBottom: hideBottomBorder ? 0 : 1,
            borderColor: 'divider',
            '&:hover .archive-action': { opacity: 1 },
            ...(theme) =>
              theme.palette.mode === 'light'
                ? {
                    '&.Mui-selected': {
                      backgroundColor: alpha(theme.palette.primary.main, 0.22),
                    },
                    '&.Mui-selected:hover': {
                      backgroundColor: alpha(theme.palette.primary.main, 0.28),
                    },
                  }
                : {},
          }}
        >
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography
              noWrap
              variant="body2"
              sx={{
                fontSize: '0.875rem',
                fontStyle: titleInfo.isFallback ? 'italic' : 'normal',
                opacity: titleInfo.isFallback ? 0.6 : 1,
              }}
            >
              {titleInfo.text}
            </Typography>
          </Box>
          <Box
            sx={{ display: 'flex', gap: 1, flexShrink: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <Tooltip title={t('archived.restore')} arrow>
              <IconButton
                className="archive-action"
                onClick={() => onUnarchive(note.id)}
                color="primary"
                size="small"
                onPointerDown={(e) => e.stopPropagation()}
                sx={{
                  ...actionButtonSx,
                  opacity: 0,
                  transition: 'opacity 0.2s',
                  '&:hover': {
                    backgroundColor: 'primary.main',
                    color: 'primary.contrastText',
                  },
                }}
              >
                <Unarchive />
              </IconButton>
            </Tooltip>
            <Tooltip title={t('archived.delete')} arrow>
              <IconButton
                className="archive-action"
                onClick={() => onDelete(note.id)}
                color="error"
                size="small"
                onPointerDown={(e) => e.stopPropagation()}
                sx={{
                  ...actionButtonSx,
                  opacity: 0,
                  transition: 'opacity 0.2s',
                  '&:hover': {
                    backgroundColor: 'error.main',
                    color: 'error.contrastText',
                  },
                }}
              >
                <DeleteForever />
              </IconButton>
            </Tooltip>
          </Box>
        </ListItemButton>
      </NotePreviewPopper>
    );
  },
);

interface ArchivedFolderHeaderProps {
  folder: Folder;
  isCollapsed: boolean;
  noteCount: number;
  onToggle: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
}

const ArchivedFolderHeader: React.FC<ArchivedFolderHeaderProps> = ({
  folder,
  isCollapsed,
  noteCount,
  onToggle,
  onUnarchive,
  onDelete,
}) => {
  const { t } = useTranslation();

  return (
    <Box
      onClick={onToggle}
      sx={{
        height: 36,
        display: 'flex',
        alignItems: 'center',
        px: 1.5,
        backgroundColor: 'action.disabledBackground',
        borderRadius: isCollapsed ? '8px 8px 8px 8px' : '8px 8px 0 0',
        cursor: 'pointer',
        '&:hover .archive-action': { opacity: 1 },
      }}
    >
      <IconButton
        size="small"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        sx={{ p: 0.25, mr: 0.5 }}
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
          sx={{ width: 16, height: 16, color: 'text.secondary', mr: 0.75 }}
        />
      ) : (
        <FolderOpen
          sx={{ width: 16, height: 16, color: 'text.secondary', mr: 0.75 }}
        />
      )}
      <Typography
        variant="body2"
        color="text.secondary"
        noWrap
        sx={{ flex: 1, fontSize: '0.875rem' }}
      >
        {folder.name}
      </Typography>
      <Typography
        variant="caption"
        color="text.disabled"
        sx={{ mx: 1, fontSize: '0.75rem' }}
      >
        {noteCount}
      </Typography>
      <Box
        sx={{ display: 'flex', gap: 0.5 }}
        onClick={(e) => e.stopPropagation()}
      >
        <Tooltip title={t('archived.restoreFolder')} arrow>
          <IconButton
            className="archive-action"
            size="small"
            onClick={onUnarchive}
            onPointerDown={(e) => e.stopPropagation()}
            sx={{
              opacity: 0,
              transition: 'opacity 0.2s',
              p: 0.25,
              '&:hover': {
                backgroundColor: 'primary.main',
                color: 'primary.contrastText',
              },
            }}
          >
            <Unarchive sx={{ width: 16, height: 16 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title={t('archived.deleteFolder')} arrow>
          <IconButton
            className="archive-action"
            size="small"
            onClick={onDelete}
            onPointerDown={(e) => e.stopPropagation()}
            sx={{
              opacity: 0,
              transition: 'opacity 0.2s',
              p: 0.25,
              '&:hover': {
                backgroundColor: 'error.main',
                color: 'error.contrastText',
              },
            }}
          >
            <DeleteForever sx={{ width: 16, height: 16 }} />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
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
            dropData.kind === 'folder-tail' ? ['top'] : ['top', 'bottom'];
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
      data-archived-note-list-row-id={dropData.rowId}
      sx={{
        opacity: isDragSource ? 0.35 : 1,
        ...sx,
      }}
    >
      {children}
    </Box>
  );
};

export const ArchivedNoteList: React.FC<ArchivedNoteListProps> = ({
  notes,
  folders,
  archivedTopLevelOrder,
  onUnarchive,
  onDelete,
  onDeleteAll,
  onClose,
  onUnarchiveFolder,
  onDeleteFolder,
  onUpdateArchivedTopLevelOrder,
  onMoveNoteToFolder,
  isDarkMode,
}) => {
  const isTestEnv = import.meta.env.MODE === 'test';
  const { t } = useTranslation();
  const listContentRef = useRef<HTMLDivElement>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [nativePreview, setNativePreview] = useState<NativePreviewState | null>(
    null,
  );
  const [activeDrag, setActiveDrag] = useState<ActiveDragState | null>(null);

  const allArchivedNotes = useMemo(
    () => notes.filter((n) => n.archived),
    [notes],
  );
  const allArchivedFolders = useMemo(
    () => folders.filter((f) => f.archived),
    [folders],
  );

  const matchingNoteIds = useMemo(() => {
    if (!searchQuery) return null;
    const q = searchQuery.toLowerCase();
    const ids = new Set<string>();
    for (const note of allArchivedNotes) {
      if (
        note.title.toLowerCase().includes(q) ||
        (note.contentHeader?.toLowerCase().includes(q) ?? false) ||
        (note.content?.toLowerCase().includes(q) ?? false)
      ) {
        ids.add(note.id);
      }
    }
    return ids;
  }, [allArchivedNotes, searchQuery]);

  const archivedNotes = useMemo(() => {
    if (!matchingNoteIds) return allArchivedNotes;
    return allArchivedNotes.filter((n) => matchingNoteIds.has(n.id));
  }, [allArchivedNotes, matchingNoteIds]);

  const archivedFolders = useMemo(() => {
    if (!matchingNoteIds) return allArchivedFolders;
    const folderIdsWithMatch = new Set(
      archivedNotes.filter((n) => n.folderId).map((n) => n.folderId),
    );
    return allArchivedFolders.filter((f) => folderIdsWithMatch.has(f.id));
  }, [allArchivedFolders, matchingNoteIds, archivedNotes]);

  const hasArchivedItems =
    allArchivedNotes.length > 0 || allArchivedFolders.length > 0;
  const hasSearchResults =
    archivedNotes.length > 0 || archivedFolders.length > 0;

  const normalizedTopLevelOrder = useMemo(() => {
    const unfiledNoteMap = new Map(
      archivedNotes
        .filter((note) => !note.folderId)
        .map((note) => [note.id, note]),
    );
    const folderMap = new Map(
      archivedFolders.map((folder) => [folder.id, folder]),
    );
    const result: TopLevelItem[] = [];
    const seen = new Set<string>();

    for (const item of archivedTopLevelOrder) {
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

    for (const folder of archivedFolders) {
      const key = `folder:${folder.id}`;
      if (!seen.has(key)) {
        result.push({ type: 'folder', id: folder.id });
        seen.add(key);
      }
    }

    for (const note of archivedNotes) {
      if (note.folderId) continue;
      const key = `note:${note.id}`;
      if (!seen.has(key)) {
        result.push({ type: 'note', id: note.id });
        seen.add(key);
      }
    }

    return result;
  }, [archivedFolders, archivedNotes, archivedTopLevelOrder]);

  const folderMap = useMemo(
    () => new Map(archivedFolders.map((folder) => [folder.id, folder])),
    [archivedFolders],
  );

  const noteMap = useMemo(
    () => new Map(archivedNotes.map((note) => [note.id, note])),
    [archivedNotes],
  );

  const folderNoteMap = useMemo(() => {
    const archivedFolderIds = new Set(
      archivedFolders.map((folder) => folder.id),
    );
    const map = new Map<string, Note[]>();
    for (const note of archivedNotes) {
      if (!note.folderId || !archivedFolderIds.has(note.folderId)) continue;
      const existing = map.get(note.folderId) || [];
      existing.push(note);
      map.set(note.folderId, existing);
    }
    return map;
  }, [archivedFolders, archivedNotes]);

  const rows = useMemo<DisplayRow[]>(() => {
    const result: DisplayRow[] = [];

    normalizedTopLevelOrder.forEach((item, index) => {
      if (item.type === 'note') {
        const note = noteMap.get(item.id);
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
      const notesInFolder = folderNoteMap.get(folder.id) ?? [];
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
    collapsedFolders,
    folderMap,
    folderNoteMap,
    normalizedTopLevelOrder,
    noteMap,
  ]);

  const handleNativePreviewChange = useCallback(
    (preview: NativePreviewState | null) => {
      setNativePreview(preview);
    },
    [],
  );

  const toggleFolder = useCallback((folderId: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }, []);

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
      const matched = currentLocation.dropTargets.find((target) =>
        readDropData(target.data),
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
        dropData.kind === 'folder' &&
        dropData.folderId === dragItem.folderId
      ) {
        return null;
      }

      const rawEdge = extractClosestEdge(matched.data);
      const edge: Edge | null =
        dropData.kind === 'unfiled-bottom' ? 'top' : rawEdge;

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

      const contentEl = listContentRef.current;
      if (!contentEl) return null;
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
        archivedNotes,
        noteId,
        targetFolderId,
        positionInFolder,
      );
      if (!moved) return;

      if (sourceFolderId !== targetFolderId) {
        onMoveNoteToFolder?.(noteId, targetFolderId);
      }

      const withoutTop = removeTopLevelNote(normalizedTopLevelOrder, noteId);
      if (!isSameTopLevelOrder(withoutTop, normalizedTopLevelOrder)) {
        onUpdateArchivedTopLevelOrder(withoutTop);
      }

      try {
        await UpdateNoteOrder(noteId, moved.insertIndex);
      } catch (error) {
        console.error('Failed to update note order:', error);
      }
    },
    [
      archivedNotes,
      normalizedTopLevelOrder,
      onMoveNoteToFolder,
      onUpdateArchivedTopLevelOrder,
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
        onUpdateArchivedTopLevelOrder(nextOrder);
      }
      if (sourceFolderId) {
        onMoveNoteToFolder?.(noteId, '');
      }
    },
    [
      normalizedTopLevelOrder,
      onMoveNoteToFolder,
      onUpdateArchivedTopLevelOrder,
    ],
  );

  const handleDrop = useCallback(
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
          onUpdateArchivedTopLevelOrder(nextOrder);
        }
        return;
      }

      const note = archivedNotes.find((value) => value.id === dragItem.noteId);
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
          const targetFolderNotes = folderNoteMap.get(targetFolderId) ?? [];
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
          const targetFolderNotes = folderNoteMap.get(targetFolderId) ?? [];
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

          const targetFolderNotes = folderNoteMap.get(targetFolderId) ?? [];
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
      archivedNotes,
      folderNoteMap,
      moveNoteIntoFolder,
      moveNoteToTopLevel,
      normalizedTopLevelOrder,
      onUpdateArchivedTopLevelOrder,
    ],
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

        const hover = resolveHoverState(location.current, dragItem);
        if (!hover) {
          setActiveDrag(null);
          setNativePreview(null);
          return;
        }

        void handleDrop(dragItem, hover);
        setActiveDrag(null);
        setNativePreview(null);
      },
    });
  }, [handleDrop, resolveHoverState]);

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

  const getAllNotes = useCallback((): Note[] => {
    const allNotes: Note[] = [];
    for (const item of normalizedTopLevelOrder) {
      if (item.type === 'folder') {
        const notesInFolder = folderNoteMap.get(item.id) || [];
        allNotes.push(...notesInFolder);
      } else {
        const note = noteMap.get(item.id);
        if (note) allNotes.push(note);
      }
    }
    return allNotes;
  }, [folderNoteMap, normalizedTopLevelOrder, noteMap]);

  const getNextNote = useCallback(
    (currentNoteId: string): Note | null => {
      const allNotes = getAllNotes();
      const currentIndex = allNotes.findIndex((n) => n.id === currentNoteId);
      if (currentIndex === -1 || currentIndex === allNotes.length - 1) {
        return null;
      }
      return allNotes[currentIndex + 1];
    },
    [getAllNotes],
  );

  const getPreviousNote = useCallback(
    (currentNoteId: string): Note | null => {
      const allNotes = getAllNotes();
      const currentIndex = allNotes.findIndex((n) => n.id === currentNoteId);
      if (currentIndex <= 0) return null;
      return allNotes[currentIndex - 1];
    },
    [getAllNotes],
  );

  const handlePrevious = useCallback(() => {
    if (!selectedNote) return;
    const prevNote = getPreviousNote(selectedNote.id);
    if (prevNote) setSelectedNote(prevNote);
  }, [getPreviousNote, selectedNote]);

  const handleNext = useCallback(() => {
    if (!selectedNote) return;
    const nextNote = getNextNote(selectedNote.id);
    if (nextNote) setSelectedNote(nextNote);
  }, [getNextNote, selectedNote]);

  const handleRestoreWithNext = useCallback(
    (noteId: string) => {
      const nextNote = getNextNote(noteId);
      onUnarchive(noteId);
      setSelectedNote(nextNote);
    },
    [getNextNote, onUnarchive],
  );

  const handleDeleteWithNext = useCallback(
    (noteId: string) => {
      const nextNote = getNextNote(noteId);
      onDelete(noteId);
      setSelectedNote(nextNote);
    },
    [getNextNote, onDelete],
  );

  const handleSelectNote = useCallback((note: Note) => {
    setSelectedNote(note);
  }, []);

  if (!hasArchivedItems) {
    return (
      <Box
        sx={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'text.secondary',
        }}
      >
        <Typography variant="h6">{t('archived.none')}</Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        alignItems: 'flex-start',
        '& .simplebar-track.simplebar-vertical .simplebar-scrollbar:before': {
          backgroundColor: 'text.secondary',
        },
      }}
    >
      <Box
        sx={{
          width: '100%',
          maxWidth: 640,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          px: 2,
          py: 1,
        }}
      >
        <IconButton onClick={onClose} sx={{ ml: -1, width: 32, height: 32 }}>
          <ArrowBack />
        </IconButton>
        <Typography variant="subtitle1" fontWeight={600}>
          {t('archived.title')}
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        <InputBase
          inputRef={searchInputRef}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setSearchQuery('');
              searchInputRef.current?.blur();
            }
          }}
          placeholder={t('archived.searchPlaceholder')}
          size="small"
          sx={{
            maxWidth: 200,
            fontSize: '0.8rem',
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            '& .MuiInputBase-input': { py: 0.5, px: 0.5 },
          }}
          startAdornment={
            <InputAdornment position="start" sx={{ ml: 0.5, mr: 0 }}>
              <Search sx={{ fontSize: 16, color: 'text.secondary' }} />
            </InputAdornment>
          }
          endAdornment={
            searchQuery ? (
              <InputAdornment position="end" sx={{ mr: 0.25 }}>
                <IconButton
                  size="small"
                  onClick={() => {
                    setSearchQuery('');
                    searchInputRef.current?.focus();
                  }}
                  sx={{ p: 0.25 }}
                >
                  <Close sx={{ fontSize: 14 }} />
                </IconButton>
              </InputAdornment>
            ) : null
          }
        />
        <Tooltip title={t('archived.deleteAllTooltip')} arrow>
          <Button
            onClick={onDeleteAll}
            color="error"
            size="small"
            endIcon={<DeleteSweep sx={{ width: 20, height: 20 }} />}
            sx={{
              height: 32,
              '&:hover': {
                backgroundColor: 'error.main',
                color: 'error.contrastText',
              },
            }}
          >
            {t('archived.deleteAll')}
          </Button>
        </Tooltip>
      </Box>
      <Divider sx={{ width: '100%' }} />

      {searchQuery && !hasSearchResults ? (
        <Box
          sx={{
            width: '100%',
            display: 'flex',
            justifyContent: 'center',
            py: 6,
            color: 'text.secondary',
          }}
        >
          <Typography variant="body2">
            {t('archived.noResults', { query: searchQuery })}
          </Typography>
        </Box>
      ) : (
        <SimpleBar
          style={{ maxHeight: '100%', width: '100%', overflowX: 'hidden' }}
        >
          <Box
            sx={{
              width: '100%',
              display: 'flex',
              justifyContent: 'flex-start',
            }}
          >
            <List
              sx={{
                width: '100%',
                maxWidth: 640,
                overflow: 'auto',
                mb: 8,
                py: 0,
              }}
            >
              <Box
                ref={listContentRef}
                sx={{ position: 'relative', width: '100%' }}
              >
                {rows.map((row) => {
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
                    const dragData: DragData = {
                      kind: 'note',
                      noteId: row.note.id,
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
                        <ArchivedNoteItem
                          note={row.note}
                          indented={false}
                          onUnarchive={onUnarchive}
                          onDelete={onDelete}
                          onSelect={handleSelectNote}
                          selected={selectedNote?.id === row.note.id}
                          isDragging={!!activeDrag}
                        />
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
                            row.isCollapsed ||
                            row.noteCount === 0 ||
                            isDraggingThis
                              ? 1
                              : '8px 8px 0 0',
                          borderBottomWidth:
                            row.noteCount > 0 &&
                            !row.isCollapsed &&
                            !isDraggingThis
                              ? 0
                              : undefined,
                        }}
                      >
                        <ArchivedFolderHeader
                          folder={row.folder}
                          isCollapsed={row.isCollapsed || isDraggingThis}
                          noteCount={row.noteCount}
                          onToggle={() => toggleFolder(row.folder.id)}
                          onUnarchive={() => onUnarchiveFolder(row.folder.id)}
                          onDelete={() => onDeleteFolder(row.folder.id)}
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
                    const dragData: DragData = {
                      kind: 'note',
                      noteId: row.note.id,
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
                                ? 'rgba(255,255,255,0.04)'
                                : 'rgba(0,0,0,0.04)'
                            }`,
                            backgroundColor:
                              theme.palette.mode === 'dark'
                                ? 'rgba(255,255,255,0.04)'
                                : 'rgba(0,0,0,0.04)',
                          })}
                        >
                          <ArchivedNoteItem
                            note={row.note}
                            indented
                            onUnarchive={onUnarchive}
                            onDelete={onDelete}
                            onSelect={handleSelectNote}
                            selected={selectedNote?.id === row.note.id}
                            isDragging={!!activeDrag}
                            hideBottomBorder={row.isLastInFolder}
                          />
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
                            borderRadius: '0 0 8px 8px',
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
                        (indicator.indicatorIndented
                          ? INDENT_INDICATOR_OFFSET
                          : 0),
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
                              {getNoteTitle(note, t).text}
                            </Typography>
                          );
                        })()
                      : (() => {
                          const folder = folderMap.get(
                            nativePreview.item.folderId,
                          );
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
          </Box>
        </SimpleBar>
      )}

      <ArchivedNoteContentDialog
        open={selectedNote !== null}
        note={selectedNote}
        onClose={() => setSelectedNote(null)}
        onRestore={handleRestoreWithNext}
        onDelete={handleDeleteWithNext}
        isDarkMode={isDarkMode}
        onPrevious={handlePrevious}
        onNext={handleNext}
        hasPrevious={
          selectedNote ? getPreviousNote(selectedNote.id) !== null : false
        }
        hasNext={selectedNote ? getNextNote(selectedNote.id) !== null : false}
      />
    </Box>
  );
};
