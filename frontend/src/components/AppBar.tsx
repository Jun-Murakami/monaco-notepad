import {
  Box,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  IconButton,
  Tooltip,
  CircularProgress,
  Button,
} from '@mui/material';
import { NoteAdd, OpenInBrowser, Save, Settings, Logout } from '@mui/icons-material';
import CloudDoneIcon from '@mui/icons-material/CloudDone';
import CloudSyncIcon from '@mui/icons-material/CloudSync';
import { GoogleDriveIcon } from './Icons';
import { Note } from '../types';
import { LanguageInfo } from '../lib/monaco';
import { useEffect, useState } from 'react';
import { keyframes } from '@mui/system';

const fadeAnimation = keyframes`
  0% { opacity: 1; }
  50% { opacity: 0.4; }
  100% { opacity: 1; }
`;

export const AppBar: React.FC<{
  currentNote: Note | null;
  languages: LanguageInfo[];
  onTitleChange: (title: string) => void;
  onLanguageChange: (language: string) => void;
  onSettings: () => void;
  onNew: () => Promise<void>;
  onOpen: () => Promise<void>;
  onSave: () => Promise<void>;
  syncStatus: 'synced' | 'syncing' | 'logging in' | 'offline';
  handleGoogleAuth: () => Promise<void>;
  handleLogout: () => Promise<void>;
  handleSync: () => Promise<void>;
}> = ({
  currentNote,
  languages,
  onTitleChange,
  onLanguageChange,
  onSettings,
  onNew,
  onOpen,
  onSave,
  syncStatus,
  handleGoogleAuth,
  handleLogout,
  handleSync,
}) => {
  const [isHoveringSync, setIsHoveringSync] = useState(false);
  const [isHoverLocked, setIsHoverLocked] = useState(false);

  // syncStatusの変更を監視して、同期完了時にホバー状態をリセット
  useEffect(() => {
    if (syncStatus === 'synced') {
      setIsHoveringSync(false);
      setIsHoverLocked(true);
      const timer = setTimeout(() => {
        setIsHoverLocked(false);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [syncStatus]);

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
          sx={{ fontSize: 12, width: 70, height: 32 }}
          startIcon={<NoteAdd sx={{ mr: -0.5 }} />}
          variant='contained'
          onClick={onNew}
        >
          New
        </Button>
        <Button
          sx={{ fontSize: 12, width: 70, height: 32 }}
          startIcon={<OpenInBrowser sx={{ mr: -0.5 }} />}
          variant='contained'
          onClick={onOpen}
        >
          Import
        </Button>
        <Button
          sx={{ fontSize: 12, width: 70, height: 32 }}
          startIcon={<Save sx={{ mr: -0.5 }} />}
          variant='contained'
          onClick={onSave}
        >
          Export
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
        <Tooltip title='Settings' arrow>
          <IconButton sx={{ fontSize: 16, width: 32, height: 32 }} onClick={onSettings}>
            <Settings />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
};
