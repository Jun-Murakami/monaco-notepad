import { useEffect, useRef, useState } from 'react';
import { getMonaco, getOrCreateEditor, disposeEditor } from '../lib/monaco';
import type { editor } from 'monaco-editor';
import { EditorSettings } from '../types';
import { Box } from '@mui/material';
import { EditorStatusBar } from './EditorStatusBar';
import { Note } from '../types';

interface EditorProps {
  value?: string;
  onChange?: (value: string) => void;
  language?: string;
  settings: EditorSettings;
  currentNote: Note | null;
}

export const Editor: React.FC<EditorProps> = ({ value = '', onChange, language = 'plaintext', settings, currentNote }) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const editorInstanceRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [forceUpdate, setForceUpdate] = useState(0);

  // エディタの初期化
  useEffect(() => {
    if (!editorRef.current) return;

    editorInstanceRef.current = getOrCreateEditor(editorRef.current, {
      value,
      language,
      theme: settings.isDarkMode ? 'vs-dark' : 'vs',
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
      wordWrap: settings.wordWrap,
    });

    // イベントリスナーの設定
    const disposables = [
      editorInstanceRef.current.onDidChangeModelContent(() => {
        const currentValue = editorInstanceRef.current?.getValue();
        onChange?.(currentValue || '');
      }),
      editorInstanceRef.current.onDidChangeCursorPosition(() => {
        setForceUpdate((prev) => prev + 1);
      }),
      editorInstanceRef.current.onDidChangeCursorSelection(() => {
        setForceUpdate((prev) => prev + 1);
      }),
    ];

    return () => {
      disposables.forEach((d) => d.dispose());
      disposeEditor();
    };
  }, []); // 初期化は一度だけ

  // 言語変更時の処理
  useEffect(() => {
    if (!editorInstanceRef.current) return;

    const model = editorInstanceRef.current.getModel();
    if (!model) return;

    // モデルの言語を更新
    const monaco = getMonaco();
    monaco.editor.setModelLanguage(model, language);
  }, [language]);

  // 設定変更時の処理
  useEffect(() => {
    if (editorInstanceRef.current) {
      editorInstanceRef.current.updateOptions({
        theme: settings.isDarkMode ? 'vs-dark' : 'vs',
        fontFamily: settings.fontFamily,
        fontSize: settings.fontSize,
        wordWrap: settings.wordWrap,
        minimap: {
          enabled: settings.minimap,
        },
      });
    }
  }, [settings]);

  // 値の更新処理
  useEffect(() => {
    if (editorInstanceRef.current && value !== editorInstanceRef.current.getValue()) {
      editorInstanceRef.current.setValue(value);
    }
  }, [value]);

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ flexGrow: 1, minHeight: 0, position: 'relative' }}>
        <div ref={editorRef} style={{ width: '100%', height: '100%', position: 'absolute' }} />
      </Box>
      <EditorStatusBar editor={editorInstanceRef.current} currentNote={currentNote} key={forceUpdate} />
    </Box>
  );
};
