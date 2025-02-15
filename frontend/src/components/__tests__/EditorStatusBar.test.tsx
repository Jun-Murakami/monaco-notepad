import { render, screen, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom';
import { EditorStatusBar } from '../EditorStatusBar';
import * as runtime from '../../../wailsjs/runtime';
import type { editor } from 'monaco-editor';
import type { Mock } from 'vitest';

// runtimeのモック
vi.mock('../../../wailsjs/runtime', () => ({
  EventsOn: vi.fn(),
  EventsOff: vi.fn(),
}));

// VersionUpコンポーネントのモック
vi.mock('../VersionUp', () => ({
  VersionUp: () => <div data-testid='version-up'>Version Up Component</div>,
}));

describe('EditorStatusBar', () => {
  // モックエディタの作成
  const createMockEditor = () => {
    const model = {
      getValueLength: vi.fn().mockReturnValue(100),
      getLineCount: vi.fn().mockReturnValue(10),
    };

    const mockEditor = {
      getModel: vi.fn().mockReturnValue(model),
      getPosition: vi.fn().mockReturnValue({ lineNumber: 1, column: 1 }),
      getSelection: vi.fn().mockReturnValue({
        isEmpty: () => true,
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      }),
      onDidChangeCursorPosition: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      onDidChangeCursorSelection: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      onDidChangeModelContent: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    } as unknown as editor.IStandaloneCodeEditor;

    return mockEditor;
  };

  const mockNote = {
    id: '1',
    title: 'Test Note',
    content: 'Test Content',
    contentHeader: null,
    language: 'typescript',
    modifiedTime: new Date().toISOString(),
    archived: false,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('エディタの基本情報が正しく表示されること', () => {
    const mockEditor = createMockEditor();
    render(<EditorStatusBar editor={mockEditor} currentNote={mockNote} />);

    expect(screen.getByText('Length: 100')).toBeInTheDocument();
    expect(screen.getByText('Lines: 10')).toBeInTheDocument();
    expect(screen.getByText('Cursor Position: [ Line 1, Col 1 ]')).toBeInTheDocument();
  });

  it('選択範囲が正しく表示されること', () => {
    const mockEditor = createMockEditor();
    mockEditor.getSelection = vi.fn().mockReturnValue({
      isEmpty: () => false,
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 5,
    });

    render(<EditorStatusBar editor={mockEditor} currentNote={mockNote} />);
    expect(screen.getByText('Select: [ 1.1 -> 2.5 ]')).toBeInTheDocument();
  });

  it('エディタがnullの場合、情報が表示されないこと', () => {
    render(<EditorStatusBar editor={null} currentNote={mockNote} />);

    expect(screen.queryByText(/Length:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Lines:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cursor Position:/)).not.toBeInTheDocument();
  });

  it('ログメッセージが正しく表示され、フェードアウトすること', async () => {
    render(<EditorStatusBar editor={null} currentNote={mockNote} />);

    // ログメッセージイベントをシミュレート
    const eventCallback = (runtime.EventsOn as unknown as Mock).mock.calls[0][1];
    act(() => {
      eventCallback('Test log message');
    });

    // メッセージが表示されることを確認
    const logMessage = screen.getByText('Test log message');
    expect(logMessage).toBeInTheDocument();
    expect(logMessage).toHaveStyle({ opacity: 1 });

    // 8秒後にフェードアウトすることを確認
    act(() => {
      vi.advanceTimersByTime(8000);
    });

    expect(logMessage).toHaveStyle({ opacity: 0 });
  });

  it('コンポーネントのアンマウント時にイベントリスナーが解除されること', () => {
    const { unmount } = render(<EditorStatusBar editor={null} currentNote={mockNote} />);
    unmount();

    expect(runtime.EventsOff).toHaveBeenCalledWith('logMessage');
  });

  it('バージョンアップコンポーネントが表示されること', () => {
    render(<EditorStatusBar editor={null} currentNote={mockNote} />);
    expect(screen.getByTestId('version-up')).toBeInTheDocument();
  });
});
