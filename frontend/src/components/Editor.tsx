import { useEffect, useRef } from 'react';
import { getMonaco, getOrCreateEditor, disposeEditor } from '../lib/monaco';
import type { editor } from 'monaco-editor';
import type { Settings } from '../types';
import type { Note, FileNote } from '../types';
import { Box } from '@mui/material';

interface EditorProps {
  editorInstanceRef: React.RefObject<editor.IStandaloneCodeEditor | null>;
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

export const Editor: React.FC<EditorProps> = ({
  editorInstanceRef,
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
  const editorRef = useRef<HTMLDivElement>(null);

  // エディタの初期化
  useEffect(() => {
    if (!editorRef.current) return;

    editorInstanceRef.current = getOrCreateEditor(editorRef.current, {
      value: '',
      language: 'plaintext',
      theme: 'vs',
      minimap: {
        enabled: true,
      },
      renderWhitespace: 'all',
      renderValidationDecorations: 'off',
      unicodeHighlight: { allowedLocales: { _os: true, _vscode: true }, ambiguousCharacters: false },
      automaticLayout: true,
      contextmenu: true,
      fontFamily: 'Consolas',
      fontSize: 14,
      renderLineHighlightOnlyWhenFocus: true,
      occurrencesHighlight: 'off',
      wordWrap: 'off',
    });

    return () => {
      disposeEditor();
    };
  }, [editorInstanceRef]); // 初期化は一度だけ

    // イベントリスナーの設定
  useEffect(() => {
    if (!editorInstanceRef.current) return;

    const disposables = [
      editorInstanceRef.current.onDidChangeModelContent(() => {
        const currentValue = editorInstanceRef.current?.getValue();
        if (currentValue !== value) {
          // 値が実際に変更された場合のみ通知
          onChange?.(currentValue || '');
        }
      }),
    ];

    return () => {
      for (const d of disposables) {
        d.dispose();
      }
    };
  }, [onChange, value, editorInstanceRef]); // onChangeとvalueの変更時のみリスナーを更新

  // currentNoteが変更されたときの処理を追加
  useEffect(() => {
    if (!editorInstanceRef.current || !currentNote) return;

    const monaco = getMonaco();
    const modelUri = `inmemory://${currentNote.id}`;
    let model = monaco.editor.getModel(monaco.Uri.parse(modelUri));

    if (!model) {
      // モデルが存在しない場合は新規作成
      model = monaco.editor.createModel(
        currentNote.content || '',
        currentNote.language,
        monaco.Uri.parse(modelUri)
      );
    }
    editorInstanceRef.current.setModel(model);

  }, [currentNote, editorInstanceRef]);

  // 言語変更時の処理
  useEffect(() => {
    if (!editorInstanceRef.current) return;

    const model = editorInstanceRef.current.getModel();
    if (!model) return;

    // モデルの言語を更新
    const monaco = getMonaco();
    monaco.editor.setModelLanguage(model, language);
  }, [language, editorInstanceRef]);

  // 設定変更時の処理
  useEffect(() => {
    if (editorInstanceRef.current) {
      editorInstanceRef.current.updateOptions({
        theme: settings.isDarkMode ? 'vs-dark' : 'vs',
        fontFamily: settings.fontFamily,
        fontSize: settings.fontSize,
        wordWrap: settings.wordWrap === 'on' ? 'on' : 'off',
        minimap: {
          enabled: settings.minimap,
        },
      });
    }
  }, [settings, editorInstanceRef]);

  // キーボードコマンドの設定
  useEffect(() => {
    if (!editorInstanceRef.current) return;

    const monaco = getMonaco();

    // カスタムコマンドの登録
    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyN,
      () => {
        onNew?.();
      },
      'editorTextFocus'
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO,
      () => {
        onOpen?.();
      },
      'editorTextFocus'
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        onSave?.();
      },
      'editorTextFocus'
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Alt | monaco.KeyCode.KeyS,
      () => {
        onSaveAs?.();
      },
      'editorTextFocus'
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW,
      () => {
        onClose?.();
      },
      'editorTextFocus'
    );

    if (platform === 'darwin') {
      editorInstanceRef.current.addCommand(
        monaco.KeyMod.WinCtrl | monaco.KeyCode.Tab,
        async () => {
          await onSelectNext?.();
        },
        'editorTextFocus'
      );
    } else {
      editorInstanceRef.current.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.Tab,
        async () => {
          await onSelectNext?.();
        },
        'editorTextFocus'
      );
    }

    if (platform === 'darwin') {
      editorInstanceRef.current.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Tab,
        async () => {
          await onSelectPrevious?.();
        },
        'editorTextFocus'
      );
    } else {
      editorInstanceRef.current.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Tab,
        async () => {
          console.log('onSelectPrevious');
          await onSelectPrevious?.();
        },
        'editorTextFocus'
      );
    }
  }, [onNew, onOpen, onSave, onSaveAs, onClose, onSelectNext, onSelectPrevious, platform, editorInstanceRef]); // コマンドのコールバックが変更されたときのみ再登録

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ flexGrow: 1, minHeight: 0, position: 'relative' }}>
        <div ref={editorRef} style={{ width: '100%', height: '100%', position: 'absolute' }} />
      </Box>
    </Box>
  );
};
