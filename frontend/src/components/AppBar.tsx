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
import { NoteAdd, OpenInBrowser, Save, Settings, Logout } from '@mui/icons-material';
import CloudDoneIcon from '@mui/icons-material/CloudDone';
import CloudSyncIcon from '@mui/icons-material/CloudSync';
import { GoogleDriveIcon } from './Icons';
import { Note } from '../types';
import { LanguageInfo } from '../lib/monaco';
import { useEffect, useState, useRef } from 'react';
import { EventsOn, EventsOff, OnFileDrop, OnFileDropOff } from '../../wailsjs/runtime';
import {
  AuthorizeDrive,
  LogoutDrive,
  OpenFile,
  SyncNow,
  CheckDriveConnection,
  CancelLoginDrive,
} from '../../wailsjs/go/backend/App';
import { keyframes } from '@mui/system';
import { getLanguageByExtension } from '../lib/monaco';
import { isBinaryFile } from '../utils/fileUtils';

const fadeAnimation = keyframes`
  0% { opacity: 1; }
  50% { opacity: 0.4; }
  100% { opacity: 1; }
`;

const SYNC_TIMEOUT = 5 * 60 * 1000; // 5分のタイムアウト

export const AppBar: React.FC<{
  currentNote: Note | null;
  languages: LanguageInfo[];
  onTitleChange: (title: string) => void;
  onLanguageChange: (language: string) => void;
  onSettings: () => void;
  onNew: () => Promise<void>;
  onOpen: () => Promise<void>;
  onSave: () => Promise<void>;
  notes: Note[];
  setNotes: (notes: Note[]) => void;
  showMessage: (title: string, message: string, isTwoButton?: boolean) => Promise<boolean>;
  handleNoteSelect: (note: Note, isNew: boolean) => Promise<void>;
}> = ({
  currentNote,
  languages,
  onTitleChange,
  onLanguageChange,
  onSettings,
  onNew,
  onOpen,
  onSave,
  notes,
  setNotes,
  showMessage,
  handleNoteSelect,
}) => {
  const [syncStatus, setSyncStatus] = useState<'synced' | 'syncing' | 'logging in' | 'offline'>('offline');
  const [isHoveringSync, setIsHoveringSync] = useState(false);
  const [isHoverLocked, setIsHoverLocked] = useState(false);
  const syncStartTime = useRef<number | null>(null);
  const syncCheckInterval = useRef<NodeJS.Timeout | null>(null);

  const handleFileDrop = async (_x: number, _y: number, paths: string[]) => {
    if (paths.length > 0) {
      try {
        const filePath = paths[0];
        const content = await OpenFile(filePath);
        if (typeof content !== 'string') return;

        if (isBinaryFile(content)) {
          showMessage('Error', 'Failed to open the dropped file. Please check the file format.');
          return;
        }

        const extension = filePath.split('.').pop()?.toLowerCase() || '';
        const detectedLanguage = getLanguageByExtension('.' + extension);
        const language =
          typeof detectedLanguage?.id === 'string' && detectedLanguage.id !== '' ? detectedLanguage.id : 'plaintext';
        const fileName = filePath.split(/[/\\]/).pop() || '';

        const newNote: Note = {
          id: crypto.randomUUID(),
          title: fileName.replace(/\.[^/.]+$/, ''),
          content,
          contentHeader: null,
          language,
          modifiedTime: new Date().toISOString(),
          archived: false,
        };
        setNotes([newNote, ...notes]);
        await handleNoteSelect(newNote, true);
      } catch (error) {
        console.error('File drop error:', error);
        showMessage('Error', 'ファイルのオープンに失敗しました');
      }
    }
  };

  useEffect(() => {
    const handleSync = () => {
      setSyncStatus('syncing');
    };

    const handleDriveStatus = (status: string) => {
      setSyncStatus(status as 'synced' | 'syncing' | 'offline');
    };

    const handleDriveError = (error: string) => {
      showMessage('Drive error', error);
      console.error('Drive error:', error);
    };

    EventsOn('notes:updated', handleSync);
    EventsOn('drive:status', handleDriveStatus);
    EventsOn('drive:error', handleDriveError);
    OnFileDrop(handleFileDrop, true);

    return () => {
      EventsOff('notes:updated');
      EventsOff('drive:status');
      EventsOff('drive:error');
      OnFileDropOff();
    };
  }, [notes, setNotes, handleNoteSelect, showMessage]);

  const handleGoogleAuth = async () => {
    try {
      setSyncStatus('syncing');
      await AuthorizeDrive();
    } catch (error) {
      console.error('Google authentication error:', error);
      showMessage('Error', 'Google authentication failed: ' + error);
      setSyncStatus('offline');
    }
  };

  const handleLogout = async () => {
    try {
      // ログイン中の場合はキャンセル処理を実行
      if (syncStatus === 'logging in') {
        await CancelLoginDrive();
        return;
      }

      // 通常のログアウト処理（確認あり）
      const result = await showMessage('Logout from Google Drive', 'Are you sure you want to logout?', true);
      if (result) {
        await LogoutDrive();
      }
    } catch (error) {
      console.error('Logout error:', error);
      showMessage('Error', 'Logout failed: ' + error);
    }
  };

  const handleSync = async () => {
    if (syncStatus === 'synced') {
      try {
        setIsHoveringSync(false);
        setSyncStatus('syncing');
        await SyncNow();
        setSyncStatus('synced');
      } catch (error) {
        console.error('Manual sync error:', error);
        showMessage('Sync Error', 'Failed to synchronize with Google Drive: ' + error);
      }
    }
  };

  // 同期状態の監視を開始
  const startSyncMonitoring = () => {
    // 既存の監視をクリア
    if (syncCheckInterval.current) {
      clearInterval(syncCheckInterval.current);
    }

    syncStartTime.current = Date.now();
    syncCheckInterval.current = setInterval(async () => {
      try {
        // バックエンドの状態をチェック
        const isConnected = await CheckDriveConnection();

        if (!isConnected && syncStatus !== 'logging in') {
          // 切断されている場合は強制ログアウト
          await handleForcedLogout('Drive connection lost. Please login again.');
          return;
        }

        // タイムアウトチェック
        if (syncStartTime.current && Date.now() - syncStartTime.current > SYNC_TIMEOUT) {
          await handleForcedLogout('Sync timeout. Please login again.');
          return;
        }
      } catch (error) {
        console.error('Sync monitoring error:', error);
        await handleForcedLogout('Error checking sync status. Please login again.');
      }
    }, 10000); // 10秒ごとにチェック
  };

  // 同期状態の監視を停止
  const stopSyncMonitoring = () => {
    if (syncCheckInterval.current) {
      clearInterval(syncCheckInterval.current);
      syncCheckInterval.current = null;
    }
    syncStartTime.current = null;
  };

  // 強制ログアウト処理
  const handleForcedLogout = async (message: string) => {
    stopSyncMonitoring();
    try {
      await LogoutDrive();
      showMessage('Sync Error', message);
    } catch (error) {
      console.error('Forced logout error:', error);
      showMessage('Error', 'Failed to logout: ' + error);
    }
  };

  // syncStatusの変更を監視
  useEffect(() => {
    if (syncStatus === 'syncing') {
      startSyncMonitoring();
    } else {
      stopSyncMonitoring();
    }

    return () => {
      stopSyncMonitoring();
    };
  }, [syncStatus]);

  // コンポーネントのクリーンアップ
  useEffect(() => {
    return () => {
      stopSyncMonitoring();
    };
  }, []);

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
