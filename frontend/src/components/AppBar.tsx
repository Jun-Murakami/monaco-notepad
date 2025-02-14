import {
  Box,
  Button,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  IconButton,
  Tooltip,
  CircularProgress,
} from '@mui/material';
import { NoteAdd, Save, Settings, Logout, FileOpen } from '@mui/icons-material';
import CloudDoneIcon from '@mui/icons-material/CloudDone';
import CloudSyncIcon from '@mui/icons-material/CloudSync';
import { GoogleDriveIcon } from './Icons';
import { Note, FileNote } from '../types';
import { LanguageInfo } from '../lib/monaco';
import { keyframes } from '@mui/system';
import { useDriveSync } from '../hooks/useDriveSync';

const fadeAnimation = keyframes`
  0% { opacity: 1; }
  50% { opacity: 0.4; }
  100% { opacity: 1; }
`;

export const AppBar: React.FC<{
  currentNote: Note | FileNote | null;
  languages: LanguageInfo[];
  platform: string;
  onTitleChange: (title: string) => void;
  onLanguageChange: (language: string) => void;
  onSettings: () => void;
  onNew: () => Promise<void>;
  onOpen: () => Promise<void>;
  onSave: () => Promise<void>;
  showMessage: (title: string, message: string, isTwoButton?: boolean) => Promise<boolean>;
}> = ({ currentNote, languages, platform, onTitleChange, onLanguageChange, onSettings, onNew, onOpen, onSave, showMessage }) => {
  const { syncStatus, isHoveringSync, setIsHoveringSync, isHoverLocked, handleGoogleAuth, handleLogout, handleSync } =
    useDriveSync(showMessage);

  const isFileNote = (note: Note | FileNote | null): note is FileNote => {
    return note !== null && 'filePath' in note;
  };

  const commandKey = platform === 'darwin' ? 'Command' : 'Ctrl';

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
        <Tooltip title={`New (${commandKey} + N)`} arrow placement='bottom'>
          <Button
            sx={{ fontSize: 12, width: 70, height: 32 }}
            startIcon={<NoteAdd sx={{ mr: -0.75 }} />}
            variant='contained'
            onClick={onNew}
          >
            New
          </Button>
        </Tooltip>
        <Tooltip title={`Open (${commandKey} + O)`} arrow placement='bottom'>
          <Button
            sx={{ fontSize: 12, width: 70, height: 32 }}
            startIcon={<FileOpen sx={{ mr: -0.75 }} />}
            variant='contained'
            onClick={onOpen}
          >
            Open
          </Button>
        </Tooltip>
        <Tooltip title={`Save as (${commandKey} + S)`} arrow placement='bottom'>
          <Button
            sx={{ fontSize: 12, width: 70, height: 32, whiteSpace: 'nowrap' }}
            startIcon={<Save sx={{ mr: -1 }} />}
            variant='contained'
            onClick={onSave}
          >
            Save as
          </Button>
        </Tooltip>
      </Box>
      <Box sx={{ width: '100%', height: 70, display: 'flex', alignItems: 'center', gap: 1 }}>
        <TextField
          sx={{ width: '100%' }}
          label={isFileNote(currentNote) ? 'File Path' : 'Title'}
          variant='outlined'
          size='small'
          value={isFileNote(currentNote) ? currentNote.filePath : currentNote?.title || ''}
          onChange={(e) => onTitleChange(e.target.value)}
          disabled={isFileNote(currentNote)}
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
        <>
          <Box sx={{ ml: 0.5, display: 'flex', alignItems: 'center' }}>
            {syncStatus === 'synced' ? (
              <Tooltip title='Sync now!' arrow>
                <IconButton
                  onClick={handleSync}
                  size='small'
                  onMouseEnter={() => !isHoverLocked && setIsHoveringSync(true)}
                  onMouseLeave={() => setIsHoveringSync(false)}
                >
                  {isHoveringSync ? (
                    <CloudSyncIcon color='primary' sx={{ fontSize: 27, ml: -0.4 }} />
                  ) : (
                    <CloudDoneIcon color='primary' sx={{ fontSize: 24 }} />
                  )}
                </IconButton>
              </Tooltip>
            ) : syncStatus === 'syncing' ? (
              <Tooltip title='Syncing...' arrow>
                <Box sx={{ animation: `${fadeAnimation} 1.5s ease-in-out infinite`, mt: 1, mx: 0.625 }}>
                  <CircularProgress size={24} />
                </Box>
              </Tooltip>
            ) : (
              syncStatus === 'logging in' && <CircularProgress size={24} />
            )}
          </Box>
          {syncStatus === 'offline' ? (
            <Tooltip title='Connect to Google Drive' arrow>
              <IconButton sx={{ fontSize: 16, width: 32, height: 32, ml: -1 }} onClick={handleGoogleAuth}>
                <GoogleDriveIcon sx={{ fontSize: 20 }} />
              </IconButton>
            </Tooltip>
          ) : (
            <Tooltip title={syncStatus === 'logging in' ? 'Cancel' : 'Logout'} arrow>
              <span>
                <IconButton
                  disabled={syncStatus === 'syncing'}
                  onClick={handleLogout}
                  sx={{ fontSize: 16, ml: 0.5, width: 32, height: 32 }}
                >
                  <Logout />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </>
        <Tooltip title='Settings' arrow>
          <IconButton sx={{ fontSize: 16, width: 32, height: 32 }} onClick={onSettings}>
            <Settings />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
};
