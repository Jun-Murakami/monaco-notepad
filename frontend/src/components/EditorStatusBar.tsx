import { useEffect, useState, useRef, useCallback } from 'react';
import { Box, Typography, Divider } from '@mui/material';
import type { editor, IDisposable } from 'monaco-editor';
import { VersionUp } from './VersionUp';
import type { Note, FileNote } from '../types';
import * as wailsRuntime from '../../wailsjs/runtime';

interface EditorStatusBarProps {
  editorInstanceRef: React.RefObject<editor.IStandaloneCodeEditor | null>;
  currentNote: Note | FileNote | null;
}

export const EditorStatusBar = ({ editorInstanceRef, currentNote }: EditorStatusBarProps) => {
  const [logMessage, setLogMessage] = useState<string>('');
  const [opacity, setOpacity] = useState<number>(1);
  const logTimeoutRef = useRef<number | null>(null);

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
        })
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
        <Typography variant='caption' component='div' sx={{ mx: 2 }} noWrap>
          {info[0]}
        </Typography>
        <Typography variant='caption' component='div' sx={{ mx: 2 }} noWrap>
          {info[1]}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', textAlign: 'left', width: 280 }}>
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
        <Typography
          variant='caption'
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
    </Box>
  );
};
