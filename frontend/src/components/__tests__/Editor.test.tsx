import { render } from '@testing-library/react';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
import { createEditor, disposeEditorInstance, getMonaco } from '../../lib/monaco';
import type { Settings } from '../../types';
import { Editor } from '../Editor';

// lib/monacoのモック化をファイルの先頭で行う
let changeContentCallback: (() => void) | null = null;

// モックの実装をvi.mockの中で完全にインライン化
vi.mock('../../lib/monaco', () => {
  const mockEditor = {
    getValue: vi.fn(),
    setValue: vi.fn(),
    getPosition: vi.fn(),
    setPosition: vi.fn(),
    revealPositionInCenter: vi.fn(),
    getModel: vi.fn(),
    setModel: vi.fn(),
    onDidChangeModelContent: vi.fn((callback: () => void) => {
      changeContentCallback = callback;
      return { dispose: vi.fn() };
    }),
    onDidFocusEditorText: vi.fn(() => ({ dispose: vi.fn() })),
    addCommand: vi.fn(),
    updateOptions: vi.fn(),
    dispose: vi.fn(),
  };

  const mockMonaco = {
    editor: {
      setModelLanguage: vi.fn(),
      setTheme: vi.fn(),
      getModel: vi.fn(),
      createModel: vi.fn(),
    },
    KeyMod: {
      CtrlCmd: 2048,
      WinCtrl: 256,
      Shift: 1024,
      Alt: 512,
    },
    KeyCode: {
      KeyN: 46,
      KeyO: 47,
      KeyS: 48,
      KeyW: 49,
      Tab: 50,
      Alt: 51,
    },
    Uri: {
      parse: vi.fn(),
    },
  };

  return {
    getMonaco: vi.fn(() => mockMonaco),
    createEditor: vi.fn(() => mockEditor),
    disposeEditorInstance: vi.fn(),
    getThemePair: vi.fn((id: string) => {
      const pairs: Record<string, { id: string; label: string; light: string; dark: string }> = {
        default: { id: 'default', label: 'Default', light: 'vs', dark: 'vs-dark' },
      };
      return pairs[id] || pairs.default;
    }),
    THEME_PAIRS: [
      { id: 'default', label: 'Default', light: 'vs', dark: 'vs-dark' },
    ],
  };
});

type MockEditor = {
  getValue: Mock;
  setValue: Mock;
  getPosition: Mock;
  setPosition: Mock;
  revealPositionInCenter: Mock;
  getModel: Mock;
  setModel: Mock;
  onDidChangeModelContent: Mock;
  onDidFocusEditorText: Mock;
  addCommand: Mock;
  updateOptions: Mock;
  dispose: Mock;
};

type MockMonaco = {
  editor: {
    setModelLanguage: Mock;
    setTheme: Mock;
    getModel: Mock;
    createModel: Mock;
  };
  KeyMod: {
    CtrlCmd: number;
    WinCtrl: number;
    Shift: number;
    Alt: number;
  };
  KeyCode: {
    KeyN: number;
    KeyO: number;
    KeyS: number;
    KeyW: number;
    Tab: number;
    Alt: number;
  };
  Uri: {
    parse: Mock;
  };
};

// モック関数への参照を取得
const getMockFunctions = () => {
  const mockEditor = (createEditor as unknown as Mock<() => MockEditor>)();
  const mockMonaco = (getMonaco as unknown as Mock<() => MockMonaco>)();
  return {
    editor: mockEditor,
    monaco: mockMonaco,
  };
};

describe('Editor', () => {
	const mockSettings: Settings = {
		fontFamily: 'Test Font',
		fontSize: 14,
		isDarkMode: false,
		editorTheme: 'default',
		wordWrap: 'off',
		minimap: true,
		windowWidth: 800,
		windowHeight: 600,
		windowX: 0,
		windowY: 0,
		isMaximized: false,
		isDebug: false,
		markdownPreviewOnLeft: false,
	};

  const defaultProps = {
    editorInstanceRef: { current: null },
    value: 'Test Content',
    onChange: vi.fn(),
    language: 'typescript',
    settings: mockSettings,
    platform: 'win32',
    currentNote: {
      id: '1',
      title: 'Test Note',
      content: 'Test Content',
      contentHeader: null,
      language: 'typescript',
      modifiedTime: new Date().toISOString(),
      archived: false,
    },
    onNew: vi.fn(),
    onOpen: vi.fn(),
    onSave: vi.fn(),
    onSaveAs: vi.fn(),
    onClose: vi.fn(),
    onSelectNext: vi.fn(),
    onSelectPrevious: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    changeContentCallback = null;
  });

  it('エディタが正しく初期化されること', () => {
    render(<Editor {...defaultProps} />);

    expect(createEditor).toHaveBeenCalledWith(
      expect.any(HTMLDivElement),
      expect.objectContaining({
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
      }),
    );
  });

  it('設定変更が反映されること', () => {
    const { rerender } = render(<Editor {...defaultProps} />);
    const { editor, monaco } = getMockFunctions();

    // ダークモードに変更
    rerender(
      <Editor
        {...defaultProps}
        settings={{ ...mockSettings, isDarkMode: true }}
      />,
    );

    expect(monaco.editor.setTheme).toHaveBeenCalledWith('vs-dark');
    expect(editor.updateOptions).toHaveBeenCalled();
  });

  it('言語変更が反映されること', () => {
    const { rerender } = render(<Editor {...defaultProps} />);
    const { editor, monaco } = getMockFunctions();
    editor.getModel.mockReturnValue({});

    // 言語を変更
    rerender(<Editor {...defaultProps} language="javascript" />);

    expect(monaco.editor.setModelLanguage).toHaveBeenCalledWith(
      expect.any(Object),
      'javascript',
    );
  });

  it('Windowsでのキーボードショートカットが正しく設定されること', () => {
    render(<Editor {...defaultProps} platform="win32" />);
    const { editor, monaco } = getMockFunctions();

    // 基本的なショートカット
    expect(editor.addCommand).toHaveBeenCalledWith(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyN,
      expect.any(Function),
      'editorTextFocus',
    );

    expect(editor.addCommand).toHaveBeenCalledWith(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO,
      expect.any(Function),
      'editorTextFocus',
    );

    expect(editor.addCommand).toHaveBeenCalledWith(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      expect.any(Function),
      'editorTextFocus',
    );

    expect(editor.addCommand).toHaveBeenCalledWith(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Alt | monaco.KeyCode.KeyS,
      expect.any(Function),
      'editorTextFocus',
    );

    // Windows固有のショートカット
    expect(editor.addCommand).toHaveBeenCalledWith(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Tab,
      expect.any(Function),
      'editorTextFocus',
    );

    expect(editor.addCommand).toHaveBeenCalledWith(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Tab,
      expect.any(Function),
      'editorTextFocus',
    );
  });

  it('macOSでのキーボードショートカットが正しく設定されること', () => {
    render(<Editor {...defaultProps} platform="darwin" />);
    const { editor, monaco } = getMockFunctions();

    // 基本的なショートカット
    expect(editor.addCommand).toHaveBeenCalledWith(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyN,
      expect.any(Function),
      'editorTextFocus',
    );

    // macOS固有のショートカット
    expect(editor.addCommand).toHaveBeenCalledWith(
      monaco.KeyMod.WinCtrl | monaco.KeyCode.Tab,
      expect.any(Function),
      'editorTextFocus',
    );

    expect(editor.addCommand).toHaveBeenCalledWith(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Tab,
      expect.any(Function),
      'editorTextFocus',
    );
  });

  it('キーボードショートカットが正しく機能すること', async () => {
    render(<Editor {...defaultProps} />);
    const { editor, monaco } = getMockFunctions();

    // コマンドのコールバックを取得
    const calls = editor.addCommand.mock.calls;
    const newCallback = calls.find(
      (call) => call[0] === (monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyN),
    )?.[1];
    const saveCallback = calls.find(
      (call) => call[0] === (monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS),
    )?.[1];

    // コールバックを実行
    newCallback?.();
    expect(defaultProps.onNew).toHaveBeenCalled();

    saveCallback?.();
    expect(defaultProps.onSave).toHaveBeenCalled();
  });

  it('値の変更が親コンポーネントに通知されること', () => {
    render(<Editor {...defaultProps} />);
    const { editor } = getMockFunctions();

    // onDidChangeModelContentが呼び出されたことを確認
    expect(editor.onDidChangeModelContent).toHaveBeenCalled();
    expect(changeContentCallback).toBeDefined();

    // エディタの値が変更されたことをシミュレート
    editor.getValue.mockReturnValue('New Content');

    // 変更通知をシミュレート
    changeContentCallback?.();

    // 親コンポーネントのonChangeが新しい値で呼ばれたことを確認
    expect(defaultProps.onChange).toHaveBeenCalledWith('New Content');
  });

  it('新しい値が設定されたとき、エディタの内容が更新されること', () => {
    const { rerender } = render(<Editor {...defaultProps} />);
    const { editor, monaco } = getMockFunctions();
    const mockModel = {};

    // 初期状態のモックを設定
    editor.getValue.mockReturnValue('Old Content');
    editor.getModel.mockReturnValue(mockModel);
    monaco.editor.getModel.mockReturnValue(null); // 新しいモデルを作成させるためnullを返す
    monaco.Uri.parse.mockReturnValue('mockUri');

    // 新しい値で再レンダリング
    const newNote = {
      ...defaultProps.currentNote,
      content: 'New Content',
    };
    rerender(<Editor {...defaultProps} currentNote={newNote} />);

    // モデルが作成されることを確認
    expect(monaco.Uri.parse).toHaveBeenCalledWith(`inmemory://${newNote.id}`);
    expect(monaco.editor.createModel).toHaveBeenCalledWith(
      'New Content',
      'typescript',
      'mockUri',
    );
  });

  it('既存のモデルが再利用されること', () => {
    const { rerender } = render(<Editor {...defaultProps} />);
    const { editor, monaco } = getMockFunctions();
    const mockModel = {};

    // モックをリセット
    vi.clearAllMocks();

    // 既存のモデルをモック
    monaco.Uri.parse.mockReturnValue('mockUri');
    monaco.editor.getModel.mockReturnValue(mockModel);

    // currentNoteを変更して再レンダリング
    const newNote = {
      ...defaultProps.currentNote,
      id: '2',
      content: 'New Content',
    };
    rerender(<Editor {...defaultProps} currentNote={newNote} />);

    // 既存のモデルが見つかった場合は新しいモデルを作成しない
    expect(monaco.editor.createModel).not.toHaveBeenCalled();
    expect(editor.setModel).toHaveBeenCalledWith(mockModel);
  });

  it('コンポーネントのアンマウント時にエディタが破棄されること', () => {
    const { unmount } = render(<Editor {...defaultProps} />);
    unmount();
    expect(disposeEditorInstance).toHaveBeenCalled();
  });

  it('currentNoteが変更されたときにモデルが正しく設定されること', () => {
    const { rerender } = render(<Editor {...defaultProps} />);
    const { editor, monaco } = getMockFunctions();
    const mockModel = {};

    monaco.editor.getModel.mockReturnValue(null);
    monaco.editor.createModel.mockReturnValue(mockModel);
    monaco.Uri.parse.mockReturnValue('mockUri');

    // currentNoteを変更して再レンダリング
    const newNote = {
      ...defaultProps.currentNote,
      id: '2',
      content: 'New Content',
    };
    rerender(<Editor {...defaultProps} currentNote={newNote} />);

    expect(monaco.Uri.parse).toHaveBeenCalledWith('inmemory://2');
    expect(monaco.editor.createModel).toHaveBeenCalledWith(
      'New Content',
      'typescript',
      'mockUri',
    );
    expect(editor.setModel).toHaveBeenCalledWith(mockModel);
  });
});
