import { List } from '@mui/material';
import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Note, FileNote } from '../../types';
import { NoteListItem } from './NoteListItem';
import { FileNoteListItem } from './FileNoteListItem';
import { UpdateNoteOrder } from '../../../wailsjs/go/backend/App';

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
}

interface SortableItemProps {
  note: Note | FileNote;
  currentNote: Note | FileNote | null;
  isFileMode?: boolean;
  onNoteSelect: (note: Note | FileNote) => Promise<void>;
  onArchive?: (noteId: string) => Promise<void>;
  onConvertToNote?: (fileNote: FileNote) => Promise<void>;
  onSaveFile?: (fileNote: FileNote) => Promise<void>;
  onCloseFile?: (note: FileNote) => Promise<void>;
  isFileModified?: (fileId: string) => boolean;
}

const SortableItem: React.FC<SortableItemProps> = ({
  note,
  currentNote,
  isFileMode,
  onNoteSelect,
  onArchive,
  onConvertToNote,
  onSaveFile,
  onCloseFile,
  isFileModified,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: note.id });

  const style = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const dragHandleProps = {
    attributes,
    listeners,
    isDragging,
  };

  if (isFileMode && 'filePath' in note) {
    return (
      <div ref={setNodeRef} style={style}>
        <FileNoteListItem
          note={note}
          isSelected={currentNote?.id === note.id}
          isModified={isFileModified?.(note.id) || false}
          onSelect={async () => await onNoteSelect(note)}
          onSave={async () => onSaveFile?.(note)}
          onConvert={async () => onConvertToNote?.(note)}
          onClose={async () => onCloseFile?.(note)}
          dragHandleProps={dragHandleProps}
        />
      </div>
    );
  }

  if (!isFileMode && !('filePath' in note)) {
    return (
      <div ref={setNodeRef} style={style}>
        <NoteListItem
          note={note}
          isSelected={currentNote?.id === note.id}
          onSelect={async () => await onNoteSelect(note)}
          onArchive={onArchive ? async () => await onArchive(note.id) : undefined}
          dragHandleProps={dragHandleProps}
        />
      </div>
    );
  }

  return null;
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
      const newFileNotes = arrayMove(activeNotes as FileNote[], oldIndex, newIndex);
      onReorder?.(newFileNotes);
    } else {
      const archivedNotes = (notes as Note[]).filter((note) => note.archived);
      const newActiveNotes = arrayMove(activeNotes as Note[], oldIndex, newIndex);
      const newNotes = [...newActiveNotes, ...archivedNotes];
      onReorder?.(newNotes);

      try {
        await UpdateNoteOrder(active.id as string, newIndex);
      } catch (error) {
        console.error('Failed to update note order:', error);
      }
    }
  };

  return (
    <List sx={{ flexGrow: 1, overflow: 'auto' }}>
      <DndContext sensors={sensors} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
        <SortableContext items={activeNotes.map((note) => note.id)} strategy={verticalListSortingStrategy}>
          {activeNotes.map((note) => (
            <SortableItem
              key={note.id}
              note={note}
              currentNote={currentNote}
              isFileMode={isFileMode}
              onNoteSelect={onNoteSelect}
              onArchive={onArchive}
              onConvertToNote={onConvertToNote}
              onSaveFile={onSaveFile}
              onCloseFile={onCloseFile}
              isFileModified={isFileModified}
            />
          ))}
        </SortableContext>
      </DndContext>
    </List>
  );
};
