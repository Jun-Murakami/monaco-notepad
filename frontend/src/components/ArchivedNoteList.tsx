import { Box, Typography, IconButton, List, ListItem, Tooltip, Divider, Button } from '@mui/material';
import { Unarchive, DeleteForever, ArrowBack, DeleteSweep } from '@mui/icons-material';
import { Note } from '../types';
import dayjs from 'dayjs';
import SimpleBar from 'simplebar-react';
import 'simplebar-react/dist/simplebar.min.css';

interface ArchivedNoteListProps {
  notes: Note[];
  onUnarchive: (noteId: string) => void;
  onDelete: (noteId: string) => void;
  onDeleteAll: () => void;
  onClose: () => void;
}

export const ArchivedNoteList: React.FC<ArchivedNoteListProps> = ({ notes, onUnarchive, onDelete, onDeleteAll, onClose }) => {
  const archivedNotes = notes.filter((note) => note.archived);

  const getNoteTitle = (note: Note) => {
    if (note.title.trim()) return note.title;
    const content = note.content?.trim();
    if (!content) return 'Empty Note';
    const lines = content.split('\n');
    const firstNonEmptyLine = lines.find((line) => line.trim().length > 0);
    if (!firstNonEmptyLine) return 'Empty Note';
    return firstNonEmptyLine.slice(0, 30);
  };

  if (archivedNotes.length === 0) {
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
        '& .simplebar-track.simplebar-vertical .simplebar-scrollbar:before': {
          backgroundColor: 'text.secondary',
        },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, p: 2 }}>
        <IconButton onClick={onClose} sx={{ ml: -1, width: 32, height: 32 }}>
          <ArrowBack />
        </IconButton>
        <Typography variant='h6'>Archived notes</Typography>
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title='Delete all archived notes' arrow>
          <Button
            onClick={onDeleteAll}
            color='error'
            endIcon={<DeleteSweep sx={{ width: 28, height: 28 }} />}
            sx={{
              width: 120,
              height: 40,
              '&:hover': {
                backgroundColor: 'error.main',
                color: 'error.contrastText',
              },
              mr: 3.5,
            }}
          >
            Delete all
          </Button>
        </Tooltip>
      </Box>
      <Divider />
      <SimpleBar style={{ maxHeight: '100%', overflowX: 'hidden' }}>
        <List sx={{ flexGrow: 1, overflow: 'auto', mb: 8 }}>
          {archivedNotes.map((note) => (
            <ListItem
              key={note.id}
              sx={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 2,
                px: 7,
                borderBottom: 1,
                borderColor: 'divider',
              }}
            >
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography noWrap variant='body1' sx={{ mb: 0.5 }}>
                  {getNoteTitle(note)}
                </Typography>
                <Typography variant='caption' color='text.secondary'>
                  {dayjs(note.modifiedTime).format('L HH:mm:ss')}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                <Tooltip title='Unarchive' arrow>
                  <IconButton
                    onClick={() => onUnarchive(note.id)}
                    color='primary'
                    size='small'
                    sx={{
                      width: 32,
                      height: 32,
                      '&:hover': {
                        backgroundColor: 'primary.main',
                        color: 'primary.contrastText',
                      },
                    }}
                  >
                    <Unarchive />
                  </IconButton>
                </Tooltip>
                <Tooltip title='Delete' arrow>
                  <IconButton
                    onClick={() => onDelete(note.id)}
                    color='error'
                    size='small'
                    sx={{
                      width: 32,
                      height: 32,
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
            </ListItem>
          ))}
        </List>
      </SimpleBar>
    </Box>
  );
};
