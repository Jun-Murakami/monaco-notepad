import {
  Box,
  Divider,
  List,
  ListItem,
  Popover,
  Tooltip,
  Typography,
} from '@mui/material';
import type { editor, IDisposable } from 'monaco-editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import SimpleBar from 'simplebar-react';
import 'simplebar-react/dist/simplebar.min.css';
import * as wailsRuntime from '../../wailsjs/runtime';
import type { FileNote, Note } from '../types';
import { VersionUp } from './VersionUp';

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
  currentNote: Note | FileNote | null;
}

export const EditorStatusBar = ({
  editorInstanceRef,
  currentNote,
}: EditorStatusBarProps) => {
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
      info.push(
        `Cursor Position: [ Line ${position.lineNumber}, Col ${position.column} ]`,
      );
    }

    return info;
  }, [editorInstanceRef]);

  const [info, setInfo] = useState<string[]>(getEditorInfo());

  useEffect(() => {
    if (!editorInstanceRef?.current || !currentNote) return;

    setInfo(getEditorInfo());

    const disposables: IDisposable[] = [];

    if (editorInstanceRef.current) {
      disposables.push(
        editorInstanceRef.current.onDidChangeCursorPosition(() => {
          setInfo(getEditorInfo());
        }),
        editorInstanceRef.current.onDidChangeCursorSelection(() => {
          setInfo(getEditorInfo());
        }),
        editorInstanceRef.current.onDidChangeModelContent(() => {
          setInfo(getEditorInfo());
        }),
      );
    }

    return () => {
      for (const d of disposables) {
        d.dispose();
      }
    };
  }, [editorInstanceRef, currentNote, getEditorInfo]);

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
        height: 39.5,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
        bgcolor: (theme) => theme.palette.background.paper,
        overflow: 'hidden',
      }}
    >
      <Box sx={{ display: 'flex', width: 220, textAlign: 'left' }}>
        <Typography variant="caption" component="div" sx={{ mx: 2 }} noWrap>
          {info[0]}
        </Typography>
        <Typography variant="caption" component="div" sx={{ mx: 2 }} noWrap>
          {info[1]}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', textAlign: 'left', width: 280 }}>
        <Divider orientation="vertical" flexItem />
        <Typography
          variant="caption"
          component="div"
          sx={{ mx: 4, width: '100%' }}
          noWrap
        >
          {info[2]}
        </Typography>
        <Divider orientation="vertical" flexItem sx={{ right: 0 }} />
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
        <Tooltip
          title={
            messageHistoryRef.current.length > 0
              ? 'Open Notification History'
              : ''
          }
          arrow
          placement="top"
        >
          <Box
            onClick={(e) => {
              if (messageHistoryRef.current.length > 0) {
                setHistoryAnchor(e.currentTarget);
                updateHistoryWidth(e.currentTarget);
              }
            }}
            sx={{
              cursor:
                messageHistoryRef.current.length > 0 ? 'pointer' : 'default',
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
              variant="caption"
              sx={{
                mx: 4,
                color: 'text.secondary',
                opacity: opacity,
                transition: 'opacity 2s',
                whiteSpace: 'nowrap',
                overflowX: 'visible',
                textOverflow: 'unset',
              }}
            >
              {logMessage}
            </Typography>
          </Box>
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
              '& .simplebar-track.simplebar-vertical .simplebar-scrollbar:before':
                {
                  backgroundColor: 'text.secondary',
                },
            },
          },
        }}
      >
        <Box sx={{ px: 2, py: 1, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="subtitle2">
            Notification History ({messageHistoryRef.current.length})
          </Typography>
        </Box>
        <SimpleBar
          style={{ maxHeight: 'calc(min(600px, 90vh) - 42px)', overflowX: 'hidden' }}
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
                  variant="caption"
                  sx={{
                    color: 'text.disabled',
                    mr: 1.5,
                    flexShrink: 0,
                    fontFamily: 'monospace',
                  }}
                >
                  {formatTime(entry.timestamp)}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{ color: 'text.secondary', wordBreak: 'break-word' }}
                >
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
