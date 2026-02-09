import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
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
  ArrowBack,
  ChevronRight,
  DeleteForever,
  DeleteSweep,
  ExpandMore,
  Folder as FolderIcon,
  FolderOpen,
  Unarchive,
} from '@mui/icons-material';
import {
  Box,
  Button,
  Divider,
  IconButton,
  List,
  ListItemButton,
  Tooltip,
  Typography,
} from '@mui/material';
import { useCallback, useMemo, useState } from 'react';
import type { Folder, Note, TopLevelItem } from '../types';
import dayjs from '../utils/dayjs';
import { ArchivedNoteContentDialog } from './ArchivedNoteContentDialog';
import SimpleBar from 'simplebar-react';
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
  isDarkMode: boolean;
}

const SortableItem: React.FC<{
  id: string;
  children: React.ReactNode;
}> = ({ id, children }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <Box
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.3 : 1, transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onPointerDown={(e) => {
        e.stopPropagation();
        (listeners?.onPointerDown as (e: React.PointerEvent) => void)?.(e);
      }}
    >
      {children}
    </Box>
  );
};

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
  isDarkMode,
}) => {
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const archivedNotes = useMemo(() => notes.filter((n) => n.archived), [notes]);
  const archivedFolders = useMemo(() => folders.filter((f) => f.archived), [folders]);
  const archivedFolderIds = useMemo(() => new Set(archivedFolders.map((f) => f.id)), [archivedFolders]);

  const noteMap = useMemo(() => new Map(archivedNotes.map((n) => [n.id, n])), [archivedNotes]);
  const folderMap = useMemo(() => new Map(archivedFolders.map((f) => [f.id, f])), [archivedFolders]);

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

  const hasArchivedItems = archivedNotes.length > 0 || archivedFolders.length > 0;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const flatItems = useMemo(() => {
    const items: string[] = [];
    for (const item of archivedTopLevelOrder) {
      const itemId = `${item.type}:${item.id}`;
      items.push(itemId);
      if (item.type === 'folder' && !collapsedFolders.has(item.id) && activeDragId !== itemId) {
        const folderNotes = folderNoteMap.get(item.id) || [];
        for (const note of folderNotes) {
          items.push(`folder-note:${note.id}`);
        }
      }
    }
    return items;
  }, [archivedTopLevelOrder, collapsedFolders, activeDragId, folderNoteMap]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      const isFolderNoteActive = activeId.startsWith('folder-note:');
      const isFolderNoteOver = overId.startsWith('folder-note:');

      if (isFolderNoteActive && isFolderNoteOver) {
        return;
      }

      const parseId = (id: string): TopLevelItem | null => {
        if (id.startsWith('folder-note:')) return null;
        const idx = id.indexOf(':');
        if (idx === -1) return null;
        return { type: id.slice(0, idx) as 'note' | 'folder', id: id.slice(idx + 1) };
      };

      const parsedActive = parseId(activeId);
      const parsedOver = parseId(overId);
      if (!parsedActive || !parsedOver) return;

      const oldIndex = archivedTopLevelOrder.findIndex(
        (item) => item.type === parsedActive.type && item.id === parsedActive.id,
      );
      const newIndex = archivedTopLevelOrder.findIndex(
        (item) => item.type === parsedOver.type && item.id === parsedOver.id,
      );
      if (oldIndex === -1 || newIndex === -1) return;

      const newOrder = arrayMove(archivedTopLevelOrder, oldIndex, newIndex);
      onUpdateArchivedTopLevelOrder(newOrder);
    },
    [archivedTopLevelOrder, onUpdateArchivedTopLevelOrder],
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

  const actionButtonSx = { width: 28, height: 28 };

  const renderNoteItem = (note: Note, indented: boolean) => {
    const titleInfo = getNoteTitle(note);
    return (
      <ListItemButton
        onClick={() => setSelectedNote(note)}
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
            variant='body2'
            sx={{
              fontSize: '0.875rem',
              fontStyle: titleInfo.isFallback ? 'italic' : 'normal',
              opacity: titleInfo.isFallback ? 0.6 : 1,
            }}
          >
            {titleInfo.text}
          </Typography>
          <Typography variant='caption' sx={{ fontSize: '0.75rem' }} color='text.secondary'>
            {dayjs(note.modifiedTime).format('L HH:mm')}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
          <Tooltip title='Restore' arrow>
            <IconButton
              className='archive-action'
              onClick={() => onUnarchive(note.id)}
              color='primary'
              size='small'
              sx={{ ...actionButtonSx, opacity: 0, transition: 'opacity 0.2s', '&:hover': { backgroundColor: 'primary.main', color: 'primary.contrastText' } }}
            >
              <Unarchive />
            </IconButton>
          </Tooltip>
          <Tooltip title='Delete' arrow>
            <IconButton
              className='archive-action'
              onClick={() => onDelete(note.id)}
              color='error'
              size='small'
              sx={{ ...actionButtonSx, opacity: 0, transition: 'opacity 0.2s', '&:hover': { backgroundColor: 'error.main', color: 'error.contrastText' } }}
            >
              <DeleteForever />
            </IconButton>
          </Tooltip>
        </Box>
      </ListItemButton>
    );
  };

  const renderFolderHeader = (folder: Folder) => {
    const isCollapsed = collapsedFolders.has(folder.id);
    const folderNotes = folderNoteMap.get(folder.id) || [];
    return (
      <Box
        onClick={() => toggleFolder(folder.id)}
        sx={{
          height: 36,
          display: 'flex',
          alignItems: 'center',
          px: 1.5,
          backgroundColor: 'action.disabledBackground',
          cursor: 'pointer',
          borderBottom: 1,
          borderColor: 'divider',
          '&:hover .archive-action': { opacity: 1 },
        }}
      >
        <IconButton size='small' onClick={(e) => { e.stopPropagation(); toggleFolder(folder.id); }} sx={{ p: 0.25, mr: 0.5 }}>
          {isCollapsed ? (
            <ChevronRight sx={{ width: 16, height: 16, color: 'text.secondary' }} />
          ) : (
            <ExpandMore sx={{ width: 16, height: 16, color: 'text.secondary' }} />
          )}
        </IconButton>
        {isCollapsed ? (
          <FolderIcon sx={{ width: 16, height: 16, color: 'text.secondary', mr: 0.75 }} />
        ) : (
          <FolderOpen sx={{ width: 16, height: 16, color: 'text.secondary', mr: 0.75 }} />
        )}
        <Typography variant='body2' color='text.secondary' noWrap sx={{ flex: 1, fontSize: '0.875rem' }}>
          {folder.name}
        </Typography>
        <Typography variant='caption' color='text.disabled' sx={{ mx: 1, fontSize: '0.75rem' }}>
          {folderNotes.length}
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.5 }} onClick={(e) => e.stopPropagation()}>
          <Tooltip title='Restore folder' arrow>
            <IconButton
              className='archive-action'
              size='small'
              onClick={() => onUnarchiveFolder(folder.id)}
              sx={{ opacity: 0, transition: 'opacity 0.2s', p: 0.25, '&:hover': { backgroundColor: 'primary.main', color: 'primary.contrastText' } }}
            >
              <Unarchive sx={{ width: 16, height: 16 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title='Delete folder' arrow>
            <IconButton
              className='archive-action'
              size='small'
              onClick={() => onDeleteFolder(folder.id)}
              sx={{ opacity: 0, transition: 'opacity 0.2s', p: 0.25, '&:hover': { backgroundColor: 'error.main', color: 'error.contrastText' } }}
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
      <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.secondary' }}>
        <Typography variant='h6'>No archived notes</Typography>
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
        alignItems: 'center',
        '& .simplebar-track.simplebar-vertical .simplebar-scrollbar:before': {
          backgroundColor: 'text.secondary',
        },
      }}
    >
      <Box sx={{ width: '100%', maxWidth: 900, display: 'flex', alignItems: 'center', gap: 2, px: 2, py: 1.5 }}>
        <IconButton onClick={onClose} sx={{ ml: -1, width: 32, height: 32 }}>
          <ArrowBack />
        </IconButton>
        <Typography variant='subtitle1' fontWeight={600}>Archived notes</Typography>
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title='Delete all archived notes' arrow>
          <Button
            onClick={onDeleteAll}
            color='error'
            size='small'
            endIcon={<DeleteSweep sx={{ width: 20, height: 20 }} />}
            sx={{
              height: 32,
              '&:hover': { backgroundColor: 'error.main', color: 'error.contrastText' },
            }}
          >
            Delete all
          </Button>
        </Tooltip>
      </Box>
      <Divider sx={{ width: '100%' }} />
      <SimpleBar style={{ maxHeight: '100%', width: '100%', overflowX: 'hidden' }}>
        <Box sx={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
          <List sx={{ width: '100%', maxWidth: 900, overflow: 'auto', mb: 8, py: 0 }}>
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            modifiers={[restrictToVerticalAxis]}
          >
            <SortableContext items={flatItems} strategy={verticalListSortingStrategy}>
              {flatItems.map((id) => {
                if (id.startsWith('folder-note:')) {
                  const noteId = id.slice('folder-note:'.length);
                  const note = noteMap.get(noteId);
                  if (!note) return null;
                  return (
                    <SortableItem key={id} id={id}>
                      <Box
                        sx={(theme) => ({
                          borderLeft: `${theme.spacing(1.5)} solid ${theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)'}`,
                          backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
                        })}
                      >
                        {renderNoteItem(note, true)}
                      </Box>
                    </SortableItem>
                  );
                }

                const idx = id.indexOf(':');
                if (idx === -1) return null;
                const type = id.slice(0, idx);
                const itemId = id.slice(idx + 1);

                if (type === 'note') {
                  const note = noteMap.get(itemId);
                  if (!note) return null;
                  return (
                    <SortableItem key={id} id={id}>
                      {renderNoteItem(note, false)}
                    </SortableItem>
                  );
                }

                if (type === 'folder') {
                  const folder = folderMap.get(itemId);
                  if (!folder) return null;
                  return (
                    <SortableItem key={id} id={id}>
                      {renderFolderHeader(folder)}
                    </SortableItem>
                  );
                }

                return null;
              })}
            </SortableContext>

            <DragOverlay dropAnimation={null}>
              {activeDragId
                ? (() => {
                    const idx = activeDragId.indexOf(':');
                    if (idx === -1) return null;
                    const type = activeDragId.slice(0, idx);
                    const itemId = activeDragId.slice(idx + 1);
                    if (type === 'note' || type === 'folder-note') {
                      const note = noteMap.get(itemId);
                      if (note) {
                        const titleInfo = getNoteTitle(note);
                        return (
                          <Box sx={{ backgroundColor: 'background.paper', boxShadow: 3, px: 2, py: 1 }}>
                            <Typography noWrap variant='body2' sx={{ fontStyle: titleInfo.isFallback ? 'italic' : 'normal', opacity: titleInfo.isFallback ? 0.6 : 1 }}>
                              {titleInfo.text}
                            </Typography>
                          </Box>
                        );
                      }
                    }
                    if (type === 'folder') {
                      const folder = folderMap.get(itemId);
                      if (folder) {
                        return (
                          <Box sx={{ backgroundColor: 'action.disabledBackground', boxShadow: 3, px: 2, py: 0.5, display: 'flex', alignItems: 'center', gap: 1 }}>
                            <FolderIcon sx={{ width: 18, height: 18, color: 'text.secondary' }} />
                            <Typography variant='body2' color='text.secondary'>{folder.name}</Typography>
                          </Box>
                        );
                      }
                    }
                    return null;
                  })()
                 : null}
            </DragOverlay>
          </DndContext>
        </List>
        </Box>
      </SimpleBar>

      <ArchivedNoteContentDialog
        open={selectedNote !== null}
        note={selectedNote}
        onClose={() => setSelectedNote(null)}
        onRestore={onUnarchive}
        onDelete={onDelete}
        isDarkMode={isDarkMode}
      />
    </Box>
  );
};
