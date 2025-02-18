import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import '@testing-library/jest-dom';
import { Editor } from '../Editor';
import type { Settings } from '../../types';
import { getMonaco, getOrCreateEditor, disposeEditor } from '../../lib/monaco';

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
    onDidChangeModelContent: vi.fn((callback: () => void) => {
      changeContentCallback = callback;
      return { dispose: vi.fn() };
    }),
    addCommand: vi.fn(),
    updateOptions: vi.fn(),
  };

  const mockMonaco = {
    editor: {
      setModelLanguage: vi.fn(),
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
    },
  };

  return {
    getMonaco: vi.fn(() => mockMonaco),
    getOrCreateEditor: vi.fn(() => mockEditor),
    disposeEditor: vi.fn(),
  };
});

type MockEditor = {
  getValue: Mock;
  setValue: Mock;
  getPosition: Mock;
  setPosition: Mock;
  revealPositionInCenter: Mock;
  getModel: Mock;
  onDidChangeModelContent: Mock;
  addCommand: Mock;
  updateOptions: Mock;
};

type MockMonaco = {
  editor: {
    setModelLanguage: Mock;
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
  };
};

// モック関数への参照を取得
const getMockFunctions = () => {
  const mockEditor = (getOrCreateEditor as unknown as Mock<() => MockEditor>)();
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
    wordWrap: 'off',
    minimap: true,
    windowWidth: 800,
    windowHeight: 600,
    windowX: 0,
    windowY: 0,
    isMaximized: false,
    isDebug: false,
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

    expect(getOrCreateEditor).toHaveBeenCalledWith(
      expect.any(HTMLDivElement),
      expect.objectContaining({
        value: 'Test Content',
        language: 'typescript',
        theme: 'vs',
        fontFamily: 'Test Font',
        fontSize: 14,
      })
    );
  });

  it('設定変更が反映されること', () => {
    const { rerender } = render(<Editor {...defaultProps} />);
    const { editor } = getMockFunctions();

    // ダークモードに変更
    rerender(<Editor {...defaultProps} settings={{ ...mockSettings, isDarkMode: true }} />);

    expect(editor.updateOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: 'vs-dark',
      })
    );
  });

  it('言語変更が反映されること', () => {
    const { rerender } = render(<Editor {...defaultProps} />);
    const { editor, monaco } = getMockFunctions();
    editor.getModel.mockReturnValue({});

    // 言語を変更
    rerender(<Editor {...defaultProps} language='javascript' />);

    expect(monaco.editor.setModelLanguage).toHaveBeenCalledWith(expect.any(Object), 'javascript');
  });

  it('キーボードショートカットが正しく設定されること', () => {
    render(<Editor {...defaultProps} />);
    const { editor, monaco } = getMockFunctions();

    // 各コマンドが登録されていることを確認
    expect(editor.addCommand).toHaveBeenCalledWith(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyN,
      expect.any(Function),
      'editorTextFocus'
    );

    expect(editor.addCommand).toHaveBeenCalledWith(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      expect.any(Function),
      'editorTextFocus'
    );
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
    const { editor } = getMockFunctions();

    editor.getValue.mockReturnValue('Old Content');
    editor.getPosition.mockReturnValue({ lineNumber: 1, column: 1 });

    // 新しい値で再レンダリング
    rerender(<Editor {...defaultProps} value='New Content' />);

    expect(editor.setValue).toHaveBeenCalledWith('New Content');
    expect(editor.setPosition).toHaveBeenCalled();
    expect(editor.revealPositionInCenter).toHaveBeenCalled();
  });

  it('コンポーネントのアンマウント時にエディタが破棄されること', () => {
    const { unmount } = render(<Editor {...defaultProps} />);
    unmount();
    expect(disposeEditor).toHaveBeenCalled();
  });
});
