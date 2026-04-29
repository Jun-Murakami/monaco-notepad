import { useEffect, useEffectEvent, useRef } from 'react';
import { Box } from '@mui/material';

import {
  createEditor,
  disposeEditorInstance,
  getMonaco,
  getThemePair,
} from '../lib/monaco';
import {
  registerEditorRef,
  unregisterEditorRef,
  useEditorSettingsStore,
} from '../stores/useEditorSettingsStore';
import { DEFAULT_EDITOR_FONT_FAMILY, type FileNote, type Note } from '../types';

import type { editor } from 'monaco-editor';

interface EditorProps {
  paneId: string;
  editorInstanceRef: React.RefObject<editor.IStandaloneCodeEditor | null>;
  onChange?: (value: string) => void;
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
  // アプリ統合の検索・置換パネルを開く
  onOpenFind?: () => void;
  onOpenReplace?: () => void;
  onOpenFindInAll?: () => void;
}

export const Editor: React.FC<EditorProps> = ({
  paneId,
  editorInstanceRef,
  onChange,
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
  onOpenFind,
  onOpenReplace,
  onOpenFindInAll,
}) => {
  const settings = useEditorSettingsStore((s) => s.settings);
  const editorRef = useRef<HTMLDivElement>(null);

  // useEffectEvent経由でコールバックを参照し、リスナーの再登録を防止
  const onFocusEvent = useEffectEvent(() => onFocus?.());
  const onChangeEvent = useEffectEvent((value: string) =>
    onChange?.(value || ''),
  );
  const onNewEvent = useEffectEvent(() => onNew?.());
  const onOpenEvent = useEffectEvent(() => onOpen?.());
  const onSaveEvent = useEffectEvent(() => onSave?.());
  const onSaveAsEvent = useEffectEvent(() => onSaveAs?.());
  const onCloseEvent = useEffectEvent(() => onClose?.());
  const onSelectNextEvent = useEffectEvent(async () => {
    await onSelectNext?.();
  });
  const onSelectPreviousEvent = useEffectEvent(async () => {
    await onSelectPrevious?.();
  });
  const onOpenFindEvent = useEffectEvent(() => onOpenFind?.());
  const onOpenReplaceEvent = useEffectEvent(() => onOpenReplace?.());
  const onOpenFindInAllEvent = useEffectEvent(() => onOpenFindInAll?.());

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
      fontFamily: DEFAULT_EDITOR_FONT_FAMILY,
      fontSize: 14,
      renderLineHighlightOnlyWhenFocus: true,
      occurrencesHighlight: 'off',
      wordWrap: 'off',
    });
    editorInstanceRef.current = instance;

    // ストアにエディタインスタンスを登録（ハンドラからのMonaco同期用）
    registerEditorRef(paneId, editorInstanceRef);

    // monaco.editor.create() の theme オプションはグローバルテーマを上書きするため、
    // 再マウント時 (例: アーカイブページからの復帰) にユーザー設定のテーマを再適用する
    const pair = getThemePair(settings.editorTheme);
    getMonaco().editor.setTheme(settings.isDarkMode ? pair.dark : pair.light);

    const focusDisposable = instance.onDidFocusEditorText(() => {
      onFocusEvent();
    });

    const contentDisposable = instance.onDidChangeModelContent(() => {
      const currentValue = instance.getValue();
      onChangeEvent(currentValue);
    });

    return () => {
      unregisterEditorRef(paneId);
      focusDisposable.dispose();
      contentDisposable.dispose();
      disposeEditorInstance(instance);
      editorInstanceRef.current = null;
    };
  }, [paneId, editorInstanceRef]);

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

  // 【削除済み】settings → Monaco sync useEffect: applySettingsToAllEditors() がハンドラから直接呼ばれるため不要
  // 【削除済み】language → Monaco sync useEffect: applyLanguageToEditor() がハンドラから直接呼ばれるため不要

  // キーボードコマンドの設定（一度だけ登録、useEffectEvent経由で最新コールバックを参照）
  useEffect(() => {
    if (!editorInstanceRef.current) return;

    const monaco = getMonaco();

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyN,
      () => {
        onNewEvent();
      },
      'editorTextFocus',
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO,
      () => {
        onOpenEvent();
      },
      'editorTextFocus',
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        onSaveEvent();
      },
      'editorTextFocus',
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Alt | monaco.KeyCode.KeyS,
      () => {
        onSaveAsEvent();
      },
      'editorTextFocus',
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW,
      () => {
        onCloseEvent();
      },
      'editorTextFocus',
    );

    // Monaco 標準の検索ウィジェットを抑制し、アプリ統合のパネルを開く
    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF,
      () => {
        onOpenFindEvent();
      },
      'editorTextFocus',
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH,
      () => {
        onOpenReplaceEvent();
      },
      'editorTextFocus',
    );

    editorInstanceRef.current.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
      () => {
        onOpenFindInAllEvent();
      },
      'editorTextFocus',
    );

    if (platform === 'darwin') {
      editorInstanceRef.current.addCommand(
        monaco.KeyMod.WinCtrl | monaco.KeyCode.Tab,
        async () => {
          await onSelectNextEvent();
        },
        'editorTextFocus',
      );
    } else {
      editorInstanceRef.current.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.Tab,
        async () => {
          await onSelectNextEvent();
        },
        'editorTextFocus',
      );
    }

    if (platform === 'darwin') {
      editorInstanceRef.current.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Tab,
        async () => {
          await onSelectPreviousEvent();
        },
        'editorTextFocus',
      );
    } else {
      editorInstanceRef.current.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Tab,
        async () => {
          await onSelectPreviousEvent();
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
        '& .monaco-editor .unicode-highlight': {
          border: settings.isDarkMode
            ? '1px solid rgba(255, 214, 102, 0.05)'
            : '1px solid rgba(255, 193, 7, 0.05)',
          backgroundColor: settings.isDarkMode
            ? 'rgba(255, 214, 102, 0.03)'
            : 'rgba(255, 193, 7, 0.03)',
          boxSizing: 'border-box',
        },
        '& .monaco-editor .monaco-hover': {
          fontFamily: settings.fontFamily,
        },
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
