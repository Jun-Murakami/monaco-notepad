import { act, renderHook } from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import {
  CreateFolder,
  DeleteFolder,
  DeleteNote,
  DestroyApp,
  GetCollapsedFolderIDs,
  GetTopLevelOrder,
  ListNotes,
  LoadArchivedNote,
  MoveNoteToFolder,
  RenameFolder,
  SaveNote,
  UpdateArchivedTopLevelOrder,
  UpdateCollapsedFolderIDs,
  UpdateTopLevelOrder,
} from '../../../wailsjs/go/backend/App';
import * as runtime from '../../../wailsjs/runtime';
import type { Note } from '../../types';
import { useNotes } from '../useNotes';

// モックの設定
vi.mock('../../../wailsjs/go/backend/App', () => ({
  SaveNote: vi.fn(),
  ListNotes: vi.fn(),
  LoadArchivedNote: vi.fn(),
  DeleteNote: vi.fn(),
  DestroyApp: vi.fn(),
  ListFolders: vi.fn().mockResolvedValue([]),
  GetTopLevelOrder: vi.fn().mockResolvedValue([]),
  GetArchivedTopLevelOrder: vi.fn().mockResolvedValue([]),
  GetCollapsedFolderIDs: vi.fn().mockResolvedValue([]),
  UpdateTopLevelOrder: vi.fn().mockResolvedValue(undefined),
  UpdateArchivedTopLevelOrder: vi.fn().mockResolvedValue(undefined),
  UpdateCollapsedFolderIDs: vi.fn().mockResolvedValue(undefined),
  ArchiveFolder: vi.fn().mockResolvedValue(undefined),
  UnarchiveFolder: vi.fn().mockResolvedValue(undefined),
  DeleteArchivedFolder: vi.fn().mockResolvedValue(undefined),
  CreateFolder: vi.fn(),
  RenameFolder: vi.fn(),
  DeleteFolder: vi.fn(),
  MoveNoteToFolder: vi.fn(),
}));

vi.mock('../../../wailsjs/runtime', () => ({
  EventsOn: vi.fn(),
  EventsOff: vi.fn(),
}));

// backend.Note.createFromのモック
vi.mock('../../../wailsjs/go/models', () => ({
  backend: {
    Note: {
      createFrom: (note: Note) => note,
    },
    TopLevelItem: {
      createFrom: (item: { type: string; id: string }) => item,
    },
  },
}));

describe('useNotes', () => {
  const mockNote: Note = {
    id: '1',
    title: 'Test Note',
    content: 'Test Content',
    contentHeader: null,
    language: 'plaintext',
    modifiedTime: new Date().toISOString(),
    archived: false,
  };

  const mockArchivedNote: Note = {
    ...mockNote,
    id: '2',
    archived: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    (ListNotes as unknown as Mock).mockResolvedValue([mockNote]);
    (GetCollapsedFolderIDs as unknown as Mock).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('基本機能', () => {
    it('初期状態が正しく設定されていること', async () => {
      const { result } = renderHook(() => useNotes());

      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.notes).toEqual([]);
      expect(result.current.currentNote).toBeNull();
      expect(result.current.showArchived).toBeFalsy();
    });

    it('新規ノートが正しく作成されること', async () => {
      const { result } = renderHook(() => useNotes());

      await act(async () => {
        await result.current.handleNewNote();
      });

      expect(SaveNote).toHaveBeenCalled();
      expect(result.current.notes.length).toBe(1);
      expect(result.current.currentNote).toBeTruthy();
      expect(result.current.currentNote?.title).toBe('');
      expect(result.current.currentNote?.language).toBe('plaintext');
    });

    it('ノートの選択が正しく機能すること', async () => {
      const { result } = renderHook(() => useNotes());

      await act(async () => {
        await result.current.handleSelectNote(mockNote);
      });

      expect(result.current.currentNote).toEqual(mockNote);
    });
  });

  describe('ノート編集と保存', () => {
    it('ノートの内容変更が正しく機能すること', async () => {
      const { result } = renderHook(() => useNotes());

      await act(async () => {
        await result.current.handleSelectNote(mockNote);
      });

      await act(async () => {
        result.current.handleNoteContentChange('Updated Content');
      });

      expect(result.current.currentNote?.content).toBe(mockNote.content);

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });

      expect(SaveNote).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Updated Content',
        }),
        'update',
      );
    });

    it('自動保存が3秒後に実行されること', async () => {
      const { result } = renderHook(() => useNotes());

      await act(async () => {
        await result.current.handleSelectNote(mockNote);
        result.current.handleNoteContentChange('Updated Content');
      });

      // 3秒待機
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });

      expect(SaveNote).toHaveBeenCalled();
    });

    it('ノート切り替え時に変更があれば保存されること', async () => {
      const { result } = renderHook(() => useNotes());
      const anotherNote: Note = { ...mockNote, id: '3', title: 'Another Note' };

      await act(async () => {
        await result.current.handleSelectNote(mockNote);
        result.current.handleNoteContentChange('Updated Content');
      });

      await act(async () => {
        await result.current.handleSelectNote(anotherNote);
      });

      expect(SaveNote).toHaveBeenCalled();
    });

    it('タイトルの変更が正しく機能すること', async () => {
      const { result } = renderHook(() => useNotes());
      const newTitle = 'Updated Title';

      await act(async () => {
        await result.current.handleSelectNote(mockNote);
        result.current.handleTitleChange(newTitle);
      });

      // 3秒待機して自動保存を確認
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });

      expect(result.current.currentNote?.title).toBe(newTitle);
      expect(SaveNote).toHaveBeenCalledWith(
        expect.objectContaining({
          title: newTitle,
        }),
        'update',
      );
    });

    it('言語の変更が正しく機能すること', async () => {
      const { result } = renderHook(() => useNotes());
      const newLanguage = 'javascript';

      await act(async () => {
        await result.current.handleSelectNote(mockNote);
        result.current.handleLanguageChange(newLanguage);
      });

      // 3秒待機して自動保存を確認
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });

      expect(result.current.currentNote?.language).toBe(newLanguage);
      expect(SaveNote).toHaveBeenCalledWith(
        expect.objectContaining({
          language: newLanguage,
        }),
        'update',
      );
    });

    it('保存に失敗した場合でもUIの状態は保持されること', async () => {
      const { result } = renderHook(() => useNotes());
      const updatedContent = 'Updated Content';

      // SaveNoteをエラーを投げるようにモック
      (SaveNote as unknown as Mock).mockRejectedValueOnce(
        new Error('保存エラー'),
      );

      await act(async () => {
        await result.current.handleSelectNote(mockNote);
        result.current.handleNoteContentChange(updatedContent);
      });

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });

      expect(result.current.currentNote?.content).toBe(mockNote.content);
      expect(SaveNote).toHaveBeenCalledWith(
        expect.objectContaining({
          content: updatedContent,
        }),
        'update',
      );
    });
  });

  describe('アーカイブ機能', () => {
    it('ノートのアーカイブが正しく機能すること', async () => {
      const { result } = renderHook(() => useNotes());

      // 初期ノートリストを設定
      await act(async () => {
        (ListNotes as unknown as Mock).mockResolvedValue([mockNote]);
        await result.current.handleSelectNote(mockNote);
      });

      // ノートリストの状態を設定
      await act(async () => {
        result.current.setNotes([mockNote]);
        result.current.setTopLevelOrder([{ type: 'note', id: mockNote.id }]);
        result.current.setArchivedTopLevelOrder([]);
      });

      await act(async () => {
        await result.current.handleArchiveNote(mockNote.id);
      });

      expect(SaveNote).toHaveBeenCalledWith(
        expect.objectContaining({
          id: mockNote.id,
          archived: true,
          content: mockNote.content,
        }),
        'update',
      );
      expect(UpdateTopLevelOrder).toHaveBeenCalledWith([]);
      expect(UpdateArchivedTopLevelOrder).toHaveBeenCalledWith([
        { type: 'note', id: mockNote.id },
      ]);
    });

    it('アーカイブされたノートの復元が正しく機能すること', async () => {
      const { result } = renderHook(() => useNotes());

      // アーカイブされたノートを設定
      const archivedContent = 'Archived content';
      (ListNotes as unknown as Mock).mockResolvedValue([mockArchivedNote]);
      (LoadArchivedNote as unknown as Mock).mockResolvedValue({
        ...mockArchivedNote,
        content: archivedContent,
      });

      // ノートリストの状態を設定
      await act(async () => {
        result.current.setNotes([mockArchivedNote]);
        result.current.setTopLevelOrder([{ type: 'note', id: 'active-note' }]);
        result.current.setArchivedTopLevelOrder([
          { type: 'note', id: mockArchivedNote.id },
          { type: 'note', id: 'other-archived' },
        ]);
      });

      await act(async () => {
        await result.current.handleUnarchiveNote(mockArchivedNote.id);
      });

      expect(LoadArchivedNote).toHaveBeenCalledWith(mockArchivedNote.id);
      expect(SaveNote).toHaveBeenCalledWith(
        expect.objectContaining({
          id: mockArchivedNote.id,
          archived: false,
          content: archivedContent,
        }),
        'update',
      );
      expect(UpdateTopLevelOrder).toHaveBeenCalledWith([
        { type: 'note', id: mockArchivedNote.id },
        { type: 'note', id: 'active-note' },
      ]);
      expect(UpdateArchivedTopLevelOrder).toHaveBeenCalledWith([
        { type: 'note', id: 'other-archived' },
      ]);
    });

    it('アーカイブ時にコンテンツヘッダーが正しく生成されること', async () => {
      const { result } = renderHook(() => useNotes());
      const multilineContent = '1行目\n2行目\n3行目\n4行目';
      const noteWithMultilineContent = {
        ...mockNote,
        content: multilineContent,
      };

      await act(async () => {
        (ListNotes as unknown as Mock).mockResolvedValue([
          noteWithMultilineContent,
        ]);
        result.current.setNotes([noteWithMultilineContent]);
      });

      await act(async () => {
        await result.current.handleArchiveNote(noteWithMultilineContent.id);
      });

      expect(SaveNote).toHaveBeenCalledWith(
        expect.objectContaining({
          contentHeader: '1行目\n2行目\n3行目',
        }),
        'update',
      );
    });

    it('現在のノートをアーカイブした場合、別のノートに切り替わること', async () => {
      const { result } = renderHook(() => useNotes());
      const activeNote1 = { ...mockNote, id: '1' };
      const activeNote2 = { ...mockNote, id: '2' };

      await act(async () => {
        (ListNotes as unknown as Mock).mockResolvedValue([
          activeNote1,
          activeNote2,
        ]);
        result.current.setNotes([activeNote1, activeNote2]);
        result.current.setTopLevelOrder([
          { type: 'note', id: '1' },
          { type: 'note', id: '2' },
        ]);
        await result.current.handleSelectNote(activeNote1);
      });

      await act(async () => {
        await result.current.handleArchiveNote(activeNote1.id);
      });

      expect(result.current.currentNote?.id).toBe(activeNote2.id);
    });
  });

  describe('イベントリスナー', () => {
    it('notes:reloadイベントで正しくノートリストが更新されること', async () => {
      renderHook(() => useNotes());
      const updatedNotes = [{ ...mockNote, content: 'Updated via reload' }];

      // イベントリスナーの登録を確認
      expect(runtime.EventsOn).toHaveBeenCalledWith(
        'notes:reload',
        expect.any(Function),
      );

      // notes:reloadイベントをシミュレート
      const mockCalls = (runtime.EventsOn as unknown as Mock).mock.calls;
      const foundReloadCall = mockCalls.find(
        (call) => call[0] === 'notes:reload',
      );
      if (!foundReloadCall) throw new Error('notes:reload callback not found');
      const reloadCallback = foundReloadCall[1];

      (ListNotes as unknown as Mock).mockResolvedValue(updatedNotes);

      await act(async () => {
        await reloadCallback();
      });

      expect(ListNotes).toHaveBeenCalled();
    });

    it('notes:reloadで現在ノートが削除された場合、トップのノートへ自動切り替えされること', async () => {
      const { result } = renderHook(() => useNotes());
      const current = { ...mockNote, id: 'current', title: 'Current' };
      const replacement = {
        ...mockNote,
        id: 'replacement',
        title: 'Replacement',
      };

      await act(async () => {
        result.current.setNotes([current, replacement]);
        await result.current.handleSelectNote(current);
      });

      const mockCalls = (runtime.EventsOn as unknown as Mock).mock.calls;
      const foundReloadCall = mockCalls.find(
        (call) => call[0] === 'notes:reload',
      );
      if (!foundReloadCall) throw new Error('notes:reload callback not found');
      const reloadCallback = foundReloadCall[1];

      (ListNotes as unknown as Mock).mockResolvedValue([replacement]);
      (GetTopLevelOrder as unknown as Mock).mockResolvedValue([
        { type: 'note', id: replacement.id },
      ]);

      await act(async () => {
        await reloadCallback();
      });

      expect(result.current.currentNote?.id).toBe(replacement.id);
    });

    it('notes:reloadで現在ノートがアーカイブされた場合、トップのアクティブノートへ自動切り替えされること', async () => {
      const { result } = renderHook(() => useNotes());
      const current = { ...mockNote, id: 'current', title: 'Current' };
      const replacement = {
        ...mockNote,
        id: 'replacement',
        title: 'Replacement',
      };

      await act(async () => {
        result.current.setNotes([current, replacement]);
        await result.current.handleSelectNote(current);
      });

      const mockCalls = (runtime.EventsOn as unknown as Mock).mock.calls;
      const foundReloadCall = mockCalls.find(
        (call) => call[0] === 'notes:reload',
      );
      if (!foundReloadCall) throw new Error('notes:reload callback not found');
      const reloadCallback = foundReloadCall[1];

      (ListNotes as unknown as Mock).mockResolvedValue([
        { ...current, archived: true },
        replacement,
      ]);
      (GetTopLevelOrder as unknown as Mock).mockResolvedValue([
        { type: 'note', id: current.id },
        { type: 'note', id: replacement.id },
      ]);

      await act(async () => {
        await reloadCallback();
      });

      expect(result.current.currentNote?.id).toBe(replacement.id);
    });

    it('notes:updatedイベントで正しく個別のノートが更新されること', async () => {
      const { result } = renderHook(() => useNotes());
      const updatedNote = { ...mockNote, content: 'Updated via event' };

      // イベントリスナーの登録を確認
      expect(runtime.EventsOn).toHaveBeenCalledWith(
        'notes:updated',
        expect.any(Function),
      );

      // notes:updatedイベントをシミュレート
      const mockCalls2 = (runtime.EventsOn as unknown as Mock).mock.calls;
      const foundUpdateCall = mockCalls2.find(
        (call) => call[0] === 'notes:updated',
      );
      if (!foundUpdateCall) throw new Error('notes:updated callback not found');
      const updateCallback = foundUpdateCall[1];

      (ListNotes as unknown as Mock).mockResolvedValue([updatedNote]);

      await act(async () => {
        await result.current.handleSelectNote(mockNote);
        await updateCallback();
      });

      expect(ListNotes).toHaveBeenCalled();
    });
  });

  describe('ノート削除', () => {
    it('ノートの削除が正しく機能すること', async () => {
      const { result } = renderHook(() => useNotes());

      // 初期ノートリストを設定
      (ListNotes as unknown as Mock).mockResolvedValue([mockNote]);

      await act(async () => {
        await result.current.handleDeleteNote(mockNote.id);
      });

      expect(DeleteNote).toHaveBeenCalledWith(mockNote.id);
    });

    it('最後のアーカイブノートを削除した場合、新規ノートが作成されること', async () => {
      const { result } = renderHook(() => useNotes());

      // アーカイブノートのみの状態を設定
      (ListNotes as unknown as Mock).mockResolvedValue([mockArchivedNote]);

      await act(async () => {
        // アーカイブページを表示
        result.current.setShowArchived(true);
        // ノートリストの状態を設定
        result.current.setNotes([mockArchivedNote]);
      });

      await act(async () => {
        await result.current.handleDeleteNote(mockArchivedNote.id);
      });

      expect(DeleteNote).toHaveBeenCalledWith(mockArchivedNote.id);
      expect(SaveNote).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '',
          content: '',
          archived: false,
        }),
        'create',
      );
      expect(result.current.showArchived).toBeFalsy();
    });
  });

  describe('エラーハンドリング', () => {
    it('存在しないノートの操作は無視されること', async () => {
      const { result } = renderHook(() => useNotes());
      const nonExistentId = 'non-existent';

      // 空のノートリストを設定
      await act(async () => {
        (ListNotes as unknown as Mock).mockResolvedValue([]);
        result.current.setNotes([]);
      });

      await act(async () => {
        await result.current.handleArchiveNote(nonExistentId);
        await result.current.handleUnarchiveNote(nonExistentId);
        await result.current.handleDeleteNote(nonExistentId);
      });

      expect(SaveNote).not.toHaveBeenCalled();
      // DeleteNoteは呼ばれるが、状態は変更されない
      expect(result.current.notes).toEqual([]);
    });

    it('アーカイブノートのロードに失敗した場合、状態は変更されないこと', async () => {
      const { result } = renderHook(() => useNotes());

      // アーカイブノートの初期状態を設定
      await act(async () => {
        (ListNotes as unknown as Mock).mockResolvedValue([mockArchivedNote]);
        result.current.setNotes([mockArchivedNote]);
      });

      // LoadArchivedNoteをエラーを投げるようにモック
      (LoadArchivedNote as unknown as Mock).mockRejectedValueOnce(
        new Error('ロードエラー'),
      );

      // エラーをキャッチしながらアンアーカイブを実行
      await act(async () => {
        try {
          await result.current.handleUnarchiveNote(mockArchivedNote.id);
        } catch (_error) {
          // エラーは期待通り
        }
      });

      // 状態が変更されていないことを確認
      expect(result.current.notes[0].archived).toBe(true);
      expect(SaveNote).not.toHaveBeenCalled();
    });
  });

  describe('ノートの変更検知', () => {
    it('ノートの内容が変更された場合に正しく検知されること', async () => {
      const { result } = renderHook(() => useNotes());
      const oldNote = { ...mockNote, content: mockNote.content || '' };
      const newNote = {
        ...mockNote,
        content: 'Updated content',
        title: 'Updated title',
        language: 'javascript',
        modifiedTime: new Date().toISOString(),
      };

      await act(async () => {
        result.current.setNotes([oldNote]);
        await result.current.handleSelectNote(oldNote);
      });

      // 各フィールドの変更をテスト
      await act(async () => {
        result.current.handleNoteContentChange(newNote.content);
        result.current.handleTitleChange(newNote.title);
        result.current.handleLanguageChange(newNote.language);
      });

      // 3秒待機して自動保存を確認
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });

      expect(SaveNote).toHaveBeenCalledWith(
        expect.objectContaining({
          content: newNote.content,
          title: newNote.title,
          language: newNote.language,
        }),
        'update',
      );
    });

    it('同じ内容に変更された場合は保存されないこと', async () => {
      const { result } = renderHook(() => useNotes());
      const noteWithContent = { ...mockNote, content: mockNote.content || '' };

      await act(async () => {
        result.current.setNotes([noteWithContent]);
        await result.current.handleSelectNote(noteWithContent);
      });

      // 同じ内容に変更
      await act(async () => {
        result.current.handleNoteContentChange(noteWithContent.content);
      });

      // 3秒待機
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });

      expect(SaveNote).not.toHaveBeenCalled();
    });
  });

  describe('アプリケーションの終了処理', () => {
    it('アプリケーション終了時に変更があれば保存されること', async () => {
      const { result } = renderHook(() => useNotes());

      await act(async () => {
        result.current.setNotes([mockNote]);
        await result.current.handleSelectNote(mockNote);
        result.current.handleNoteContentChange('Updated content before close');
      });

      // beforecloseイベントをシミュレート
      const mockCalls3 = (runtime.EventsOn as unknown as Mock).mock.calls;
      const foundCloseCall = mockCalls3.find(
        (call) => call[0] === 'app:beforeclose',
      );
      if (!foundCloseCall)
        throw new Error('app:beforeclose callback not found');
      const beforeCloseCallback = foundCloseCall[1];

      await act(async () => {
        await beforeCloseCallback();
      });

      expect(SaveNote).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Updated content before close',
        }),
        'update',
      );
      expect(DestroyApp).toHaveBeenCalled();
    });

    it('アプリケーション終了時に変更がなければ保存されないこと', async () => {
      const { result } = renderHook(() => useNotes());

      await act(async () => {
        result.current.setNotes([mockNote]);
        await result.current.handleSelectNote(mockNote);
      });

      // beforecloseイベントをシミュレート
      const mockCalls3 = (runtime.EventsOn as unknown as Mock).mock.calls;
      const foundCloseCall = mockCalls3.find(
        (call) => call[0] === 'app:beforeclose',
      );
      if (!foundCloseCall)
        throw new Error('app:beforeclose callback not found');
      const beforeCloseCallback = foundCloseCall[1];

      await act(async () => {
        await beforeCloseCallback();
      });

      expect(SaveNote).not.toHaveBeenCalled();
      expect(DestroyApp).toHaveBeenCalled();
    });
  });

  describe('アーカイブノートの一括削除', () => {
    it('すべてのアーカイブノートが削除されること', async () => {
      const { result } = renderHook(() => useNotes());
      const archivedNote1 = { ...mockNote, id: '1', archived: true };
      const archivedNote2 = { ...mockNote, id: '2', archived: true };
      const activeNote = { ...mockNote, id: '3', archived: false };

      await act(async () => {
        result.current.setNotes([archivedNote1, archivedNote2, activeNote]);
        result.current.setShowArchived(true);
      });

      await act(async () => {
        await result.current.handleDeleteAllArchivedNotes();
      });

      expect(DeleteNote).toHaveBeenCalledWith(archivedNote1.id);
      expect(DeleteNote).toHaveBeenCalledWith(archivedNote2.id);
      expect(result.current.notes).toEqual([activeNote]);
      expect(result.current.showArchived).toBeFalsy();
    });

    it('アーカイブノートをすべて削除後、アクティブなノートがない場合は新規ノートが作成されること', async () => {
      const { result } = renderHook(() => useNotes());
      const archivedNote = { ...mockNote, archived: true };

      await act(async () => {
        result.current.setNotes([archivedNote]);
        result.current.setShowArchived(true);
      });

      await act(async () => {
        await result.current.handleDeleteAllArchivedNotes();
      });

      expect(DeleteNote).toHaveBeenCalledWith(archivedNote.id);
      expect(SaveNote).toHaveBeenCalledWith(
        expect.objectContaining({
          archived: false,
          content: '',
          title: '',
        }),
        'create',
      );
      expect(result.current.showArchived).toBeFalsy();
    });
  });

  describe('フォルダ機能', () => {
    it('handleCreateFolderが正しくフォルダを作成すること', async () => {
      const mockFolder = { id: 'folder-1', name: 'Test Folder' };
      (CreateFolder as unknown as Mock).mockResolvedValue(mockFolder);

      const { result } = renderHook(() => useNotes());

      await act(async () => {
        const folder = await result.current.handleCreateFolder('Test Folder');
        expect(folder).toEqual(mockFolder);
      });

      expect(CreateFolder).toHaveBeenCalledWith('Test Folder');
      expect(result.current.folders).toEqual([mockFolder]);
    });

    it('handleRenameFolderが正しくフォルダ名を変更すること', async () => {
      const mockFolder = { id: 'folder-1', name: 'Original' };
      (CreateFolder as unknown as Mock).mockResolvedValue(mockFolder);
      (RenameFolder as unknown as Mock).mockResolvedValue(undefined);

      const { result } = renderHook(() => useNotes());

      await act(async () => {
        await result.current.handleCreateFolder('Original');
      });

      await act(async () => {
        await result.current.handleRenameFolder('folder-1', 'Renamed');
      });

      expect(RenameFolder).toHaveBeenCalledWith('folder-1', 'Renamed');
      expect(result.current.folders[0].name).toBe('Renamed');
    });

    it('handleDeleteFolderが正しくフォルダを削除すること', async () => {
      const mockFolder = { id: 'folder-1', name: 'ToDelete' };
      (CreateFolder as unknown as Mock).mockResolvedValue(mockFolder);
      (DeleteFolder as unknown as Mock).mockResolvedValue(undefined);

      const { result } = renderHook(() => useNotes());

      await act(async () => {
        await result.current.handleCreateFolder('ToDelete');
      });

      await act(async () => {
        await result.current.handleDeleteFolder('folder-1');
      });

      expect(DeleteFolder).toHaveBeenCalledWith('folder-1');
      expect(result.current.folders).toEqual([]);
    });

    it('handleMoveNoteToFolderが正しくノートをフォルダに移動すること', async () => {
      (MoveNoteToFolder as unknown as Mock).mockResolvedValue(undefined);

      const { result } = renderHook(() => useNotes());

      await act(async () => {
        result.current.setNotes([mockNote]);
      });

      await act(async () => {
        await result.current.handleMoveNoteToFolder(mockNote.id, 'folder-1');
      });

      expect(MoveNoteToFolder).toHaveBeenCalledWith(mockNote.id, 'folder-1');
      expect(result.current.notes[0].folderId).toBe('folder-1');
    });

    it('handleMoveNoteToFolderで空文字を指定すると未分類に戻ること', async () => {
      (MoveNoteToFolder as unknown as Mock).mockResolvedValue(undefined);

      const { result } = renderHook(() => useNotes());
      const noteWithFolder = { ...mockNote, folderId: 'folder-1' };

      await act(async () => {
        result.current.setNotes([noteWithFolder]);
      });

      await act(async () => {
        await result.current.handleMoveNoteToFolder(mockNote.id, '');
      });

      expect(MoveNoteToFolder).toHaveBeenCalledWith(mockNote.id, '');
      expect(result.current.notes[0].folderId).toBeUndefined();
    });

    it('toggleFolderCollapseがフォルダの折りたたみ状態を切り替えること', async () => {
      const { result } = renderHook(() => useNotes());

      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        result.current.toggleFolderCollapse('folder-1');
      });

      expect(result.current.collapsedFolders.has('folder-1')).toBe(true);
      expect(UpdateCollapsedFolderIDs).toHaveBeenCalledWith(['folder-1']);

      act(() => {
        result.current.toggleFolderCollapse('folder-2');
      });

      expect(UpdateCollapsedFolderIDs).toHaveBeenLastCalledWith(
        expect.arrayContaining(['folder-1', 'folder-2']),
      );

      act(() => {
        result.current.toggleFolderCollapse('folder-1');
      });

      expect(result.current.collapsedFolders.has('folder-1')).toBe(false);
      expect(UpdateCollapsedFolderIDs).toHaveBeenLastCalledWith(['folder-2']);
    });

    it('初期化時にバックエンドのcollapsed folder IDsを読み込むこと', async () => {
      (GetCollapsedFolderIDs as unknown as Mock).mockResolvedValue([
        'folder-from-backend',
      ]);

      const { result } = renderHook(() => useNotes());

      await act(async () => {
        await Promise.resolve();
      });

      expect(GetCollapsedFolderIDs).toHaveBeenCalled();
      expect(result.current.collapsedFolders.has('folder-from-backend')).toBe(
        true,
      );
    });
  });
});
