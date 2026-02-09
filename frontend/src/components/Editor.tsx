import { Box } from '@mui/material';
import type { editor } from 'monaco-editor';
import { useEffect, useRef } from 'react';
import {
  createEditor,
  disposeEditorInstance,
  getMonaco,
  getThemePair,
} from '../lib/monaco';
import type { FileNote, Note, Settings } from '../types';

interface EditorProps {
  editorInstanceRef: React.RefObject<editor.IStandaloneCodeEditor | null>;
  value?: string;
  onChange?: (value: string) => void;
  language?: string;
  settings: Settings;
  platform: string;
  currentNote: Note | FileNote | null;
  searchKeyword?: string;
  searchMatchIndexInNote?: number;
  onFocus?: () => void;
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
  searchKeyword,
  searchMatchIndexInNote = 0,
  onFocus,
  onNew,
  onOpen,
  onSave,
  onSaveAs,
  onClose,
  onSelectNext,
  onSelectPrevious,
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;

  useEffect(() => {
    if (!editorRef.current) return;

    const instance = createEditor(editorRef.current, {
      value: '',
      language: 'plaintext',
      theme: 'vs',
      minimap: {
        enabled: true,
      },
      renderWhitespace: 'all',
      renderValidationDecorations: 'off',
      unicodeHighlight: {
        allowedLocales: { _os: true, _vscode: true },
        ambiguousCharacters: false,
      },
      automaticLayout: true,
      contextmenu: true,
      fontFamily: 'Consolas',
      fontSize: 14,
      renderLineHighlightOnlyWhenFocus: true,
      occurrencesHighlight: 'off',
      wordWrap: 'off',
    });
    editorInstanceRef.current = instance;

    const focusDisposable = instance.onDidFocusEditorText(() => {
      onFocusRef.current?.();
    });

    return () => {
      focusDisposable.dispose();
      disposeEditorInstance(instance);
      editorInstanceRef.current = null;
    };
  }, [editorInstanceRef]);

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
        monaco.Uri.parse(modelUri),
      );
    }
    editorInstanceRef.current.setModel(model);
  }, [currentNote, editorInstanceRef]);

  const currentNoteId = currentNote?.id ?? null;

  // 検索キーワードをエディタ内でハイライト・選択（指定されたマッチインデックスを使用）
  useEffect(() => {
    if (!currentNoteId) return;
    const editor = editorInstanceRef.current;
    if (!editor) return;

    const model = editor.getModel();
    if (!model || !searchKeyword) return;

    const matches = model.findMatches(
      searchKeyword,
      true,
      false,
      false,
      null,
      true,
    );
    if (matches.length > 0) {
      const idx =
        searchMatchIndexInNote < matches.length ? searchMatchIndexInNote : 0;
      editor.setSelection(matches[idx].range);
      editor.revealRangeInCenter(matches[idx].range);
    }
  }, [searchKeyword, searchMatchIndexInNote, currentNoteId, editorInstanceRef]);

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
      const monaco = getMonaco();
      const pair = getThemePair(settings.editorTheme);
      const themeName = settings.isDarkMode ? pair.dark : pair.light;
      monaco.editor.setTheme(themeName);
      editorInstanceRef.current.updateOptions({
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
      'editorTextFocus',
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO,
      () => {
        onOpen?.();
      },
      'editorTextFocus',
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        onSave?.();
      },
      'editorTextFocus',
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Alt | monaco.KeyCode.KeyS,
      () => {
        onSaveAs?.();
      },
      'editorTextFocus',
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW,
      () => {
        onClose?.();
      },
      'editorTextFocus',
    );

    if (platform === 'darwin') {
      editorInstanceRef.current.addCommand(
        monaco.KeyMod.WinCtrl | monaco.KeyCode.Tab,
        async () => {
          await onSelectNext?.();
        },
        'editorTextFocus',
      );
    } else {
      editorInstanceRef.current.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.Tab,
        async () => {
          await onSelectNext?.();
        },
        'editorTextFocus',
      );
    }

    if (platform === 'darwin') {
      editorInstanceRef.current.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Tab,
        async () => {
          await onSelectPrevious?.();
        },
        'editorTextFocus',
      );
    } else {
      editorInstanceRef.current.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Tab,
        async () => {
          console.log('onSelectPrevious');
          await onSelectPrevious?.();
        },
        'editorTextFocus',
      );
    }
  }, [
    onNew,
    onOpen,
    onSave,
    onSaveAs,
    onClose,
    onSelectNext,
    onSelectPrevious,
    platform,
    editorInstanceRef,
  ]); // コマンドのコールバックが変更されたときのみ再登録

  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box sx={{ flexGrow: 1, minHeight: 0, position: 'relative' }}>
        <div
          ref={editorRef}
          style={{ width: '100%', height: '100%', position: 'absolute' }}
        />
      </Box>
    </Box>
  );
};
