import { useEffect, useRef } from 'react';
import { getMonaco, getOrCreateEditor, disposeEditor } from '../lib/monaco';
import type { editor } from 'monaco-editor';
import { Settings } from '../types';
import { Box } from '@mui/material';
import { Note, FileNote } from '../types';

interface EditorProps {
  value?: string;
  onChange?: (value: string) => void;
  language?: string;
  settings: Settings;
  platform: string;
  currentNote: Note | FileNote | null;
  onEditorInstance?: (instance: editor.IStandaloneCodeEditor | null) => void;
  onNew?: () => void;
  onOpen?: () => void;
  onSave?: () => void;
  onSaveAs?: () => void;
  onClose?: () => void;
  onSelectNext?: () => Promise<void>;
  onSelectPrevious?: () => Promise<void>;
}

export const Editor: React.FC<EditorProps> = ({
  value = '',
  onChange,
  language = 'plaintext',
  settings,
  platform,
  currentNote,
  onEditorInstance,
  onNew,
  onOpen,
  onSave,
  onSaveAs,
  onClose,
  onSelectNext,
  onSelectPrevious,
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const editorInstanceRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  // エディタの初期化
  useEffect(() => {
    if (!editorRef.current) return;

    const monaco = getMonaco();

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
      wordWrap: settings.wordWrap === 'on' ? 'on' : 'off',
    });

    // エディタインスタンスを親コンポーネントに通知
    onEditorInstance?.(editorInstanceRef.current);

    return () => {
      disposeEditor();
    };
  }, []); // 初期化は一度だけ

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
  }, [onSave, onClose, onSelectNext, onSelectPrevious, platform]); // コマンドのコールバックが変更されたときのみ再登録

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
      disposables.forEach((d) => d.dispose());
    };
  }, [onChange, value]); // onChangeとvalueの変更時のみリスナーを更新

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
        wordWrap: settings.wordWrap === 'on' ? 'on' : 'off',
        minimap: {
          enabled: settings.minimap,
        },
      });
    }
  }, [settings]);

  // 値の更新処理
  useEffect(() => {
    if (!editorInstanceRef.current) return;

    if (value !== editorInstanceRef.current.getValue()) {
      editorInstanceRef.current.setValue(value);

      // エディタの内部状態を強制的に更新
      const position = editorInstanceRef.current.getPosition();
      if (position) {
        editorInstanceRef.current.setPosition(position);
        editorInstanceRef.current.revealPositionInCenter(position);
      }
    }
  }, [value]);

  // currentNoteが変更されたときの処理を追加
  useEffect(() => {
    if (!editorInstanceRef.current) return;

    // エディタの状態を強制的に更新
    const position = editorInstanceRef.current.getPosition();
    if (position) {
      editorInstanceRef.current.setPosition(position);
      editorInstanceRef.current.revealPositionInCenter(position);
    }
  }, [currentNote]);

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ flexGrow: 1, minHeight: 0, position: 'relative' }}>
        <div ref={editorRef} style={{ width: '100%', height: '100%', position: 'absolute' }} />
      </Box>
    </Box>
  );
};
