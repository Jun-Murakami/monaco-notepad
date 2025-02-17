import { useEffect, useState, useRef, useCallback } from 'react';
import { useMonaco } from '@monaco-editor/react';
import { Box, Typography, Divider } from '@mui/material';
import type { IDisposable } from 'monaco-editor';
import { VersionUp } from './VersionUp';
import type{ Note, FileNote } from '../types';
import * as wailsRuntime from '../../wailsjs/runtime';

interface EditorStatusBarProps {
  currentNote: Note | FileNote | null;
}

export const EditorStatusBar = ({ currentNote }: EditorStatusBarProps) => {
  const [logMessage, setLogMessage] = useState<string>('');
  const [opacity, setOpacity] = useState<number>(1);
  const logTimeoutRef = useRef<number | null>(null);
  const [info, setInfo] = useState<string[]>(['Length: 0', 'Lines: 0', '']);

  const monaco = useMonaco();

  const getEditorInfo = useCallback(() => {
    if (!monaco) return ['Length: 0', 'Lines: 0', ''];

    try {
      const editor = monaco.editor.getEditors()[0];
      if (!editor) return ['Length: 0', 'Lines: 0', ''];

      const model = editor.getModel();
      if (!model) return ['Length: 0', 'Lines: 0', ''];

      const position = editor.getPosition();
      const selection = editor.getSelection();
      const lineCount = model.getLineCount();

      const info = [`Length: ${model.getValueLength()}`, `Lines: ${lineCount}`];

      if (selection && !selection.isEmpty()) {
        const start = `${selection.startLineNumber}.${selection.startColumn}`;
        const end = `${selection.endLineNumber}.${selection.endColumn}`;
        info.push(`Select: [ ${start} -> ${end} ]`);
      } else if (position) {
        info.push(`Cursor Position: [ Line ${position.lineNumber}, Col ${position.column} ]`);
      } else {
        info.push('');
      }

      return info;
    } catch (error) {
      console.error('Error getting editor info:', error);
      return ['Length: 0', 'Lines: 0', ''];
    }
  }, [monaco]);

  useEffect(() => {
    const updateInfo = () => {
      try {
        setInfo(getEditorInfo());
      } catch (error) {
        console.error('Error updating editor info:', error);
      }
    };

    const disposables: IDisposable[] = [];
    if (!monaco) return;

    try {
      const editor = monaco.editor.getEditors()[0];
      if (editor && currentNote) {
        disposables.push(
          editor.onDidChangeCursorPosition(updateInfo),
          editor.onDidChangeCursorSelection(updateInfo),
          editor.onDidChangeModelContent(updateInfo)
        );
        updateInfo();
      }
    } catch (error) {
      console.error('Error setting up editor listeners:', error);
    }

    return () => {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch (error) {
          console.error('Error disposing editor listener:', error);
        }
      }
    };
  }, [currentNote, getEditorInfo, monaco]);

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
