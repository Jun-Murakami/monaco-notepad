import { Box, IconButton, ListItemButton, Typography, Tooltip } from '@mui/material';
import { Save, Close, SimCardDownload, DriveFileRenameOutline } from '@mui/icons-material';
import { FileNote } from '../../types';
import dayjs from '../../utils/dayjs';
import { DragHandleIcon } from './DragHandleIcon';

interface FileNoteListItemProps {
  note: FileNote;
  isSelected: boolean;
  isModified: boolean;
  onSelect: () => Promise<void>;
  onSave: () => Promise<void>;
  onConvert: () => Promise<void>;
  onClose: () => Promise<void>;
  dragHandleProps?: {
    attributes: any;
    listeners: any;
    isDragging: boolean;
  };
}

export const FileNoteListItem: React.FC<FileNoteListItemProps> = ({
  note,
  isSelected,
  isModified,
  onSelect,
  onSave,
  onConvert,
  onClose,
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
          {note.fileName}
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

      <Tooltip title='Save File' arrow placement='bottom'>
        <IconButton
          className='action-button'
          disabled={!isModified}
          onClick={async (e) => {
            e.stopPropagation();
            if (isModified) {
              await onSave();
            }
          }}
          sx={{
            position: 'absolute',
            right: 72,
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
          <Save sx={{ width: 18, height: 18 }} />
        </IconButton>
      </Tooltip>

      <Tooltip title='Convert to Note' arrow placement='bottom'>
        <IconButton
          className='action-button'
          onClick={async (e) => {
            e.stopPropagation();
            await onConvert();
          }}
          sx={{
            position: 'absolute',
            right: 40,
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
          <SimCardDownload sx={{ width: 18, height: 18 }} />
        </IconButton>
      </Tooltip>

      <Tooltip title='Close' arrow placement='bottom'>
        <IconButton
          className='action-button'
          onClick={async (e) => {
            e.stopPropagation();
            await onClose();
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
          <Close sx={{ width: 18, height: 18 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
};
