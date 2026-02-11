import { Logout, Settings } from '@mui/icons-material';
import CloudDoneIcon from '@mui/icons-material/CloudDone';
import CloudSyncIcon from '@mui/icons-material/CloudSync';
import { Box, CircularProgress, Divider, IconButton, List, ListItem, Popover, Tooltip, Typography } from '@mui/material';
import { keyframes } from '@mui/system';
import type { editor, IDisposable } from 'monaco-editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import SimpleBar from 'simplebar-react';
import 'simplebar-react/dist/simplebar.min.css';
import * as wailsRuntime from '../../wailsjs/runtime';
import { useDriveSync } from '../hooks/useDriveSync';
import { GoogleDriveIcon, MarkdownIcon, SplitEditorIcon } from './Icons';
import { VersionUp } from './VersionUp';

const fadeAnimation = keyframes`
  0% { opacity: 1; }
  50% { opacity: 0.4; }
  100% { opacity: 1; }
`;

interface LogEntry {
  message: string;
  timestamp: Date;
}

const MAX_HISTORY = 1000;

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

interface EditorStatusBarProps {
  editorInstanceRef: React.RefObject<editor.IStandaloneCodeEditor | null>;
  isSplit: boolean;
  isMarkdownPreview: boolean;
  canSplit: boolean;
  onToggleSplit: () => void;
  onToggleMarkdownPreview: () => void;
  onSettings: () => void;
  showMessage: (title: string, message: string, isTwoButton?: boolean) => Promise<boolean>;
}

export const EditorStatusBar = ({
  editorInstanceRef,
  isSplit,
  isMarkdownPreview,
  canSplit,
  onToggleSplit,
  onToggleMarkdownPreview,
  onSettings,
  showMessage,
}: EditorStatusBarProps) => {
  const { syncStatus, isHoveringSync, setIsHoveringSync, isHoverLocked, handleGoogleAuth, handleLogout, handleSyncNow } =
    useDriveSync(showMessage);
  const [logMessage, setLogMessage] = useState<string>('');
  const [opacity, setOpacity] = useState<number>(1);
  const logTimeoutRef = useRef<number | null>(null);
  const messageHistoryRef = useRef<LogEntry[]>([]);
  const [historyAnchor, setHistoryAnchor] = useState<HTMLElement | null>(null);
  const [historyWidth, setHistoryWidth] = useState<number>(480);
  const historyOpen = Boolean(historyAnchor);

  const updateHistoryWidth = useCallback((anchor: HTMLElement | null) => {
    if (!anchor) {
      return;
    }
    const { left } = anchor.getBoundingClientRect();
    setHistoryWidth(Math.max(320, window.innerWidth - left));
  }, []);

  const getEditorInfo = useCallback(() => {
    if (!editorInstanceRef?.current) return [];

    const model = editorInstanceRef.current.getModel();
    if (!model) return [];

    const position = editorInstanceRef.current.getPosition();
    const selection = editorInstanceRef.current.getSelection();
    const lineCount = model.getLineCount();

    const info = [`Length: ${model.getValueLength()}`, `Lines: ${lineCount}`];

    if (selection && !selection.isEmpty()) {
      const start = `${selection.startLineNumber}.${selection.startColumn}`;
      const end = `${selection.endLineNumber}.${selection.endColumn}`;
      info.push(`Select: [ ${start} -> ${end} ]`);
    } else if (position) {
      info.push(`Cursor Position: [ Line ${position.lineNumber}, Col ${position.column} ]`);
    }

    return info;
  }, [editorInstanceRef]);

  const [info, setInfo] = useState<string[]>(getEditorInfo());

  useEffect(() => {
    const editor = editorInstanceRef?.current;
    if (!editor) return;

    setInfo(getEditorInfo());

    const disposables: IDisposable[] = [
      editor.onDidChangeCursorPosition(() => setInfo(getEditorInfo())),
      editor.onDidChangeCursorSelection(() => setInfo(getEditorInfo())),
      editor.onDidChangeModelContent(() => setInfo(getEditorInfo())),
      editor.onDidChangeModel(() => setInfo(getEditorInfo())),
    ];

    return () => {
      for (const d of disposables) {
        d.dispose();
      }
    };
  }, [editorInstanceRef, getEditorInfo]);

  useEffect(() => {
    wailsRuntime.EventsOn('logMessage', (message: string) => {
      if (logTimeoutRef.current) {
        window.clearTimeout(logTimeoutRef.current);
      }

      setLogMessage(message);
      setOpacity(1);

      const history = messageHistoryRef.current;
      history.push({ message, timestamp: new Date() });
      if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
      }

      logTimeoutRef.current = window.setTimeout(() => {
        setOpacity(0);
      }, 8000);
    });

    return () => {
      wailsRuntime.EventsOff('logMessage');
      if (logTimeoutRef.current) {
        window.clearTimeout(logTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!historyOpen) {
      return;
    }
    const onResize = () => updateHistoryWidth(historyAnchor);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, [historyOpen, historyAnchor, updateHistoryWidth]);

  return (
    <Box
      sx={{
        borderTop: 1,
        borderColor: 'divider',
        px: 2,
        height: 37,
        minHeight: 37,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
        bgcolor: (theme) => theme.palette.background.paper,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <Box sx={{ display: 'flex', width: 220, flexShrink: 0, textAlign: 'left' }}>
        <Typography variant='caption' component='div' sx={{ mx: 2 }} noWrap>
          {info[0]}
        </Typography>
        <Typography variant='caption' component='div' sx={{ mx: 2 }} noWrap>
          {info[1]}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', textAlign: 'left', width: 280, flexShrink: 0 }}>
        <Divider orientation='vertical' flexItem />
        <Typography variant='caption' component='div' sx={{ mx: 4, width: '100%' }} noWrap>
          {info[2]}
        </Typography>
        <Divider orientation='vertical' flexItem sx={{ right: 0 }} />
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          textAlign: 'left',
          flexGrow: 1,
          minWidth: 0,
        }}
      >
        <VersionUp />
        <Tooltip title={messageHistoryRef.current.length > 0 ? 'Open Notification History' : ''} arrow placement='top'>
          <Box
            onClick={(e) => {
              if (messageHistoryRef.current.length > 0) {
                setHistoryAnchor(e.currentTarget);
                updateHistoryWidth(e.currentTarget);
              }
            }}
            sx={{
              cursor: messageHistoryRef.current.length > 0 ? 'pointer' : 'default',
              flexGrow: 1,
              minWidth: 0,
              py: 0.5,
              '&:hover':
                messageHistoryRef.current.length > 0
                  ? {
                      bgcolor: 'action.hover',
                      borderRadius: 0.5,
                    }
                  : {},
            }}
          >
            <Typography
              variant='caption'
              sx={{
                mx: 4,
                color: 'text.secondary',
                opacity: opacity,
                transition: 'opacity 2s',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {logMessage}
            </Typography>
          </Box>
        </Tooltip>
      </Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          pl: 2,
          pr: 1,
          bgcolor: (theme) => theme.palette.background.paper,
          zIndex: 1,
        }}
      >
        <Tooltip title={isSplit ? 'Close Split' : 'Split Editor'} arrow placement='top'>
          <span>
            <IconButton
              sx={{ fontSize: 16, width: 28, height: 28 }}
              onClick={onToggleSplit}
              disabled={!canSplit && !isSplit}
              color={isSplit ? 'primary' : 'default'}
            >
              <SplitEditorIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={isMarkdownPreview ? 'Close Preview' : 'Markdown Preview'} arrow placement='top'>
          <IconButton
            sx={{ fontSize: 16, width: 28, height: 28 }}
            onClick={onToggleMarkdownPreview}
            color={isMarkdownPreview ? 'primary' : 'default'}
          >
            <MarkdownIcon sx={{ fontSize: 20 }} />
          </IconButton>
        </Tooltip>

        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          {syncStatus === 'synced' ? (
            <Tooltip title='Sync now!' arrow placement='top'>
              <IconButton
                onClick={handleSyncNow}
                size='small'
                sx={{ width: 28, height: 28 }}
                onMouseEnter={() => !isHoverLocked && setIsHoveringSync(true)}
                onMouseLeave={() => setIsHoveringSync(false)}
              >
                {isHoveringSync ? (
                  <CloudSyncIcon color='primary' sx={{ fontSize: 22 }} />
                ) : (
                  <CloudDoneIcon color='primary' sx={{ fontSize: 20 }} />
                )}
              </IconButton>
            </Tooltip>
          ) : syncStatus === 'syncing' ? (
            <Tooltip title='Syncing...' arrow placement='top'>
              <Box
                sx={{
                  animation: `${fadeAnimation} 1.5s ease-in-out infinite`,
                  display: 'flex',
                  alignItems: 'center',
                  mx: 0.5,
                }}
              >
                <CircularProgress size={18} />
              </Box>
            </Tooltip>
          ) : (
            syncStatus === 'logging in' && <CircularProgress size={18} sx={{ mx: 0.5 }} />
          )}
        </Box>
        {syncStatus === 'offline' ? (
          <Tooltip title='Connect to Google Drive' arrow placement='top'>
            <IconButton sx={{ width: 28, height: 28 }} onClick={handleGoogleAuth}>
              <GoogleDriveIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip title={syncStatus === 'logging in' ? 'Cancel' : 'Logout'} arrow placement='top'>
            <span>
              <IconButton disabled={syncStatus === 'syncing'} onClick={handleLogout} sx={{ width: 28, height: 28 }}>
                <Logout sx={{ fontSize: 18 }} />
              </IconButton>
            </span>
          </Tooltip>
        )}
        <Tooltip title='Settings' arrow placement='top'>
          <IconButton sx={{ width: 28, height: 28 }} onClick={onSettings}>
            <Settings sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </Box>
      <Popover
        open={historyOpen}
        anchorEl={historyAnchor}
        onClose={() => setHistoryAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        marginThreshold={0}
        slotProps={{
          paper: {
            sx: {
              width: historyWidth,
              maxWidth: 'none',
              overflow: 'hidden',
              '& .simplebar-track.simplebar-vertical .simplebar-scrollbar:before': {
                backgroundColor: 'text.secondary',
              },
            },
          },
        }}
      >
        <Box sx={{ px: 2, py: 1, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant='subtitle2'>Notification History ({messageHistoryRef.current.length})</Typography>
        </Box>
        <SimpleBar
          style={{
            maxHeight: 'calc(min(600px, 90vh) - 42px)',
            overflowX: 'hidden',
          }}
        >
          <List dense sx={{ py: 0 }}>
            {messageHistoryRef.current.map((entry, index) => (
              <ListItem
                key={`${entry.timestamp.getTime()}-${index}`}
                sx={{
                  py: 0.25,
                  px: 2,
                  '&:hover': { bgcolor: 'action.hover' },
                }}
              >
                <Typography
                  variant='caption'
                  sx={{
                    color: 'text.disabled',
                    mr: 1.5,
                    flexShrink: 0,
                    fontFamily: 'monospace',
                  }}
                >
                  {formatTime(entry.timestamp)}
                </Typography>
                <Typography variant='caption' sx={{ color: 'text.secondary', wordBreak: 'break-word' }}>
                  {entry.message}
                </Typography>
              </ListItem>
            ))}
          </List>
        </SimpleBar>
      </Popover>
    </Box>
  );
};
