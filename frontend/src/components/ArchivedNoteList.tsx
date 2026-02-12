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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SimpleBar from 'simplebar-react';
import { UpdateNoteOrder } from '../../wailsjs/go/backend/App';
import type { Folder, Note, TopLevelItem } from '../types';
import dayjs from '../utils/dayjs';
import { ArchivedNoteContentDialog } from './ArchivedNoteContentDialog';
import { NotePreviewPopper } from './NotePreviewPopper';
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
}> = memo(
  ({ id, children, dropIndicator, indentedIndicator, insetIndicator }) => {
    const { attributes, listeners, setNodeRef, isDragging } = useSortable({
      id,
    });
    const insetPx = insetIndicator ? 8 : 0;
    const indentPx = indentedIndicator ? 12 : 0;
    const leftPx = insetPx + indentPx;

    return (
      <Box
        ref={setNodeRef}
        style={{ opacity: isDragging ? 0.3 : 1 }}
        {...attributes}
        {...listeners}
        onPointerDown={(e) => {
          e.stopPropagation();
          (listeners?.onPointerDown as (e: React.PointerEvent) => void)?.(e);
        }}
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

const getNoteTitle = (note: Note): { text: string; isFallback: boolean } => {
  if (note.title.trim()) return { text: note.title, isFallback: false };
  if (note.contentHeader) {
    return {
      text: note.contentHeader.replace(/\r\n|\n|\r/g, ' ').slice(0, 30),
      isFallback: true,
    };
  }
  return { text: 'Empty Note', isFallback: true };
};

interface ArchivedNoteItemProps {
  note: Note;
  indented: boolean;
  onUnarchive: (noteId: string) => void;
  onDelete: (noteId: string) => void;
  onSelect: (note: Note) => void;
  isDragging?: boolean;
}

const ArchivedNoteItem: React.FC<ArchivedNoteItemProps> = memo(
  ({ note, indented, onUnarchive, onDelete, onSelect, isDragging }) => {
    const titleInfo = getNoteTitle(note);
    const actionButtonSx = { width: 28, height: 28 };
    return (
      <NotePreviewPopper
        content={note.content || note.contentHeader || undefined}
        disabled={isDragging}
      >
        <ListItemButton
          onClick={() => onSelect(note)}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            px: indented ? 3 : 2,
            py: 0.75,
            minHeight: 44,
            borderBottom: 1,
            borderColor: 'divider',
            '&:hover .archive-action': { opacity: 1 },
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
            <Typography
              variant="caption"
              sx={{ fontSize: '0.75rem' }}
              color="text.secondary"
            >
              {dayjs(note.modifiedTime).format('L HH:mm')}
            </Typography>
          </Box>
          <Box
            sx={{ display: 'flex', gap: 1, flexShrink: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <Tooltip title="Restore" arrow>
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
            <Tooltip title="Delete" arrow>
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
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
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
  const lastBoundaryIndented = useRef(false);
  const lastInsertAbove = useRef(false);
  const lastOverIdRef = useRef<string | null>(null);
  const overIdTimestampRef = useRef(0);
  const rafIdRef = useRef<number>(0);

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
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

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
  const archivedFolderIds = useMemo(
    () => new Set(archivedFolders.map((f) => f.id)),
    [archivedFolders],
  );

  const noteMap = useMemo(
    () => new Map(archivedNotes.map((n) => [n.id, n])),
    [archivedNotes],
  );
  const folderMap = useMemo(
    () => new Map(archivedFolders.map((f) => [f.id, f])),
    [archivedFolders],
  );

  const folderNoteMap = useMemo(() => {
    const map = new Map<string, Note[]>();
    for (const note of archivedNotes) {
      if (note.folderId && archivedFolderIds.has(note.folderId)) {
        const existing = map.get(note.folderId) || [];
        existing.push(note);
        map.set(note.folderId, existing);
      }
    }
    return map;
  }, [archivedNotes, archivedFolderIds]);

  const hasArchivedItems =
    allArchivedNotes.length > 0 || allArchivedFolders.length > 0;
  const hasSearchResults =
    archivedNotes.length > 0 || archivedFolders.length > 0;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

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

  const extractNoteId = useCallback((id: string): string | null => {
    if (id.startsWith('folder-note:')) return id.slice('folder-note:'.length);
    if (id.startsWith('note:')) return id.slice('note:'.length);
    return null;
  }, []);

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

  const precedingFolderIds = useMemo(() => {
    const map = new Map<string, string>();
    for (let i = 1; i < archivedTopLevelOrder.length; i++) {
      const prev = archivedTopLevelOrder[i - 1];
      if (prev.type === 'folder' && !collapsedFolders.has(prev.id)) {
        if ((folderNoteMap.get(prev.id) || []).length > 0) {
          map.set(toTopLevelId(archivedTopLevelOrder[i]), prev.id);
        }
      }
    }
    return map;
  }, [archivedTopLevelOrder, toTopLevelId, collapsedFolders, folderNoteMap]);

  const expandedFolderWithNotesIds = useMemo(() => {
    const set = new Set<string>();
    for (const item of archivedTopLevelOrder) {
      if (item.type === 'folder' && !collapsedFolders.has(item.id)) {
        if ((folderNoteMap.get(item.id) || []).length > 0) {
          set.add(toTopLevelId(item));
        }
      }
    }
    return set;
  }, [archivedTopLevelOrder, toTopLevelId, collapsedFolders, folderNoteMap]);

  const lastFolderNoteIds = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of archivedTopLevelOrder) {
      if (item.type === 'folder' && !collapsedFolders.has(item.id)) {
        const fNotes = folderNoteMap.get(item.id) || [];
        if (fNotes.length > 0) {
          map.set(`folder-note:${fNotes[fNotes.length - 1].id}`, item.id);
        }
      }
    }
    return map;
  }, [archivedTopLevelOrder, collapsedFolders, folderNoteMap]);

  const lastFolderNoteByFolderId = useMemo(() => {
    const map = new Map<string, string>();
    for (const [fnId, folderId] of lastFolderNoteIds) {
      map.set(folderId, fnId);
    }
    return map;
  }, [lastFolderNoteIds]);

  const flatItems = useMemo(() => {
    const items: string[] = [];
    for (const item of archivedTopLevelOrder) {
      if (item.type === 'note' && !noteMap.has(item.id)) continue;
      if (item.type === 'folder' && !folderMap.has(item.id)) continue;
      const itemId = toTopLevelId(item);
      items.push(itemId);
      if (item.type === 'folder' && !collapsedFolders.has(item.id)) {
        const fNotes = folderNoteMap.get(item.id) || [];
        for (const note of fNotes) {
          items.push(`folder-note:${note.id}`);
        }
      }
    }
    return items;
  }, [
    archivedTopLevelOrder,
    toTopLevelId,
    collapsedFolders,
    folderNoteMap,
    noteMap,
    folderMap,
  ]);

  const folderAwareCollision: CollisionDetection = useCallback((args) => {
    const activeId = args.active.id as string;
    const isDraggingFolder = activeId.startsWith('folder:');
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0 && !isDraggingFolder) {
      const preferred = pointerCollisions.find((c) => {
        const cId = c.id as string;
        return (
          cId.startsWith('folder-drop:') ||
          cId.startsWith('folder-note:') ||
          cId === 'unfiled-bottom'
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

  const isBoundaryTarget = useCallback(
    (id: string) => {
      if (id.startsWith('folder-drop:')) return true;
      if (lastFolderNoteIds.has(id)) return true;
      return precedingFolderIds.has(id) || expandedFolderWithNotesIds.has(id);
    },
    [precedingFolderIds, expandedFolderWithNotesIds, lastFolderNoteIds],
  );

  useEffect(() => {
    if (!activeDragId) return;
    const style = document.createElement('style');
    style.textContent = '* { cursor: grabbing !important; }';
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, [activeDragId]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  const handleDragOver = useCallback(
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

  const getTopLevelIndex = useCallback(
    (id: string): number => {
      const idx = archivedTopLevelOrder.findIndex(
        (item) => toTopLevelId(item) === id,
      );
      if (idx !== -1) return idx;
      if (id.startsWith('folder-note:')) {
        const noteId = id.slice('folder-note:'.length);
        const note = noteMap.get(noteId);
        if (note?.folderId) {
          return archivedTopLevelOrder.findIndex(
            (item) => item.type === 'folder' && item.id === note.folderId,
          );
        }
      }
      return -1;
    },
    [archivedTopLevelOrder, toTopLevelId, noteMap],
  );

  const handleDragEnd = useCallback(
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
          toggleFolder(parsed.id);
          return;
        }
      }

      if (!over) return;

      const activeId = active.id as string;
      const dropId = over.id as string;
      const isFolderNoteActive = activeId.startsWith('folder-note:');

      if (dropId.startsWith('folder-drop:')) {
        const targetFolderId = dropId.slice('folder-drop:'.length);
        const noteId = extractNoteId(activeId);
        if (noteId) {
          const draggedNote = noteMap.get(noteId);
          if (!draggedNote) return;

          if (!lastBoundaryIndented.current) {
            if (draggedNote.folderId) {
              onMoveNoteToFolder?.(noteId, '');
            }
            const folderSortId = `folder:${targetFolderId}`;
            const newOrder = archivedTopLevelOrder.filter(
              (item) => !(item.type === 'note' && item.id === noteId),
            );
            const folderIdx = newOrder.findIndex(
              (item) => toTopLevelId(item) === folderSortId,
            );
            newOrder.splice(folderIdx, 0, { type: 'note', id: noteId });
            onUpdateArchivedTopLevelOrder(newOrder);
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

      if (dropId === 'unfiled-bottom') {
        const noteId = extractNoteId(activeId);
        if (noteId) {
          const draggedNote = noteMap.get(noteId);
          if (draggedNote?.folderId) {
            onMoveNoteToFolder?.(noteId, '');
          }
        }
        return;
      }

      if (isFolderNoteActive && dropId.startsWith('folder-note:')) {
        const activeNoteId = activeId.slice('folder-note:'.length);
        const overNoteId = dropId.slice('folder-note:'.length);
        if (activeNoteId === overNoteId) return;

        const activeNote = noteMap.get(activeNoteId);
        const overNote = noteMap.get(overNoteId);
        if (!activeNote || !overNote) return;

        if (activeNote.folderId && activeNote.folderId === overNote.folderId) {
          const boundaryFolderIdSame = lastFolderNoteIds.get(dropId);
          if (boundaryFolderIdSame && !lastBoundaryIndented.current) {
            onMoveNoteToFolder?.(activeNoteId, '');
            const folderSortId = `folder:${boundaryFolderIdSame}`;
            const newOrder = [...archivedTopLevelOrder];
            const folderIdx = newOrder.findIndex(
              (item) => toTopLevelId(item) === folderSortId,
            );
            newOrder.splice(folderIdx + 1, 0, {
              type: 'note',
              id: activeNoteId,
            });
            onUpdateArchivedTopLevelOrder(newOrder);
            return;
          }

          const fNotes = folderNoteMap.get(activeNote.folderId) || [];
          const oldIndex = fNotes.findIndex((n) => n.id === activeNoteId);
          const overIndex = fNotes.findIndex((n) => n.id === overNoteId);
          const newIndex =
            lastInsertAbove.current && overIndex > oldIndex
              ? overIndex - 1
              : !lastInsertAbove.current && overIndex < oldIndex
                ? overIndex + 1
                : overIndex;

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
          const fNotes = folderNoteMap.get(targetFolderId) || [];
          const overPosInFolder = fNotes.findIndex((n) => n.id === overNoteId);
          const insertPos = lastInsertAbove.current
            ? overPosInFolder
            : overPosInFolder + 1;

          onMoveNoteToFolder?.(activeNoteId, targetFolderId);
          try {
            await UpdateNoteOrder(activeNoteId, insertPos);
          } catch (error) {
            console.error('Failed to update note order:', error);
          }
        }
        return;
      }

      if (dropId.startsWith('folder-note:')) {
        const noteId = extractNoteId(activeId);
        if (!noteId) return;
        const overNoteId = dropId.slice('folder-note:'.length);
        const overNote = noteMap.get(overNoteId);
        if (!overNote?.folderId) return;
        const draggedNote = noteMap.get(noteId);
        if (!draggedNote || draggedNote.folderId === overNote.folderId) return;

        const boundaryFolderId = lastFolderNoteIds.get(dropId);
        if (boundaryFolderId) {
          const folderSortId = `folder:${boundaryFolderId}`;
          const aIdx = getTopLevelIndex(activeId);
          const fIdx = archivedTopLevelOrder.findIndex(
            (item) => toTopLevelId(item) === folderSortId,
          );
          if (aIdx !== -1 && fIdx !== -1) {
            if (lastBoundaryIndented.current) {
              if ((draggedNote.folderId || '') !== boundaryFolderId) {
                const bFolderNotes = folderNoteMap.get(boundaryFolderId) || [];
                onMoveNoteToFolder?.(noteId, boundaryFolderId);
                try {
                  await UpdateNoteOrder(noteId, bFolderNotes.length);
                } catch (error) {
                  console.error('Failed to update note order:', error);
                }
              }
            } else {
              if (draggedNote.folderId) {
                onMoveNoteToFolder?.(noteId, '');
              }
              const newOrder = archivedTopLevelOrder.filter(
                (item) => toTopLevelId(item) !== activeId,
              );
              const newFolderIdx = newOrder.findIndex(
                (item) => toTopLevelId(item) === folderSortId,
              );
              newOrder.splice(newFolderIdx + 1, 0, {
                type: 'note',
                id: noteId,
              });
              onUpdateArchivedTopLevelOrder(newOrder);
            }
            return;
          }
        }

        const targetFolderId = overNote.folderId;
        const fNotes = folderNoteMap.get(targetFolderId) || [];
        const overPosInFolder = fNotes.findIndex((n) => n.id === overNoteId);
        const insertPos = lastInsertAbove.current
          ? overPosInFolder
          : overPosInFolder + 1;

        onMoveNoteToFolder?.(noteId, targetFolderId);
        try {
          await UpdateNoteOrder(noteId, insertPos);
        } catch (error) {
          console.error('Failed to update note order:', error);
        }
        return;
      }

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
          const overIdx = archivedTopLevelOrder.findIndex(
            (item) => toTopLevelId(item) === dropId,
          );
          if (activeIdx !== -1 && overIdx !== -1 && activeIdx < overIdx) {
            targetFolderIdForBoundary = dropId.slice('folder:'.length);
          }
        }

        if (targetFolderIdForBoundary) {
          const noteId = extractNoteId(activeId);
          if (noteId) {
            const draggedNote = noteMap.get(noteId);
            if (
              draggedNote &&
              (draggedNote.folderId || '') !== targetFolderIdForBoundary
            ) {
              const bFolderNotes =
                folderNoteMap.get(targetFolderIdForBoundary) || [];
              onMoveNoteToFolder?.(noteId, targetFolderIdForBoundary);
              try {
                await UpdateNoteOrder(noteId, bFolderNotes.length);
              } catch (error) {
                console.error('Failed to update note order:', error);
              }
            }
            return;
          }
        }
      }

      if (isFolderNoteActive) {
        const noteId = extractNoteId(activeId);
        if (!noteId) return;
        const draggedNote = noteMap.get(noteId);
        if (!draggedNote?.folderId) return;

        const parsedOver = parseTopLevelId(dropId);
        if (!parsedOver) return;

        const overIndex = archivedTopLevelOrder.findIndex(
          (item) => toTopLevelId(item) === dropId,
        );
        if (overIndex === -1) return;

        onMoveNoteToFolder?.(noteId, '');
        const newItem: TopLevelItem = { type: 'note', id: noteId };
        const newOrder = [...archivedTopLevelOrder];
        const insertIdx = lastInsertAbove.current ? overIndex : overIndex + 1;
        newOrder.splice(insertIdx, 0, newItem);
        onUpdateArchivedTopLevelOrder(newOrder);
        return;
      }

      if (activeId === dropId) return;

      const parsedActive = parseTopLevelId(activeId);
      const parsedOver = parseTopLevelId(dropId);
      if (!parsedActive || !parsedOver) return;

      const oldIndex = archivedTopLevelOrder.findIndex(
        (item) => toTopLevelId(item) === activeId,
      );
      const overIndex = archivedTopLevelOrder.findIndex(
        (item) => toTopLevelId(item) === dropId,
      );
      if (oldIndex === -1 || overIndex === -1) return;
      const newIndex =
        lastInsertAbove.current && overIndex > oldIndex
          ? overIndex - 1
          : !lastInsertAbove.current && overIndex < oldIndex
            ? overIndex + 1
            : overIndex;

      const newOrder = arrayMove(archivedTopLevelOrder, oldIndex, newIndex);
      onUpdateArchivedTopLevelOrder(newOrder);
    },
    [
      archivedTopLevelOrder,
      noteMap,
      folderNoteMap,
      onMoveNoteToFolder,
      onUpdateArchivedTopLevelOrder,
      parseTopLevelId,
      toTopLevelId,
      extractNoteId,
      getTopLevelIndex,
      precedingFolderIds,
      expandedFolderWithNotesIds,
      lastFolderNoteIds,
      toggleFolder,
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

  const getAllNotes = useCallback((): Note[] => {
    const allNotes: Note[] = [];
    for (const item of archivedTopLevelOrder) {
      if (item.type === 'folder') {
        const fNotes = folderNoteMap.get(item.id) || [];
        allNotes.push(...fNotes);
      } else {
        const note = noteMap.get(item.id);
        if (note) allNotes.push(note);
      }
    }
    return allNotes;
  }, [archivedTopLevelOrder, folderNoteMap, noteMap]);

  const getNextNote = useCallback(
    (currentNoteId: string): Note | null => {
      const allNotes = getAllNotes();
      const currentIndex = allNotes.findIndex((n) => n.id === currentNoteId);
      if (currentIndex === -1 || currentIndex === allNotes.length - 1)
        return null;
      return allNotes[currentIndex + 1];
    },
    [getAllNotes],
  );

  const getPreviousNote = useCallback(
    (currentNoteId: string): Note | null => {
      const allNotes = getAllNotes();
      const currentIndex = allNotes.findIndex((n) => n.id === currentNoteId);
      if (currentIndex === -1 || currentIndex === 0) return null;
      return allNotes[currentIndex - 1];
    },
    [getAllNotes],
  );

  const handlePrevious = useCallback(() => {
    if (selectedNote) {
      const prevNote = getPreviousNote(selectedNote.id);
      if (prevNote) setSelectedNote(prevNote);
    }
  }, [selectedNote, getPreviousNote]);

  const handleNext = useCallback(() => {
    if (selectedNote) {
      const nextNote = getNextNote(selectedNote.id);
      if (nextNote) setSelectedNote(nextNote);
    }
  }, [selectedNote, getNextNote]);

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

  const renderFolderHeader = (folder: Folder) => {
    const isCollapsed = collapsedFolders.has(folder.id);
    const fNotes = folderNoteMap.get(folder.id) || [];
    return (
      <Box
        onClick={() => toggleFolder(folder.id)}
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
            toggleFolder(folder.id);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          sx={{ p: 0.25, mr: 0.5 }}
        >
          {isCollapsed ? (
            <ChevronRight
              sx={{ width: 16, height: 16, color: 'text.secondary' }}
            />
          ) : (
            <ExpandMore
              sx={{ width: 16, height: 16, color: 'text.secondary' }}
            />
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
          {fNotes.length}
        </Typography>
        <Box
          sx={{ display: 'flex', gap: 0.5 }}
          onClick={(e) => e.stopPropagation()}
        >
          <Tooltip title="Restore folder" arrow>
            <IconButton
              className="archive-action"
              size="small"
              onClick={() => onUnarchiveFolder(folder.id)}
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
          <Tooltip title="Delete folder" arrow>
            <IconButton
              className="archive-action"
              size="small"
              onClick={() => onDeleteFolder(folder.id)}
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
        <Typography variant="h6">No archived notes</Typography>
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
          Archived notes
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
          placeholder="Search..."
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
        <Tooltip title="Delete all archived notes" arrow>
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
            Delete all
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
            No results for "{searchQuery}"
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
              ref={listRef}
              sx={{
                width: '100%',
                maxWidth: 640,
                overflow: 'auto',
                mb: 8,
                py: 0,
              }}
            >
              <DndContext
                sensors={sensors}
                collisionDetection={folderAwareCollision}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
                modifiers={[restrictToVerticalAxis]}
              >
                <SortableContext
                  items={flatItems}
                  strategy={verticalListSortingStrategy}
                >
                  {flatItems.map((id) => {
                    const indicator = getDropIndicator(id);
                    const isAtBoundary =
                      boundaryIndented &&
                      ((indicator === 'top' && precedingFolderIds.has(id)) ||
                        (indicator === 'bottom' && lastFolderNoteIds.has(id)));

                    if (id.startsWith('folder-note:')) {
                      const noteId = id.slice('folder-note:'.length);
                      const note = noteMap.get(noteId);
                      if (!note) return null;
                      const isLastBoundary =
                        indicator === 'bottom' && lastFolderNoteIds.has(id);
                      return (
                        <SortableWrapper
                          key={id}
                          id={id}
                          dropIndicator={indicator}
                          indentedIndicator={
                            isLastBoundary ? boundaryIndented : true
                          }
                          insetIndicator
                        >
                          <Box
                            sx={(theme) => ({
                              mx: 1,
                              borderLeft: `${theme.spacing(1.5)} solid ${theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)'}`,
                              backgroundColor:
                                theme.palette.mode === 'dark'
                                  ? 'rgba(255,255,255,0.04)'
                                  : 'rgba(0,0,0,0.04)',
                            })}
                          >
                            <ArchivedNoteItem
                              note={note}
                              indented
                              onUnarchive={onUnarchive}
                              onDelete={onDelete}
                              onSelect={handleSelectNote}
                              isDragging={!!activeDragId}
                            />
                          </Box>
                        </SortableWrapper>
                      );
                    }

                    const parsed = parseTopLevelId(id);

                    if (parsed?.type === 'note') {
                      const note = noteMap.get(parsed.id);
                      if (!note) return null;
                      return (
                        <SortableWrapper
                          key={id}
                          id={id}
                          dropIndicator={indicator}
                          indentedIndicator={isAtBoundary}
                          insetIndicator
                        >
                          <Box sx={{ mx: 1 }}>
                            <ArchivedNoteItem
                              note={note}
                              indented={false}
                              onUnarchive={onUnarchive}
                              onDelete={onDelete}
                              onSelect={handleSelectNote}
                              isDragging={!!activeDragId}
                            />
                          </Box>
                        </SortableWrapper>
                      );
                    }

                    if (parsed?.type === 'folder') {
                      const folder = folderMap.get(parsed.id);
                      if (!folder) return null;
                      return (
                        <SortableWrapper
                          key={id}
                          id={id}
                          dropIndicator={indicator}
                          indentedIndicator={isAtBoundary}
                          insetIndicator
                        >
                          <Box sx={{ mx: 1 }}>
                            <DroppableZone id={`folder-drop:${folder.id}`}>
                              {renderFolderHeader(folder)}
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

                    return null;
                  })}
                </SortableContext>

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
                        if (note) {
                          const titleInfo = getNoteTitle(note);
                          return (
                            <Box
                              sx={{
                                backgroundColor: 'background.paper',
                                boxShadow: 3,
                                px: 2,
                                py: 1,
                                opacity: 0.7,
                              }}
                            >
                              <Typography
                                noWrap
                                variant="body2"
                                sx={{
                                  fontStyle: titleInfo.isFallback
                                    ? 'italic'
                                    : 'normal',
                                  opacity: titleInfo.isFallback ? 0.6 : 1,
                                }}
                              >
                                {titleInfo.text}
                              </Typography>
                            </Box>
                          );
                        }
                      }
                      const parsed = parseTopLevelId(activeDragId);
                      if (parsed?.type === 'note') {
                        const note = noteMap.get(parsed.id);
                        if (note) {
                          const titleInfo = getNoteTitle(note);
                          return (
                            <Box
                              sx={{
                                backgroundColor: 'background.paper',
                                boxShadow: 3,
                                px: 2,
                                py: 1,
                                opacity: 0.7,
                              }}
                            >
                              <Typography
                                noWrap
                                variant="body2"
                                sx={{
                                  fontStyle: titleInfo.isFallback
                                    ? 'italic'
                                    : 'normal',
                                  opacity: titleInfo.isFallback ? 0.6 : 1,
                                }}
                              >
                                {titleInfo.text}
                              </Typography>
                            </Box>
                          );
                        }
                      }
                      if (parsed?.type === 'folder') {
                        const folder = folderMap.get(parsed.id);
                        if (folder) {
                          return (
                            <Box
                              sx={{
                                backgroundColor: 'action.disabledBackground',
                                boxShadow: 3,
                                px: 2,
                                py: 0.5,
                                opacity: 0.7,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 1,
                              }}
                            >
                              <FolderIcon
                                sx={{
                                  width: 18,
                                  height: 18,
                                  color: 'text.secondary',
                                }}
                              />
                              <Typography
                                variant="body2"
                                color="text.secondary"
                              >
                                {folder.name}
                              </Typography>
                            </Box>
                          );
                        }
                      }
                      return null;
                    })()}
                </DragOverlay>
              </DndContext>
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
