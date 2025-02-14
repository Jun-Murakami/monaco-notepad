import { Box, IconButton, ListItemButton, Typography, Tooltip } from '@mui/material';
import { Archive, DriveFileRenameOutline } from '@mui/icons-material';
import { Note, FileNote } from '../../types';
import dayjs from '../../utils/dayjs';
import { DragHandleIcon } from './DragHandleIcon';

interface NoteListItemProps {
  note: Note | FileNote;
  isSelected: boolean;
  isModified?: boolean;
  onSelect: () => Promise<void>;
  onArchive?: () => Promise<void>;
  dragHandleProps?: {
    attributes: any;
    listeners: any;
    isDragging: boolean;
  };
}

const getNoteTitle = (note: Note | FileNote): string => {
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

export const NoteListItem: React.FC<NoteListItemProps> = ({
  note,
  isSelected,
  isModified,
  onSelect,
  onArchive,
  dragHandleProps,
}) => {
  return (
    <Box
      sx={{
        position: 'relative',
        '&:hover .drag-handle, &:hover .action-button': { opacity: 1 },
      }}
    >
      <ListItemButton
        selected={isSelected}
        onClick={onSelect}
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
            fontStyle: isModified ? 'italic' : 'normal',
          }}
        >
          {isModified && <DriveFileRenameOutline sx={{ mb: -0.5, mr: 0.5, width: 18, height: 18, color: 'text.secondary' }} />}
          {getNoteTitle(note)}
        </Typography>
        <Box sx={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {dragHandleProps && (
            <DragHandleIcon
              className='drag-handle'
              {...dragHandleProps.attributes}
              {...dragHandleProps.listeners}
              isDragging={dragHandleProps.isDragging}
            />
          )}
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
      {onArchive && (
        <Tooltip title='Archive' arrow placement='bottom'>
          <IconButton
            className='action-button'
            onClick={async (e) => {
              e.stopPropagation();
              await onArchive();
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
      )}
    </Box>
  );
};
