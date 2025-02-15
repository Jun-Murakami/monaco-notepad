import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach, type Mock } from 'vitest';
import '@testing-library/jest-dom';
import App from '../../App';
import { ListNotes, LoadArchivedNote, SaveNote } from '../../../wailsjs/go/backend/App';
import * as runtime from '../../../wailsjs/runtime';
import type { Note, FileNote } from '../../types';

// monaco-editorのモック
vi.mock('monaco-editor', () => ({
  default: {},
  languages: {
    getLanguages: () => [
      { id: 'plaintext', extensions: ['.txt'], aliases: ['Plain Text'] },
      { id: 'markdown', extensions: ['.md'], aliases: ['Markdown'] },
    ],
    typescript: {
      typescriptDefaults: {
        setEagerModelSync: () => {},
      },
    },
  },
  editor: {
    create: () => ({
      dispose: () => {},
      getModel: () => ({ isDisposed: () => false }),
      updateOptions: () => {},
    }),
    setTheme: () => Promise.resolve(),
    onDidCreateEditor: () => ({ dispose: () => {} }),
  },
}));

// monaco-editorのワーカーモジュールをモック
vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({ default: {} }));
vi.mock('monaco-editor/esm/vs/language/json/json.worker?worker', () => ({ default: {} }));
vi.mock('monaco-editor/esm/vs/language/css/css.worker?worker', () => ({ default: {} }));
vi.mock('monaco-editor/esm/vs/language/html/html.worker?worker', () => ({ default: {} }));
vi.mock('monaco-editor/esm/vs/language/typescript/ts.worker?worker', () => ({ default: {} }));

// monaco.tsのモック
vi.mock('../../lib/monaco', () => {
  const mockMonaco = {
    languages: {
      getLanguages: () => [],
      typescript: {
        typescriptDefaults: {
          setEagerModelSync: () => {},
        },
      },
    },
    editor: {
      create: () => ({
        dispose: () => {},
        getModel: () => ({ isDisposed: () => false }),
        updateOptions: () => {},
      }),
      setTheme: () => Promise.resolve(),
      onDidCreateEditor: () => ({ dispose: () => {} }),
    },
  };

  return {
    getMonaco: () => mockMonaco,
    getOrCreateEditor: () => mockMonaco.editor.create(),
    disposeEditor: () => {},
    getSupportedLanguages: () => [],
    getLanguageByExtension: () => null,
    getExtensionByLanguage: () => null,
    monaco: mockMonaco,
  };
});

// MonacoEditorコンポーネントをモック
vi.mock('../../components/Editor', () => ({
  Editor: ({
    value = '',
    onChange,
    settings = {
      fontFamily: 'Test Font',
      fontSize: 14,
      isDarkMode: false,
      wordWrap: 'off',
      minimap: true,
    },
    platform = 'win32',
    currentNote = null,
  }: {
    value?: string;
    onChange?: (value: string) => void;
    settings?: {
      fontFamily: string;
      fontSize: number;
      isDarkMode: boolean;
      wordWrap: string;
      minimap: boolean;
    };
    platform?: string;
    currentNote?: Note | FileNote | null;
  }) => (
    <div data-testid='mock-editor'>
      <input type='text' value={value} onChange={(e) => onChange?.(e.target.value)} data-testid='mock-editor-input' />
    </div>
  ),
}));

// ランタイムイベントのモック
vi.mock('../../../wailsjs/runtime', () => ({
  EventsOn: vi.fn().mockReturnValue(() => {}),
  EventsOff: vi.fn(),
  OnFileDrop: vi.fn(),
  OnFileDropOff: vi.fn(),
  Environment: vi.fn().mockReturnValue({
    platform: 'win32',
    arch: 'x64',
  }),
  WindowSetPosition: vi.fn(),
  WindowGetPosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
  WindowSetSize: vi.fn(),
  WindowGetSize: vi.fn().mockResolvedValue({ w: 800, h: 600 }),
  WindowMaximise: vi.fn(),
  WindowUnmaximise: vi.fn(),
  WindowIsMaximised: vi.fn().mockResolvedValue(false),
}));

// バックエンドAPIのモック
vi.mock('../../../wailsjs/go/backend/App', () => ({
  ListNotes: vi.fn(),
  LoadArchivedNote: vi.fn(),
  LoadFileNotes: vi.fn().mockResolvedValue([]),
  SaveNote: vi.fn(),
  SelectFile: vi.fn(),
  OpenFile: vi.fn(),
  SaveFile: vi.fn(),
  SelectSaveFileUri: vi.fn(),
  GetModifiedTime: vi.fn(),
  GetSettings: vi.fn().mockResolvedValue({
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
  }),
  SaveSettings: vi.fn(),
  GetVersion: vi.fn().mockResolvedValue('1.0.0'),
  DestroyApp: vi.fn(),
  CheckDriveConnection: vi.fn().mockResolvedValue(false),
  Console: vi.fn(),
  LoadSettings: vi.fn().mockResolvedValue({
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
  }),
  Environment: vi.fn().mockResolvedValue({
    platform: 'win32',
    arch: 'x64',
  }),
}));

describe('App', () => {
  const mockNote: Note = {
    id: '1',
    title: 'Test Note',
    content: 'Test Content',
    contentHeader: null,
    language: 'plaintext',
    modifiedTime: new Date().toISOString(),
    archived: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (ListNotes as Mock).mockResolvedValue([mockNote]);
  });

  describe('基本的なアプリケーション機能', () => {
    it('アプリケーションが正しく初期化されること', async () => {
      render(<App />);

      await waitFor(() => {
        expect(screen.getByText('Test Note')).toBeInTheDocument();
      });

      expect(ListNotes).toHaveBeenCalled();
    });

    it('新規ノートの作成が正しく機能すること', async () => {
      render(<App />);

      // 新規ノートボタンをクリック
      const newNoteButton = await screen.findByLabelText('New (Ctrl + N)');
      fireEvent.click(newNoteButton);

      await waitFor(() => {
        expect(SaveNote).toHaveBeenCalledWith(
          expect.objectContaining({
            title: '',
            content: '',
            language: 'plaintext',
            archived: false,
          }),
          'create'
        );
      });
    });

    it('ノートの選択が正しく機能すること', async () => {
      const anotherNote: Note = {
        ...mockNote,
        id: '2',
        title: 'Another Note',
      };
      (ListNotes as Mock).mockResolvedValue([mockNote, anotherNote]);

      render(<App />);

      // 別のノートを選択
      const noteItem = await screen.findByText('Another Note');
      fireEvent.click(noteItem);

      await waitFor(() => {
        expect(screen.getByDisplayValue('Another Note')).toBeInTheDocument();
      });
    });
  });

  describe('ノートの編集と保存', () => {
    it('ノートの内容変更が正しく保存されること', async () => {
      render(<App />);

      // エディタの内容を変更
      const editor = await screen.findByTestId('mock-editor-input');
      fireEvent.change(editor, { target: { value: 'Updated content' } });

      // 自動保存の待機
      await waitFor(
        () => {
          expect(SaveNote).toHaveBeenCalledWith(
            expect.objectContaining({
              content: 'Updated content',
            }),
            'update'
          );
        },
        { timeout: 3500 }
      );
    });

    it('ノートのタイトル変更が正しく保存されること', async () => {
      render(<App />);

      // タイトルを変更
      const titleInput = await screen.findByDisplayValue('Test Note');
      fireEvent.change(titleInput, { target: { value: 'Updated Title' } });

      // 自動保存の待機
      await waitFor(
        () => {
          expect(SaveNote).toHaveBeenCalledWith(
            expect.objectContaining({
              title: 'Updated Title',
            }),
            'update'
          );
        },
        { timeout: 3500 }
      );
    });
  });

  describe('アーカイブ機能', () => {
    it('ノートのアーカイブと復元が正しく機能すること', async () => {
      render(<App />);

      // ノートが表示されるまで待機
      await waitFor(() => {
        expect(screen.getByText('Test Note')).toBeInTheDocument();
      });

      // ノートリストのアイテムを見つける
      const noteListItem = screen.getByText('Test Note').closest('.MuiBox-root');
      expect(noteListItem).toBeInTheDocument();

      // ノートを選択
      fireEvent.click(noteListItem as HTMLElement);

      // ノートリストのアイテムにホバー
      fireEvent.mouseEnter(noteListItem as HTMLElement);

      // アーカイブボタンを見つけて表示させる
      const archiveButton = await screen.findByRole('button', { name: 'Archive (Ctrl + W)' });
      expect(archiveButton).toBeInTheDocument();
      fireEvent.mouseEnter(archiveButton);
      fireEvent.click(archiveButton);

      // アーカイブ時のSaveNoteの呼び出しを確認
      await waitFor(() => {
        expect(SaveNote).toHaveBeenCalledWith(
          expect.objectContaining({
            archived: true,
          }),
          'update'
        );
      });

      // アーカイブページに切り替え
      const archivePageButton = screen.getByText(/Archives/);
      fireEvent.click(archivePageButton);

      // アーカイブからの復元
      const unarchiveButton = await screen.findByLabelText('Unarchive');

      // LoadArchivedNoteのモック結果を設定
      (LoadArchivedNote as Mock).mockResolvedValue({
        id: '1',
        title: 'Test Note',
        content: 'Test Content',
        archived: true,
      });

      // アンアーカイブボタンをクリック
      fireEvent.click(unarchiveButton);

      // LoadArchivedNoteが呼ばれることを確認
      await waitFor(() => {
        expect(LoadArchivedNote).toHaveBeenCalledWith('1');
      });

      // アーカイブ解除時のSaveNoteの呼び出しを確認
      await waitFor(() => {
        const calls = (SaveNote as Mock).mock.calls;
        const unarchiveCall = calls.find(
          (call: unknown[]) =>
            call[0] &&
            typeof call[0] === 'object' &&
            'archived' in call[0] &&
            'id' in call[0] &&
            call[0].archived === false &&
            call[0].id === '1' &&
            call[1] === 'update'
        );
        expect(unarchiveCall).toBeTruthy();
      });
    });
  });

  describe('イベントハンドリング', () => {
    it('notes:reloadイベントでノートリストが更新されること', async () => {
      render(<App />);

      const updatedNote = { ...mockNote, title: 'Updated via reload' };
      (ListNotes as Mock).mockResolvedValue([updatedNote]);

      // notes:reloadイベントをシミュレート
      const reloadCallback = ((runtime.EventsOn as Mock).mock.calls.find((call: unknown[]) => call[0] === 'notes:reload') ??
        [])[1];

      await act(async () => {
        await reloadCallback();
      });

      await waitFor(() => {
        expect(screen.getByText('Updated via reload')).toBeInTheDocument();
      });
    });

    it('app:beforecloseイベントで変更が保存されること', async () => {
      render(<App />);

      // エディタの内容を変更
      const editor = await screen.findByTestId('mock-editor-input');
      fireEvent.change(editor, { target: { value: 'Changed before close' } });

      // beforecloseイベントをシミュレート
      const beforeCloseCallback = ((runtime.EventsOn as Mock).mock.calls.find(
        (call: unknown[]) => call[0] === 'app:beforeclose'
      ) ?? [])[1];

      await act(async () => {
        await beforeCloseCallback();
      });

      expect(SaveNote).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Changed before close',
        }),
        'update'
      );
    });
  });
});
