import { useCallback } from 'react';
import Editor, { type OnMount, type OnChange } from '@monaco-editor/react';
import { Box } from '@mui/material';
import type { editor } from 'monaco-editor';
import { monaco } from '../lib/monaco';
import type { Note, FileNote, Settings } from '../types';

interface EditorProps {
  value?: string;
  onChange?: (value: string) => void;
  language?: string;
  settings: Settings;
  platform: string;
  currentNote: Note | FileNote | null;
  onNew?: () => void;
  onOpen?: () => void;
  onSave?: () => void;
  onSaveAs?: () => void;
  onClose?: () => void;
  onSelectNext?: () => Promise<void>;
  onSelectPrevious?: () => Promise<void>;
}

export const MonacoEditor: React.FC<EditorProps> = ({
  value = '',
  onChange,
  language = 'plaintext',
  settings,
  platform,
  currentNote,
  onNew,
  onOpen,
  onSave,
  onSaveAs,
  onClose,
  onSelectNext,
  onSelectPrevious,
}) => {
  const handleEditorDidMount: OnMount = useCallback((editor: editor.IStandaloneCodeEditor) => {
    // キーボードコマンドの設定
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyN,
      () => onNew?.(),
      'editorTextFocus'
    );

    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO,
      () => onOpen?.(),
      'editorTextFocus'
    );

    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => onSave?.(),
      'editorTextFocus'
    );

    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Alt | monaco.KeyCode.KeyS,
      () => onSaveAs?.(),
      'editorTextFocus'
    );

    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW,
      () => onClose?.(),
      'editorTextFocus'
    );

    if (platform === 'darwin') {
      editor.addCommand(
        monaco.KeyMod.WinCtrl | monaco.KeyCode.Tab,
        async () => await onSelectNext?.(),
        'editorTextFocus'
      );
    } else {
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.Tab,
        async () => await onSelectNext?.(),
        'editorTextFocus'
      );
    }

    if (platform === 'darwin') {
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Tab,
        async () => await onSelectPrevious?.(),
        'editorTextFocus'
      );
    } else {
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Tab,
        async () => await onSelectPrevious?.(),
        'editorTextFocus'
      );
    }
  }, [onNew, onOpen, onSave, onSaveAs, onClose, onSelectNext, onSelectPrevious, platform]);

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ flexGrow: 1, minHeight: 0, position: 'relative' }}>
        <Editor
          height="100%"
          language={language}
          theme={settings.isDarkMode ? 'vs-dark' : 'vs'}
          options={{
            minimap: {
              enabled: settings.minimap,
            },
            renderWhitespace: 'all',
            renderValidationDecorations: 'off',
            unicodeHighlight: { allowedLocales: { _os: true, _vscode: true }, ambiguousCharacters: false },
            automaticLayout: true,
            contextmenu: true,
            fontFamily: settings.fontFamily,
            fontSize: settings.fontSize,
            renderLineHighlightOnlyWhenFocus: true,
            occurrencesHighlight: 'off',
            wordWrap: settings.wordWrap === 'on' ? 'on' : 'off',
          }}
          onMount={handleEditorDidMount}
          onChange={(value) => onChange?.(value ?? '')}
        />
      </Box>
    </Box>
  );
};
