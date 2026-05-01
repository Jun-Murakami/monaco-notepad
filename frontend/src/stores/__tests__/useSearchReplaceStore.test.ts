import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

import { SaveNote } from '../../../wailsjs/go/backend/App';
import {
  type SearchScope,
  useSearchReplaceStore,
} from '../useSearchReplaceStore';

import type { editor } from 'monaco-editor';
import type { FileNote, Note } from '../../types';

// =========================================================================
// 依存モック
// =========================================================================

vi.mock('../../../wailsjs/go/backend/App', () => ({
  SaveNote: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../wailsjs/go/models', () => ({
  backend: {
    Note: {
      // テストでは内容を素通しすれば十分
      createFrom: (n: Note) => n,
    },
  },
}));

// showMessage は確認ダイアログを返す。常に true を返してテストを進める。
vi.mock('../useMessageDialogStore', () => ({
  showMessage: vi.fn().mockResolvedValue(true),
}));

// monaco の最小モック。
// - URI 単位でモデルをキャッシュするため、Map で擬似ストアを持つ。
// - getOffsetAt / getPositionAt は線形マッピング（オフセット= column, 行 1 固定）。
type FakeModel = {
  __id: string;
  getValue: () => string;
  setValue: (v: string) => void;
  getPositionAt: (off: number) => { lineNumber: number; column: number };
  getOffsetAt: (pos: { lineNumber: number; column: number }) => number;
  onDidChangeContent: (cb: () => void) => { dispose: () => void };
  isDisposed: () => boolean;
  pushStackElement: () => void;
  pushEditOperations: (...args: unknown[]) => null;
  uri: { toString: () => string };
};

const modelStore = new Map<string, FakeModel>();
const createFakeModel = (uri: string, value: string): FakeModel => {
  let v = value;
  const m: FakeModel = {
    __id: uri,
    getValue: () => v,
    setValue: (x) => {
      v = x;
    },
    getPositionAt: (off) => ({ lineNumber: 1, column: off + 1 }),
    getOffsetAt: (pos) => Math.max(0, (pos.column ?? 1) - 1),
    onDidChangeContent: () => ({ dispose: () => {} }),
    isDisposed: () => false,
    pushStackElement: () => {},
    // applyEditsToModel が pushEditOperations 経由で範囲置換するので、
    // テスト用には range の column → offset 換算で文字列を書き換える。
    pushEditOperations: (_before: unknown, edits: unknown) => {
      const arr = edits as Array<{
        range: {
          startColumn: number;
          endColumn: number;
        };
        text: string;
      }>;
      const planned = arr.map((e) => ({
        start: Math.max(0, (e.range.startColumn ?? 1) - 1),
        end: Math.max(0, (e.range.endColumn ?? 1) - 1),
        text: e.text,
      }));
      planned.sort((a, b) => b.start - a.start);
      for (const p of planned) {
        v = v.slice(0, p.start) + p.text + v.slice(p.end);
      }
      return null;
    },
    uri: { toString: () => uri },
  };
  modelStore.set(uri, m);
  return m;
};

vi.mock('../../lib/monaco', () => {
  return {
    getMonaco: () => ({
      Uri: {
        parse: (s: string) => ({ toString: () => s }),
      },
      Range: class {
        constructor(
          public startLineNumber: number,
          public startColumn: number,
          public endLineNumber: number,
          public endColumn: number,
        ) {}
      },
      editor: {
        getModel: (uri: { toString: () => string }) =>
          modelStore.get(uri.toString()) ?? null,
        createModel: (
          content: string,
          _lang: string,
          uri: { toString: () => string },
        ) => createFakeModel(uri.toString(), content),
        TrackedRangeStickiness: {
          NeverGrowsWhenTypingAtEdges: 0,
        },
      },
    }),
  };
});

// =========================================================================
// テストヘルパ
// =========================================================================

const mkNote = (id: string, title: string, content: string): Note => ({
  id,
  title,
  content,
  contentHeader: null,
  language: 'plaintext',
  modifiedTime: '2026-05-01T00:00:00Z',
  archived: false,
});

const mkFileNote = (
  id: string,
  fileName: string,
  content: string,
  originalContent = content,
): FileNote => ({
  id,
  fileName,
  filePath: `/tmp/${fileName}`,
  content,
  originalContent,
  language: 'plaintext',
  modifiedTime: '2026-05-01T00:00:00Z',
});

const makeFakeEditor = (model: FakeModel | null) => {
  let currentModel = model;
  let selection = {
    getStartPosition: () => ({ lineNumber: 1, column: 1 }),
    getEndPosition: () => ({ lineNumber: 1, column: 1 }),
  };
  let position = { lineNumber: 1, column: 1 };
  const decorationIds: string[] = [];
  const ed = {
    getModel: () => currentModel,
    setModel: (m: FakeModel | null) => {
      currentModel = m;
    },
    getSelection: () => selection,
    getPosition: () => position,
    setSelection: vi.fn((range: { startColumn: number; endColumn: number }) => {
      // setSelection は範囲を選択する。getEndPosition がカーソル末端、
      // getStartPosition が始点を返すよう更新する。
      const start = { lineNumber: 1, column: range.startColumn };
      const end = { lineNumber: 1, column: range.endColumn };
      selection = {
        getStartPosition: () => start,
        getEndPosition: () => end,
      };
      position = end;
    }),
    revealRangeInCenter: vi.fn(),
    deltaDecorations: vi.fn((_old: string[], next: unknown[]) =>
      next.map((_, i) => `dec-${decorationIds.length + i}`),
    ),
    onDidChangeModel: vi.fn((_cb: () => void) => ({ dispose: () => {} })),
    // テスト用フック: selection を直接書き換える
    __setSelection(startCol: number, endCol: number) {
      const start = { lineNumber: 1, column: startCol };
      const end = { lineNumber: 1, column: endCol };
      selection = {
        getStartPosition: () => start,
        getEndPosition: () => end,
      };
      position = end;
    },
  };
  return ed as typeof ed & editor.IStandaloneCodeEditor;
};

const setupContext = (
  overrides: Partial<{
    notes: Note[];
    fileNotes: FileNote[];
    activeNoteId: string | null;
    ed: ReturnType<typeof makeFakeEditor> | null;
  }> = {},
) => {
  const notesRef: { notes: Note[] } = { notes: overrides.notes ?? [] };
  const fileNotesRef: { fileNotes: FileNote[] } = {
    fileNotes: overrides.fileNotes ?? [],
  };
  const setNotesSpy = vi.fn((updater: (prev: Note[]) => Note[]) => {
    notesRef.notes = updater(notesRef.notes);
  });
  const setFileNotesSpy = vi.fn((updater: (prev: FileNote[]) => FileNote[]) => {
    fileNotesRef.fileNotes = updater(fileNotesRef.fileNotes);
  });
  const onSelectNoteSpy = vi.fn();
  useSearchReplaceStore.setState({
    context: {
      getNotes: () => notesRef.notes,
      getFileNotes: () => fileNotesRef.fileNotes,
      setNotes: setNotesSpy,
      setFileNotes: setFileNotesSpy,
      getActiveEditor: () => overrides.ed ?? null,
      getActiveNoteId: () => overrides.activeNoteId ?? null,
      t: (k) => k,
      onSelectNote: onSelectNoteSpy,
    },
  });
  return {
    notesRef,
    fileNotesRef,
    setNotesSpy,
    setFileNotesSpy,
    onSelectNoteSpy,
  };
};

const resetStore = () => {
  modelStore.clear();
  useSearchReplaceStore.setState({
    mode: 'find',
    query: '',
    replacement: '',
    caseSensitive: false,
    wholeWord: false,
    useRegex: false,
    scope: 'all',
    focusToken: 0,
    searchNavigated: false,
    replaceResult: null,
    replaceResultToken: 0,
    currentMatches: [],
    currentMatchIndex: 0,
    crossNoteResults: [],
    pendingJump: null,
  });
};

beforeEach(() => {
  resetStore();
});
afterEach(() => {
  resetStore();
  vi.clearAllMocks();
});

// =========================================================================
// テストケース
// =========================================================================

describe('useSearchReplaceStore', () => {
  describe('searchNavigated のリセット', () => {
    it.each([
      ['setQuery', () => useSearchReplaceStore.getState().setQuery('x')],
      [
        'setCaseSensitive',
        () => useSearchReplaceStore.getState().setCaseSensitive(true),
      ],
      [
        'setWholeWord',
        () => useSearchReplaceStore.getState().setWholeWord(true),
      ],
      ['setUseRegex', () => useSearchReplaceStore.getState().setUseRegex(true)],
      ['setScope', () => useSearchReplaceStore.getState().setScope('notes')],
      ['clearQuery', () => useSearchReplaceStore.getState().clearQuery()],
    ])('%s で searchNavigated が false にリセットされる', (_name, action) => {
      useSearchReplaceStore.setState({ searchNavigated: true });
      action();
      expect(useSearchReplaceStore.getState().searchNavigated).toBe(false);
    });
  });

  describe('findNext / findPrevious (キャレット非依存の初回ロケート)', () => {
    it('searchNavigated=false の findNext は currentMatchIndex を 0 にして searchNavigated を立てる', () => {
      const ed = makeFakeEditor(createFakeModel('inmemory://n1', 'aaaaa'));
      setupContext({ ed, activeNoteId: 'n1' });
      useSearchReplaceStore.setState({
        searchNavigated: false,
        currentMatches: [
          { start: 0, end: 1, matchText: 'a', groups: ['a'] },
          { start: 1, end: 2, matchText: 'a', groups: ['a'] },
          { start: 2, end: 3, matchText: 'a', groups: ['a'] },
        ],
        currentMatchIndex: 2, // 古い位置
      });
      useSearchReplaceStore.getState().findNext();
      const s = useSearchReplaceStore.getState();
      expect(s.currentMatchIndex).toBe(0);
      expect(s.searchNavigated).toBe(true);
    });

    it('searchNavigated=false の findPrevious は末尾マッチに飛んで searchNavigated を立てる', () => {
      const ed = makeFakeEditor(createFakeModel('inmemory://n1', 'aaaaa'));
      setupContext({ ed, activeNoteId: 'n1' });
      useSearchReplaceStore.setState({
        searchNavigated: false,
        currentMatches: [
          { start: 0, end: 1, matchText: 'a', groups: ['a'] },
          { start: 1, end: 2, matchText: 'a', groups: ['a'] },
          { start: 2, end: 3, matchText: 'a', groups: ['a'] },
        ],
        currentMatchIndex: 0,
      });
      useSearchReplaceStore.getState().findPrevious();
      const s = useSearchReplaceStore.getState();
      expect(s.currentMatchIndex).toBe(2);
      expect(s.searchNavigated).toBe(true);
    });

    it('searchNavigated=true の findNext は selection 末端を基準に進む', () => {
      const ed = makeFakeEditor(createFakeModel('inmemory://n1', 'aaaaa'));
      // selection が match[0] = [start=0, end=1] を選んでいる状態を模擬
      // FakeModel.getOffsetAt は column-1 を返すので、column=2 → offset=1
      ed.__setSelection(1, 2);
      setupContext({ ed, activeNoteId: 'n1' });
      useSearchReplaceStore.setState({
        searchNavigated: true,
        currentMatches: [
          { start: 0, end: 1, matchText: 'a', groups: ['a'] },
          { start: 1, end: 2, matchText: 'a', groups: ['a'] },
          { start: 2, end: 3, matchText: 'a', groups: ['a'] },
        ],
        currentMatchIndex: 0,
      });
      useSearchReplaceStore.getState().findNext();
      // sel.endPosition の offset = 1。m.start >= 1 の最初は match[1] (start=1)
      expect(useSearchReplaceStore.getState().currentMatchIndex).toBe(1);
    });

    it('searchNavigated=true の findPrevious は selection 始点を基準に戻る', () => {
      const ed = makeFakeEditor(createFakeModel('inmemory://n1', 'aaaaa'));
      // selection が match[2] = [start=2, end=3] を選んでいる
      ed.__setSelection(3, 4);
      setupContext({ ed, activeNoteId: 'n1' });
      useSearchReplaceStore.setState({
        searchNavigated: true,
        currentMatches: [
          { start: 0, end: 1, matchText: 'a', groups: ['a'] },
          { start: 1, end: 2, matchText: 'a', groups: ['a'] },
          { start: 2, end: 3, matchText: 'a', groups: ['a'] },
        ],
        currentMatchIndex: 2,
      });
      useSearchReplaceStore.getState().findPrevious();
      // sel.start offset = 2。m.start < 2 の最後は match[1] (start=1)
      expect(useSearchReplaceStore.getState().currentMatchIndex).toBe(1);
    });

    it('現ノート末尾マッチを越えた findNext は次グループへ pendingJump を立て onSelectNote を呼ぶ', () => {
      const ed = makeFakeEditor(createFakeModel('inmemory://n1', 'aaaaa'));
      // selection が最後のマッチ末端より後ろ
      ed.__setSelection(10, 10);
      const ctx = setupContext({ ed, activeNoteId: 'n1' });
      useSearchReplaceStore.setState({
        searchNavigated: true,
        currentMatches: [{ start: 0, end: 1, matchText: 'a', groups: ['a'] }],
        currentMatchIndex: 0,
        crossNoteResults: [
          {
            noteId: 'n1',
            noteTitle: 'note1',
            content: 'a',
            matches: [{ start: 0, end: 1, matchText: 'a', groups: ['a'] }],
          },
          {
            noteId: 'n2',
            noteTitle: 'note2',
            content: 'aa',
            matches: [
              { start: 0, end: 1, matchText: 'a', groups: ['a'] },
              { start: 1, end: 2, matchText: 'a', groups: ['a'] },
            ],
          },
        ],
      });
      useSearchReplaceStore.getState().findNext();
      const s = useSearchReplaceStore.getState();
      expect(s.pendingJump).toEqual({ noteId: 'n2', matchIndexInNote: 0 });
      expect(s.searchNavigated).toBe(true);
      expect(ctx.onSelectNoteSpy).toHaveBeenCalledWith('n2');
    });

    it('現ノート先頭マッチより前の findPrevious は前グループの末尾マッチへ pendingJump', () => {
      const ed = makeFakeEditor(createFakeModel('inmemory://n2', 'aa'));
      ed.__setSelection(1, 1); // start offset = 0
      const ctx = setupContext({ ed, activeNoteId: 'n2' });
      useSearchReplaceStore.setState({
        searchNavigated: true,
        currentMatches: [
          { start: 0, end: 1, matchText: 'a', groups: ['a'] },
          { start: 1, end: 2, matchText: 'a', groups: ['a'] },
        ],
        currentMatchIndex: 0,
        crossNoteResults: [
          {
            noteId: 'n1',
            noteTitle: 'note1',
            content: 'aaa',
            matches: [
              { start: 0, end: 1, matchText: 'a', groups: ['a'] },
              { start: 1, end: 2, matchText: 'a', groups: ['a'] },
              { start: 2, end: 3, matchText: 'a', groups: ['a'] },
            ],
          },
          {
            noteId: 'n2',
            noteTitle: 'note2',
            content: 'aa',
            matches: [
              { start: 0, end: 1, matchText: 'a', groups: ['a'] },
              { start: 1, end: 2, matchText: 'a', groups: ['a'] },
            ],
          },
        ],
      });
      useSearchReplaceStore.getState().findPrevious();
      const s = useSearchReplaceStore.getState();
      // n1 の末尾マッチ (matches.length-1 = 2) へ
      expect(s.pendingJump).toEqual({ noteId: 'n1', matchIndexInNote: 2 });
      expect(ctx.onSelectNoteSpy).toHaveBeenCalledWith('n1');
    });
  });

  describe('jumpToNoteMatch (パネルクリック相当)', () => {
    it('エディタの実モデル == 対象 URI の場合は直接ジャンプ + searchNavigated', () => {
      const m = createFakeModel('inmemory://n1', 'aaaaa');
      const ed = makeFakeEditor(m);
      setupContext({ ed, activeNoteId: 'n1' });
      useSearchReplaceStore.setState({
        currentMatches: [
          { start: 0, end: 1, matchText: 'a', groups: ['a'] },
          { start: 1, end: 2, matchText: 'a', groups: ['a'] },
          { start: 2, end: 3, matchText: 'a', groups: ['a'] },
        ],
        currentMatchIndex: 0,
        searchNavigated: false,
      });
      useSearchReplaceStore.getState().jumpToNoteMatch('n1', 2);
      const s = useSearchReplaceStore.getState();
      expect(s.pendingJump).toBeNull();
      expect(s.currentMatchIndex).toBe(2);
      expect(s.searchNavigated).toBe(true);
    });

    it('エディタが別モデルの場合は pendingJump を立てる + searchNavigated', () => {
      // active editor は n1 のモデルを表示中
      const m1 = createFakeModel('inmemory://n1', 'aaaaa');
      // n2 のモデルもキャッシュとしては存在
      createFakeModel('inmemory://n2', 'bbb');
      const ed = makeFakeEditor(m1);
      setupContext({ ed, activeNoteId: 'n1' });
      useSearchReplaceStore.setState({
        currentMatchIndex: 0,
        searchNavigated: false,
      });
      useSearchReplaceStore.getState().jumpToNoteMatch('n2', 1);
      const s = useSearchReplaceStore.getState();
      expect(s.pendingJump).toEqual({ noteId: 'n2', matchIndexInNote: 1 });
      expect(s.searchNavigated).toBe(true);
      // 直接 currentMatchIndex は変わらない
      expect(s.currentMatchIndex).toBe(0);
    });
  });

  describe('replaceCurrent / replaceAllInCurrent: 置換後にプレビュー再計算', () => {
    it('replaceCurrent 完了後、crossNoteResults が新しい model 内容で再計算される', () => {
      const model = createFakeModel('inmemory://n1', 'foo bar foo');
      const ed = makeFakeEditor(model);
      const ctx = setupContext({
        ed,
        activeNoteId: 'n1',
        notes: [mkNote('n1', 'N1', 'foo bar foo')],
      });
      useSearchReplaceStore.setState({
        query: 'foo',
        replacement: 'baz',
        currentMatches: [
          { start: 0, end: 3, matchText: 'foo', groups: ['foo'] },
          { start: 8, end: 11, matchText: 'foo', groups: ['foo'] },
        ],
        currentMatchIndex: 0,
        // 古い crossNoteResults: 2 件のヒット
        crossNoteResults: [
          {
            noteId: 'n1',
            noteTitle: 'N1',
            content: 'foo bar foo',
            matches: [
              { start: 0, end: 3, matchText: 'foo', groups: ['foo'] },
              { start: 8, end: 11, matchText: 'foo', groups: ['foo'] },
            ],
          },
        ],
      });
      useSearchReplaceStore.getState().replaceCurrent();
      const groups = useSearchReplaceStore.getState().crossNoteResults;
      // 1 件だけ置換されたので残り "foo" は 1 件のみ
      expect(groups).toHaveLength(1);
      expect(groups[0].matches).toHaveLength(1);
      void ctx;
    });

    it('replaceAllInCurrent 完了後、crossNoteResults からヒットが完全に消える', () => {
      const model = createFakeModel('inmemory://n1', 'foo bar foo');
      const ed = makeFakeEditor(model);
      const ctx = setupContext({
        ed,
        activeNoteId: 'n1',
        notes: [mkNote('n1', 'N1', 'foo bar foo')],
      });
      useSearchReplaceStore.setState({
        query: 'foo',
        replacement: 'baz',
        currentMatches: [
          { start: 0, end: 3, matchText: 'foo', groups: ['foo'] },
          { start: 8, end: 11, matchText: 'foo', groups: ['foo'] },
        ],
        currentMatchIndex: 0,
        crossNoteResults: [
          {
            noteId: 'n1',
            noteTitle: 'N1',
            content: 'foo bar foo',
            matches: [
              { start: 0, end: 3, matchText: 'foo', groups: ['foo'] },
              { start: 8, end: 11, matchText: 'foo', groups: ['foo'] },
            ],
          },
        ],
      });
      useSearchReplaceStore.getState().replaceAllInCurrent();
      // 全件置換されたので groups は空
      expect(useSearchReplaceStore.getState().crossNoteResults).toEqual([]);
      void ctx;
    });
  });

  describe('replaceAllInAllNotes (スコープ別の置換対象)', () => {
    const setupCommon = (
      notes: Note[],
      fileNotes: FileNote[],
      crossNoteResults: Array<{
        noteId: string;
        noteTitle: string;
        content: string;
        matches: Array<{ start: number; end: number; matchText: string }>;
      }>,
    ) => {
      const ctx = setupContext({ notes, fileNotes, ed: null });
      useSearchReplaceStore.setState({
        query: 'foo',
        replacement: 'bar',
        crossNoteResults: crossNoteResults.map((g) => ({
          ...g,
          matches: g.matches.map((m) => ({ ...m, groups: [m.matchText] })),
        })),
      });
      return ctx;
    };

    it('scope="all": Notes と FileNotes 両方が更新され、SaveNote は Notes のみ', async () => {
      const notes = [mkNote('n1', 'N1', 'foo')];
      const fileNotes = [mkFileNote('f1', 'a.md', 'foo', 'foo')];
      const ctx = setupCommon(notes, fileNotes, [
        {
          noteId: 'n1',
          noteTitle: 'N1',
          content: 'foo',
          matches: [{ start: 0, end: 3, matchText: 'foo' }],
        },
        {
          noteId: 'f1',
          noteTitle: 'a.md',
          content: 'foo',
          matches: [{ start: 0, end: 3, matchText: 'foo' }],
        },
      ]);
      await useSearchReplaceStore.getState().replaceAllInAllNotes();

      // Notes 更新
      expect(ctx.setNotesSpy).toHaveBeenCalledTimes(1);
      expect(ctx.notesRef.notes[0].content).toBe('bar');
      // FileNotes 更新（content だけ、originalContent はそのまま）
      expect(ctx.setFileNotesSpy).toHaveBeenCalledTimes(1);
      expect(ctx.fileNotesRef.fileNotes[0].content).toBe('bar');
      expect(ctx.fileNotesRef.fileNotes[0].originalContent).toBe('foo');
      // ディスク保存系: SaveNote のみ呼ばれる
      expect(SaveNote as Mock).toHaveBeenCalledTimes(1);
    });

    it('scope="notes": Notes のみ更新、FileNotes は触らない', async () => {
      const notes = [mkNote('n1', 'N1', 'foo')];
      const fileNotes = [mkFileNote('f1', 'a.md', 'foo', 'foo')];
      // recomputeCrossNoteMatches を経由していない直接セットを再現する。
      // scope='notes' のときは crossNoteResults に Notes だけが入る前提。
      const ctx = setupCommon(notes, fileNotes, [
        {
          noteId: 'n1',
          noteTitle: 'N1',
          content: 'foo',
          matches: [{ start: 0, end: 3, matchText: 'foo' }],
        },
      ]);
      useSearchReplaceStore.setState({ scope: 'notes' });
      await useSearchReplaceStore.getState().replaceAllInAllNotes();

      expect(ctx.setNotesSpy).toHaveBeenCalledTimes(1);
      expect(ctx.notesRef.notes[0].content).toBe('bar');
      // FileNotes は完全に未更新
      expect(ctx.setFileNotesSpy).not.toHaveBeenCalled();
      expect(ctx.fileNotesRef.fileNotes[0].content).toBe('foo');
    });

    it('scope="local": FileNotes のみ更新、Notes は触らず SaveNote も呼ばれない', async () => {
      const notes = [mkNote('n1', 'N1', 'foo')];
      const fileNotes = [mkFileNote('f1', 'a.md', 'foo', 'foo')];
      const ctx = setupCommon(notes, fileNotes, [
        {
          noteId: 'f1',
          noteTitle: 'a.md',
          content: 'foo',
          matches: [{ start: 0, end: 3, matchText: 'foo' }],
        },
      ]);
      useSearchReplaceStore.setState({ scope: 'local' });
      await useSearchReplaceStore.getState().replaceAllInAllNotes();

      expect(ctx.setFileNotesSpy).toHaveBeenCalledTimes(1);
      expect(ctx.fileNotesRef.fileNotes[0].content).toBe('bar');
      // dirty 維持
      expect(ctx.fileNotesRef.fileNotes[0].originalContent).toBe('foo');
      expect(ctx.setNotesSpy).not.toHaveBeenCalled();
      expect(SaveNote as Mock).not.toHaveBeenCalled();
    });

    it('置換後に crossNoteResults が再計算され、消費済みマッチがプレビューから消える', async () => {
      // active note (n1) はモデルに置換対象 "foo" を持つ。
      // 別ノート (n2) は置換対象なし。
      createFakeModel('inmemory://n1', 'foo foo');
      createFakeModel('inmemory://n2', 'baz');
      const ed = makeFakeEditor(modelStore.get('inmemory://n1') ?? null);
      const ctx = setupContext({
        ed,
        activeNoteId: 'n1',
        notes: [mkNote('n1', 'N1', 'foo foo'), mkNote('n2', 'N2', 'baz')],
      });
      useSearchReplaceStore.setState({
        query: 'foo',
        replacement: 'bar',
        scope: 'all',
        // 置換前の状態として n1 にヒットがある crossNoteResults を入れておく
        crossNoteResults: [
          {
            noteId: 'n1',
            noteTitle: 'N1',
            content: 'foo foo',
            matches: [
              { start: 0, end: 3, matchText: 'foo', groups: ['foo'] },
              { start: 4, end: 7, matchText: 'foo', groups: ['foo'] },
            ],
          },
        ],
      });
      // showMessage を確認 OK にして実行
      await useSearchReplaceStore.getState().replaceAllInAllNotes();

      const groups = useSearchReplaceStore.getState().crossNoteResults;
      // 置換完了後はクエリ "foo" がどのノートにも残っていないので結果は空
      expect(groups).toEqual([]);
      void ctx;
    });

    it('FileNote 置換は originalContent を変えず content !== originalContent (dirty) を維持する', async () => {
      const fileNotes = [
        mkFileNote('f1', 'a.md', 'foo foo foo', 'foo foo foo'),
      ];
      const ctx = setupCommon([], fileNotes, [
        {
          noteId: 'f1',
          noteTitle: 'a.md',
          content: 'foo foo foo',
          matches: [
            { start: 0, end: 3, matchText: 'foo' },
            { start: 4, end: 7, matchText: 'foo' },
            { start: 8, end: 11, matchText: 'foo' },
          ],
        },
      ]);
      await useSearchReplaceStore.getState().replaceAllInAllNotes();
      const fn = ctx.fileNotesRef.fileNotes[0];
      expect(fn.content).toBe('bar bar bar');
      expect(fn.originalContent).toBe('foo foo foo');
      expect(fn.content).not.toBe(fn.originalContent);
    });
  });

  describe('crossNoteResults / scope の組合せ (recomputeCrossNoteMatches)', () => {
    // scheduleRecompute は setTimeout で遅延されるため、setScope では結果反映を待つ必要がある。
    // ここでは public な経路（setScope → 結果反映）を timer 進行で観測する。
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('scope="all" は Notes と FileNotes の両方を crossNoteResults に積む（ローカル先頭順）', () => {
      const noteModel = createFakeModel('inmemory://n1', 'foo');
      const fileModel = createFakeModel('inmemory://f1', 'foo');
      const ed = makeFakeEditor(noteModel);
      setupContext({
        ed,
        activeNoteId: 'n1',
        notes: [mkNote('n1', 'N1', 'foo')],
        fileNotes: [mkFileNote('f1', 'a.md', 'foo')],
      });
      useSearchReplaceStore.setState({ scope: 'all' });
      useSearchReplaceStore.getState().setQuery('foo');
      vi.advanceTimersByTime(500);
      const groups = useSearchReplaceStore.getState().crossNoteResults;
      expect(groups.map((g) => g.noteId)).toEqual(['f1', 'n1']);
      // 仕方なく見えていない: setValue を model にしていないので model が無いノートは note.content fallback。
      // ここでは両方とも content="foo" なので両方 1 件ずつ。
      expect(groups.every((g) => g.matches.length === 1)).toBe(true);
      // 片付け
      void noteModel;
      void fileModel;
    });

    it('scope="notes" は Notes のみ crossNoteResults に積む', () => {
      createFakeModel('inmemory://n1', 'foo');
      createFakeModel('inmemory://f1', 'foo');
      const ed = makeFakeEditor(modelStore.get('inmemory://n1') ?? null);
      setupContext({
        ed,
        activeNoteId: 'n1',
        notes: [mkNote('n1', 'N1', 'foo')],
        fileNotes: [mkFileNote('f1', 'a.md', 'foo')],
      });
      useSearchReplaceStore.setState({ scope: 'notes' });
      useSearchReplaceStore.getState().setQuery('foo');
      vi.advanceTimersByTime(500);
      const groups = useSearchReplaceStore.getState().crossNoteResults;
      expect(groups.map((g) => g.noteId)).toEqual(['n1']);
    });

    it('scope="local" は FileNotes のみ crossNoteResults に積む', () => {
      createFakeModel('inmemory://n1', 'foo');
      createFakeModel('inmemory://f1', 'foo');
      const ed = makeFakeEditor(modelStore.get('inmemory://n1') ?? null);
      setupContext({
        ed,
        activeNoteId: 'n1',
        notes: [mkNote('n1', 'N1', 'foo')],
        fileNotes: [mkFileNote('f1', 'a.md', 'foo')],
      });
      useSearchReplaceStore.setState({ scope: 'local' });
      useSearchReplaceStore.getState().setQuery('foo');
      vi.advanceTimersByTime(500);
      const groups = useSearchReplaceStore.getState().crossNoteResults;
      expect(groups.map((g) => g.noteId)).toEqual(['f1']);
    });

    it('archived ノートは crossNoteResults に含めない', () => {
      const archived: Note = {
        ...mkNote('a1', 'A', 'foo'),
        archived: true,
      };
      createFakeModel('inmemory://a1', 'foo');
      createFakeModel('inmemory://n1', 'foo');
      const ed = makeFakeEditor(modelStore.get('inmemory://n1') ?? null);
      setupContext({
        ed,
        activeNoteId: 'n1',
        notes: [archived, mkNote('n1', 'N1', 'foo')],
      });
      useSearchReplaceStore.setState({ scope: 'all' });
      useSearchReplaceStore.getState().setQuery('foo');
      vi.advanceTimersByTime(500);
      const groups = useSearchReplaceStore.getState().crossNoteResults;
      expect(groups.map((g) => g.noteId)).toEqual(['n1']);
    });
  });
});

const _typeAssertScope: SearchScope = 'all';
void _typeAssertScope;
