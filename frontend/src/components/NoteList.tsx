import { Box, IconButton, List, ListItemButton, Typography, Button, Tooltip } from '@mui/material';
import { Archive, Inventory, DragHandle, ImportExport } from '@mui/icons-material';
import { UpdateNoteOrder } from '../../wailsjs/go/main/App';
import { Note } from '../types';
import dayjs from 'dayjs';
import 'dayjs/locale/ja';
import 'dayjs/locale/en';
import localizedFormat from 'dayjs/plugin/localizedFormat';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import SimpleBar from 'simplebar-react';
import 'simplebar-react/dist/simplebar.min.css';

// プラグインを追加
dayjs.extend(localizedFormat);

// ブラウザのロケールに基づいてdayjsのロケールを設定
const userLocale = navigator.language.toLowerCase().split('-')[0];
dayjs.locale(userLocale);

interface NoteListProps {
  notes: Note[];
  currentNote: Note | null;
  onNoteSelect: (note: Note) => Promise<void>;
  onArchive: (noteId: string) => Promise<void>;
  onShowArchived: () => void;
  onReorder?: (notes: Note[]) => void;
}

interface SortableNoteItemProps {
  note: Note;
  currentNote: Note | null;
  onNoteSelect: (note: Note) => Promise<void>;
  onArchive: (noteId: string) => Promise<void>;
  getNoteTitle: (note: Note) => string;
}

const SortableNoteItem: React.FC<SortableNoteItemProps> = ({ note, currentNote, onNoteSelect, onArchive, getNoteTitle }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: note.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <Box
      ref={setNodeRef}
      style={style}
      sx={{
        position: 'relative',
        '&:hover .drag-handle, &:hover .archive-button': { opacity: 1 },
      }}
    >
      <ListItemButton
        selected={currentNote?.id === note.id}
        onClick={async () => {
          if (currentNote?.id !== note.id) {
            await onNoteSelect(note);
          }
        }}
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          py: 1.5,
          px: 2,
        }}
      >
        <Typography
          noWrap
          variant='body2'
          sx={{
            width: '100%',
            fontWeight: currentNote?.id === note.id ? 'bold' : 'normal',
            mb: -0.5,
          }}
        >
          {getNoteTitle(note)}
        </Typography>
        <Box sx={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <IconButton
            className='drag-handle'
            {...attributes}
            {...listeners}
            sx={{
              opacity: 0,
              transition: 'opacity 0.2s',
              p: 0.5,
              ml: -1,
            }}
          >
            {isDragging ? (
              <ImportExport sx={{ width: 16, height: 16 }} />
            ) : (
              <DragHandle sx={{ width: 16, height: 16, color: 'action.disabled' }} />
            )}
          </IconButton>
          <Typography
            variant='caption'
            sx={{
              color: 'text.secondary',
            }}
          >
            {dayjs(note.modifiedTime).format('L HH:mm:ss')}
          </Typography>
        </Box>
      </ListItemButton>
      <Tooltip title='Archive' arrow placement='right'>
        <IconButton
          className='archive-button'
          onClick={async (e) => {
            e.stopPropagation();
            await onArchive(note.id);
          }}
          sx={{
            position: 'absolute',
            right: 8,
            top: 8,
            opacity: 0,
            transition: 'opacity 0.2s',
            width: 26,
            height: 26,
            backgroundColor: 'background.default',
            '&:hover': {
              backgroundColor: 'primary.main',
            },
          }}
        >
          <Archive sx={{ width: 18, height: 18 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
};

export const NoteList: React.FC<NoteListProps> = ({ notes, currentNote, onNoteSelect, onArchive, onShowArchived, onReorder }) => {
  const activeNotes = notes?.filter((note) => !note.archived) || [];
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        delay: 10,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = activeNotes.findIndex((note) => note.id === active.id);
      const newIndex = activeNotes.findIndex((note) => note.id === over.id);

      // バックエンドに順序の更新を通知
      try {
        // @ts-ignore (window.go is injected by Wails)
        await UpdateNoteOrder(active.id, newIndex);

        // フロントエンドの状態を更新
        // アクティブノートとアーカイブノートを分離
        const archivedNotes = notes.filter((note) => note.archived);
        const newActiveNotes = arrayMove(activeNotes, oldIndex, newIndex);

        // アクティブノートとアーカイブノートを結合
        const newNotes = [...newActiveNotes, ...archivedNotes];
        onReorder?.(newNotes);
      } catch (error) {
        console.error('Failed to update note order:', error);
      }
    }
  };

  const getNoteTitle = (note: Note) => {
    // タイトルがある場合はそれを使用
    if (note.title.trim()) return note.title;

    // アーカイブされたノートの場合はcontentHeaderを使用
    if (note.archived && note.contentHeader) {
      return note.contentHeader.replace(/\r\n|\n|\r/g, ' ').slice(0, 30);
    }

    // 本文が完全に空か、改行のみの場合は「New Note」を表示
    const content = note.content?.trim() || '';
    if (!content) return 'New Note';

    // 本文の最初の非空行を探す
    const lines = content.split('\n');
    const firstNonEmptyLine = lines.find((line) => line.trim().length > 0);

    // 非空行が見つからない場合は「New Note」を表示
    if (!firstNonEmptyLine) return 'New Note';

    // Windows/Mac/Linuxの改行をすべて取り除いた30文字までを表示
    return content.replace(/\r\n|\n|\r/g, ' ').slice(0, 30);
  };

  return (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        '& .simplebar-track.simplebar-vertical .simplebar-scrollbar:before': {
          backgroundColor: 'text.secondary',
        },
      }}
    >
      <SimpleBar
        style={{
          height: 'calc(100% - 37.5px)',
        }}
      >
        <List sx={{ flexGrow: 1, overflow: 'auto' }}>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          >
            <SortableContext items={activeNotes.map((note) => note.id)} strategy={verticalListSortingStrategy}>
              {activeNotes.map((note) => (
                <SortableNoteItem
                  key={note.id}
                  note={note}
                  currentNote={currentNote}
                  onNoteSelect={onNoteSelect}
                  onArchive={onArchive}
                  getNoteTitle={getNoteTitle}
                />
              ))}
            </SortableContext>
          </DndContext>
        </List>
      </SimpleBar>
      <Button
        fullWidth
        sx={{
          mt: 'auto',
          borderRadius: 0,
          borderTop: 1,
          borderColor: 'divider',
          zIndex: 1000,
          backgroundColor: 'background.paper',
        }}
        startIcon={<Inventory sx={{ width: 20, height: 20 }} />}
        disabled={!notes?.some((note) => note.archived)}
        onClick={onShowArchived}
      >
        Archive
      </Button>
    </Box>
  );
};
