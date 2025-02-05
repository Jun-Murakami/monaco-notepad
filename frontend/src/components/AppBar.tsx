import { Box, Button, TextField, FormControl, InputLabel, Select, MenuItem, IconButton, Tooltip } from '@mui/material';
import { NoteAdd, OpenInBrowser, Save, Settings, Logout } from '@mui/icons-material';
import CloudDoneIcon from '@mui/icons-material/CloudDone';
import CloudSyncIcon from '@mui/icons-material/CloudSync';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import { GoogleDriveIcon } from './Icons';
import { Note } from '../types';
import { LanguageInfo } from '../lib/monaco';
import { useEffect, useState } from 'react';

import { EventsOn, EventsOff } from '../../wailsjs/runtime';
import { AuthorizeDrive, LogoutDrive } from '../../wailsjs/go/main/App';
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
  showMessage: (title: string, message: string, isTwoButton?: boolean) => Promise<boolean>;
}> = ({ currentNote, languages, onTitleChange, onLanguageChange, onSettings, onNew, onOpen, onSave, showMessage }) => {
  const [syncStatus, setSyncStatus] = useState<'synced' | 'syncing' | 'offline'>('offline');
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  useEffect(() => {
    const handleSync = () => {
      setSyncStatus('syncing');
    };

    const handleDriveStatus = (status: string) => {
      setSyncStatus(status as 'synced' | 'syncing' | 'offline');
    };

    const handleDriveError = (error: string) => {
      console.error('Drive error:', error);
      setSyncStatus('offline');
    };

    EventsOn('notes:updated', handleSync);
    EventsOn('drive:status', handleDriveStatus);
    EventsOn('drive:error', handleDriveError);

    return () => {
      EventsOff('notes:updated');
      EventsOff('drive:status');
      EventsOff('drive:error');
    };
  }, []);

  const handleGoogleAuth = async () => {
    try {
      setIsAuthenticating(true);
      setSyncStatus('syncing');
      const result = await AuthorizeDrive();
      if (result === 'auth_complete') {
        setSyncStatus('synced');
      }
    } catch (error) {
      console.error('Google authentication error:', error);
      setSyncStatus('offline');
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleLogout = async () => {
    try {
      const result = await showMessage('Logout from Google Drive', 'Are you sure you want to logout from Google Drive?', true);
      if (result) {
        await LogoutDrive();
      }
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

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
        <Box sx={{ ml: 0.5, display: 'flex', alignItems: 'center' }}>
          {syncStatus === 'synced' ? (
            <Tooltip title='Synced' arrow>
              <CloudDoneIcon color='primary' />
            </Tooltip>
          ) : (
            syncStatus === 'syncing' && (
              <Tooltip title='Syncing...' arrow>
                <Box sx={{ animation: `${fadeAnimation} 1.5s ease-in-out infinite`, mt: 1 }}>
                  <CloudSyncIcon color='primary' />
                </Box>
              </Tooltip>
            )
          )}
        </Box>
        {syncStatus === 'offline' ? (
          <Tooltip title='Connect to Google Drive' arrow>
            <IconButton sx={{ fontSize: 16, width: 32, height: 32, ml: -1 }} onClick={handleGoogleAuth}>
              <GoogleDriveIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip title='Logout' arrow>
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
