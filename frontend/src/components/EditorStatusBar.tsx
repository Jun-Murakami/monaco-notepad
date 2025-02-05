import { useEffect, useState, useRef } from 'react';
import { Box, Typography, Divider } from '@mui/material';
import type { editor, IDisposable } from 'monaco-editor';
import { Note } from '../types';
import * as wailsRuntime from '../../wailsjs/runtime';

interface EditorStatusBarProps {
  editor: editor.IStandaloneCodeEditor | null;
  currentNote: Note | null;
}

export const EditorStatusBar = ({ editor, currentNote }: EditorStatusBarProps) => {
  const [logMessage, setLogMessage] = useState<string>('');
  const logTimeoutRef = useRef<number | null>(null);

  const getEditorInfo = () => {
    if (!editor) return [];

    const model = editor.getModel();
    if (!model) return [];

    const position = editor.getPosition();
    const selection = editor.getSelection();
    const lineCount = model.getLineCount();

    let info = [`Length: ${model.getValueLength()}`, `Lines: ${lineCount}`];

    if (selection && !selection.isEmpty()) {
      const start = `${selection.startLineNumber}.${selection.startColumn}`;
      const end = `${selection.endLineNumber}.${selection.endColumn}`;
      info.push(`Select: [ ${start} -> ${end} ]`);
    } else if (position) {
      info.push(`Cursor Position: [ Line ${position.lineNumber}, Col ${position.column} ]`);
    }

    return info;
  };

  const [info, setInfo] = useState<string[]>(getEditorInfo());

  useEffect(() => {
    setInfo(getEditorInfo());

    const disposables: IDisposable[] = [];

    if (editor) {
      disposables.push(
        editor.onDidChangeCursorPosition(() => {
          setInfo(getEditorInfo());
        }),
        editor.onDidChangeCursorSelection(() => {
          setInfo(getEditorInfo());
        }),
        editor.onDidChangeModelContent(() => {
          setInfo(getEditorInfo());
        })
      );
    }

    return () => {
      disposables.forEach((d) => d.dispose());
    };
  }, [editor, currentNote]);

  useEffect(() => {
    wailsRuntime.EventsOn('logMessage', (message: string) => {
      if (logTimeoutRef.current) {
        window.clearTimeout(logTimeoutRef.current);
      }

      setLogMessage(message);

      logTimeoutRef.current = window.setTimeout(() => {
        setLogMessage('');
      }, 10000);
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
        px: 4,
        height: 37.1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        bgcolor: (theme) => theme.palette.background.paper,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center' }}>
        <Typography variant='caption' component='div' sx={{ mx: 2, textAlign: 'right', color: 'text.secondary' }} noWrap>
          {logMessage}
        </Typography>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', width: 220 }}>
        <Divider orientation='vertical' flexItem />
        <Typography variant='caption' component='div' sx={{ mx: 2 }} noWrap>
          {info[0]}
        </Typography>
        <Typography variant='caption' component='div' sx={{ mx: 2 }} noWrap>
          {info[1]}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', width: 250 }}>
        <Divider orientation='vertical' flexItem />
        <Typography variant='caption' component='div' sx={{ mx: 2 }} noWrap>
          {info[2]}
        </Typography>
      </Box>
    </Box>
  );
};
