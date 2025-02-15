import { Box, IconButton, List, ListItemButton, Typography, Tooltip } from '@mui/material';
import { Archive, DragHandle, ImportExport, Save, Close, DriveFileRenameOutline, SimCardDownload } from '@mui/icons-material';
import { UpdateNoteOrder, SaveFileNotes } from '../../wailsjs/go/backend/App';
import { Note, FileNote } from '../types';
import dayjs from '../utils/dayjs';
import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import 'simplebar-react/dist/simplebar.min.css';

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
}

interface SortableNoteItemProps {
  note: Note | FileNote;
  currentNote: Note | FileNote | null;
  onNoteSelect: (note: Note | FileNote) => Promise<void>;
  onArchive?: (noteId: string) => Promise<void>;
  onConvertToNote?: (fileNote: FileNote) => Promise<void>;
  onSaveFile?: (fileNote: FileNote) => Promise<void>;
  getNoteTitle: (note: Note | FileNote) => string;
  isFileMode?: boolean;
  onCloseFile?: (note: FileNote) => Promise<void>;
  isFileModified?: (fileId: string) => boolean;
  platform: string;
}

const SortableNoteItem: React.FC<SortableNoteItemProps> = ({
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
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: note.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const cmdKey = platform === 'darwin' ? 'Cmd' : 'Ctrl';

  const isFileNote = (note: Note | FileNote): note is FileNote => {
    return 'filePath' in note;
  };

  return (
    <Box
      ref={setNodeRef}
      style={style}
      sx={{
        position: 'relative',
        '&:hover .drag-handle, &:hover .action-button': { opacity: 1 },
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
          pt: 1,
          pb: 0.5,
          px: 2,
        }}
      >
        <Typography
          noWrap
          variant='body2'
          sx={{
            width: '100%',
            fontStyle: isFileModified?.(note.id) ? 'italic' : 'normal',
          }}
        >
          {isFileModified?.(note.id) && (
            <DriveFileRenameOutline sx={{ mb: -0.5, mr: 0.5, width: 18, height: 18, color: 'text.secondary' }} />
          )}
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
              <DragHandle sx={{ width: 16, height: 16, color: 'primary.main' }} />
            ) : (
              <ImportExport sx={{ width: 16, height: 16, color: 'action.disabled' }} />
            )}
          </IconButton>
          <Typography
            variant='caption'
            sx={{
              color: 'text.disabled',
            }}
          >
            {dayjs(note.modifiedTime).format('L _ HH:mm:ss')}
          </Typography>
        </Box>
      </ListItemButton>
      {isFileMode ? (
        <>
          <Tooltip title={`Save (${cmdKey} + S)`} arrow placement='bottom'>
            <span style={{ position: 'absolute', right: 72, top: 8 }}>
              <IconButton
                className='action-button'
                disabled={!isFileModified?.(note.id)}
                onClick={async (e) => {
                  e.stopPropagation();
                  if (isFileNote(note) && isFileModified?.(note.id) && onSaveFile) {
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
                    backgroundColor: 'primary.main',
                  },
                }}
              >
                <Save sx={{ width: 18, height: 18 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title='Convert to Note' arrow placement='bottom'>
            <span style={{ position: 'absolute', right: 40, top: 8 }}>
              <IconButton
                className='action-button'
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
                  },
                }}
              >
                <SimCardDownload sx={{ width: 18, height: 18 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={`Close (${cmdKey} + W)`} arrow placement='bottom'>
            <span style={{ position: 'absolute', right: 8, top: 8 }}>
              <IconButton
                className='action-button'
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
                    backgroundColor: 'primary.main',
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
          <Tooltip title={`Archive (${cmdKey} + W)`} arrow placement='bottom'>
            <span style={{ position: 'absolute', right: 8, top: 8 }}>
              <IconButton
                className='action-button'
                aria-label={`Archive (${cmdKey} + W)`}
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
                  },
                }}
              >
                <Archive sx={{ width: 18, height: 18 }} />
              </IconButton>
            </span>
          </Tooltip>
        )
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
}) => {
  const activeNotes = isFileMode ? notes : (notes as Note[]).filter((note) => !note.archived);
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
    if (!over || active.id === over.id) return;

    const oldIndex = activeNotes.findIndex((note) => note.id === active.id);
    const newIndex = activeNotes.findIndex((note) => note.id === over.id);

    if (isFileMode) {
      // FileNoteモードの場合は単純に並び替え
      const newFileNotes = arrayMove(activeNotes as FileNote[], oldIndex, newIndex);
      onReorder?.(newFileNotes);
      await SaveFileNotes(newFileNotes);
    } else {
      // 通常のノートモードの場合は、アーカイブされたノートも考慮
      const archivedNotes = (notes as Note[]).filter((note) => note.archived);
      const newActiveNotes = arrayMove(activeNotes as Note[], oldIndex, newIndex);
      const newNotes = [...newActiveNotes, ...archivedNotes];
      onReorder?.(newNotes);

      // その後、バックエンドの更新を行う
      try {
        await UpdateNoteOrder(active.id as string, newIndex);
      } catch (error) {
        console.error('Failed to update note order:', error);
      }
    }
  };

  const getNoteTitle = (note: Note | FileNote) => {
    if ('filePath' in note) {
      return note.fileName;
    }

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
    <List sx={{ flexGrow: 1, overflow: 'auto' }}>
      <DndContext sensors={sensors} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
        <SortableContext items={activeNotes.map((note) => note.id)} strategy={verticalListSortingStrategy}>
          {activeNotes.map((note) => (
            <SortableNoteItem
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
            />
          ))}
        </SortableContext>
      </DndContext>
    </List>
  );
};
