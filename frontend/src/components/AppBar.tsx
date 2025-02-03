import { Box, Button, TextField, FormControl, InputLabel, Select, MenuItem, IconButton } from '@mui/material';
import { NoteAdd, OpenInBrowser, Save, Settings } from '@mui/icons-material';
import { Note } from '../types';
import { LanguageInfo } from '../lib/monaco';

export const AppBar: React.FC<{
  currentNote: Note | null;
  languages: LanguageInfo[];
  onTitleChange: (title: string) => void;
  onLanguageChange: (language: string) => void;
  onSettings: () => void;
  onNew: () => Promise<void>;
  onOpen: () => Promise<void>;
  onSave: () => Promise<void>;
}> = ({ currentNote, languages, onTitleChange, onLanguageChange, onSettings, onNew, onOpen, onSave }) => {
  return (
    <Box sx={{ height: 56, display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
      <Box
        sx={{
          height: 40,
          p: 1,
          display: 'flex',
          justifyContent: 'flex-start',
          alignItems: 'center',
          gap: 1,
        }}
      >
        <Button
          sx={{ fontSize: 14, width: 70, height: 32 }}
          startIcon={<NoteAdd sx={{ mr: -0.5 }} />}
          variant='contained'
          onClick={onNew}
        >
          New
        </Button>
        <Button
          sx={{ fontSize: 14, width: 70, height: 32 }}
          startIcon={<OpenInBrowser sx={{ mr: -0.5 }} />}
          variant='contained'
          onClick={onOpen}
        >
          Open
        </Button>
        <Button
          sx={{ fontSize: 14, width: 70, height: 32 }}
          startIcon={<Save sx={{ mr: -0.5 }} />}
          variant='contained'
          onClick={onSave}
        >
          Save
        </Button>
      </Box>
      <Box sx={{ width: '100%', height: 40 }}>
        <TextField
          sx={{ width: '100%', height: 32 }}
          label='Title'
          variant='outlined'
          size='small'
          value={currentNote?.title || ''}
          onChange={(e) => onTitleChange(e.target.value)}
        />
      </Box>
      <Box
        sx={{
          height: 40,
          p: 1,
          gap: 1,
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
        }}
      >
        <FormControl
          sx={{
            width: 200,
          }}
          size='small'
        >
          <InputLabel size='small'>Language</InputLabel>
          <Select
            size='small'
            value={currentNote?.language || ''}
            onChange={(e) => onLanguageChange(e.target.value)}
            label='Language'
          >
            {languages.map((lang) => (
              <MenuItem key={lang.id} value={lang.id}>
                {lang.aliases?.[0] ?? lang.id}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <IconButton sx={{ fontSize: 16, width: 32, height: 32 }} onClick={onSettings}>
          <Settings />
        </IconButton>
      </Box>
    </Box>
  );
};
