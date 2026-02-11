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

  // コールバックをrefで保持し、リスナーの再登録を防止
  const onFocusRef = useRef(onFocus);
  const onChangeRef = useRef(onChange);
  const onNewRef = useRef(onNew);
  const onOpenRef = useRef(onOpen);
  const onSaveRef = useRef(onSave);
  const onSaveAsRef = useRef(onSaveAs);
  const onCloseRef = useRef(onClose);
  const onSelectNextRef = useRef(onSelectNext);
  const onSelectPreviousRef = useRef(onSelectPrevious);
  onFocusRef.current = onFocus;
  onChangeRef.current = onChange;
  onNewRef.current = onNew;
  onOpenRef.current = onOpen;
  onSaveRef.current = onSave;
  onSaveAsRef.current = onSaveAs;
  onCloseRef.current = onClose;
  onSelectNextRef.current = onSelectNext;
  onSelectPreviousRef.current = onSelectPrevious;

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

    const contentDisposable = instance.onDidChangeModelContent(() => {
      const currentValue = instance.getValue();
      onChangeRef.current?.(currentValue || '');
    });

    return () => {
      focusDisposable.dispose();
      contentDisposable.dispose();
      disposeEditorInstance(instance);
      editorInstanceRef.current = null;
    };
  }, [editorInstanceRef]);

  const currentNoteRef = useRef(currentNote);
  currentNoteRef.current = currentNote;
  const currentNoteId = currentNote?.id ?? null;

  // ノートIDが変わったときだけモデルを切り替え（同一ノート内の編集ではsetValueしない）
  useEffect(() => {
    if (!editorInstanceRef.current || !currentNoteId || !currentNoteRef.current)
      return;

    const note = currentNoteRef.current;
    const monaco = getMonaco();
    const modelUri = `inmemory://${currentNoteId}`;
    let model = monaco.editor.getModel(monaco.Uri.parse(modelUri));

    if (!model) {
      model = monaco.editor.createModel(
        note.content || '',
        note.language,
        monaco.Uri.parse(modelUri),
      );
    } else {
      const nextValue = note.content || '';
      if (model.getValue() !== nextValue) {
        model.setValue(nextValue);
      }
    }
    editorInstanceRef.current.setModel(model);
  }, [currentNoteId, editorInstanceRef]);

  // 外部からのコンテンツ更新（Cloud sync等）をエディタモデルに反映
  // pendingContentRef設計により、ユーザーのタイピングはcurrentNote.contentを変更しないため、
  // stateのcontentが変わる＝外部更新と安全に判別できる
  const currentNoteContent = currentNote?.content ?? '';
  useEffect(() => {
    if (!editorInstanceRef.current || !currentNoteId) return;
    const model = editorInstanceRef.current.getModel();
    if (!model) return;
    if (model.getValue() !== currentNoteContent) {
      model.setValue(currentNoteContent);
    }
  }, [currentNoteContent, currentNoteId, editorInstanceRef]);

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

  useEffect(() => {
    if (!editorInstanceRef.current) return;

    const model = editorInstanceRef.current.getModel();
    if (!model) return;

    const monaco = getMonaco();
    monaco.editor.setModelLanguage(model, language);
  }, [language, editorInstanceRef]);

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

  // キーボードコマンドの設定（一度だけ登録、ref経由で最新コールバックを参照）
  useEffect(() => {
    if (!editorInstanceRef.current) return;

    const monaco = getMonaco();

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyN,
      () => {
        onNewRef.current?.();
      },
      'editorTextFocus',
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO,
      () => {
        onOpenRef.current?.();
      },
      'editorTextFocus',
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        onSaveRef.current?.();
      },
      'editorTextFocus',
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Alt | monaco.KeyCode.KeyS,
      () => {
        onSaveAsRef.current?.();
      },
      'editorTextFocus',
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW,
      () => {
        onCloseRef.current?.();
      },
      'editorTextFocus',
    );

    if (platform === 'darwin') {
      editorInstanceRef.current.addCommand(
        monaco.KeyMod.WinCtrl | monaco.KeyCode.Tab,
        async () => {
          await onSelectNextRef.current?.();
        },
        'editorTextFocus',
      );
    } else {
      editorInstanceRef.current.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.Tab,
        async () => {
          await onSelectNextRef.current?.();
        },
        'editorTextFocus',
      );
    }

    if (platform === 'darwin') {
      editorInstanceRef.current.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Tab,
        async () => {
          await onSelectPreviousRef.current?.();
        },
        'editorTextFocus',
      );
    } else {
      editorInstanceRef.current.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Tab,
        async () => {
          await onSelectPreviousRef.current?.();
        },
        'editorTextFocus',
      );
    }
  }, [platform, editorInstanceRef]);

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
