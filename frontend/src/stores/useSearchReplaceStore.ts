import { create } from 'zustand';

import { SaveNote } from '../../wailsjs/go/backend/App';
import { backend } from '../../wailsjs/go/models';
import { getMonaco } from '../lib/monaco';
import {
  applyEditsToString,
  buildReplacementEdits,
  compileSearchRegex,
  findAllMatches,
  type PlannedEdit,
  type SearchMatch,
  type SearchOptions,
} from '../utils/searchUtils';
import { showMessage } from './useMessageDialogStore';

import type { editor } from 'monaco-editor';
import type { FileNote, Note } from '../types';

// ノート横断検索は常に有効。find / replace は置換欄の表示切替のみ。
export type SearchPanelMode = 'find' | 'replace';

// 検索対象スコープ。
// - all: ノート + ローカルファイルの両方を検索
// - local: ローカルファイルのみを検索（ノートのフィルタ・横断検索は無効）
// - notes: ノートのみを検索（ローカルのフィルタ・横断検索は無効）
export type SearchScope = 'all' | 'local' | 'notes';

export type ReplaceResultKind =
  | 'replaceOne'
  | 'replaceAllInCurrent'
  | 'replaceAllInAll';

export interface ReplaceResult {
  kind: ReplaceResultKind;
  count: number;
  token: number;
}

export interface NoteMatchGroup {
  noteId: string;
  noteTitle: string;
  content: string;
  matches: SearchMatch[];
}

// Engine が共有する依存。App.tsx 側で `setContext` を通じて登録する。
// ストアに「依存性注入」している形。
interface SearchReplaceContext {
  getNotes: () => Note[];
  getFileNotes: () => FileNote[];
  setNotes: (updater: (prev: Note[]) => Note[]) => void;
  setFileNotes: (updater: (prev: FileNote[]) => FileNote[]) => void;
  getActiveEditor: () => editor.IStandaloneCodeEditor | null;
  getActiveNoteId: () => string | null;
  t: (key: string, args?: Record<string, string | number>) => string;
  // 検索結果ツリーから別ノートにジャンプするときに呼ぶ。App から登録する。
  onSelectNote: (noteId: string) => Promise<void> | void;
}

const NOOP_CONTEXT: SearchReplaceContext = {
  getNotes: () => [],
  getFileNotes: () => [],
  setNotes: () => {},
  setFileNotes: () => {},
  getActiveEditor: () => null,
  getActiveNoteId: () => null,
  t: (key) => key,
  onSelectNote: () => {},
};

interface SearchReplaceState {
  context: SearchReplaceContext;
  mode: SearchPanelMode;
  query: string;
  replacement: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  scope: SearchScope;
  focusToken: number;
  // ロケート（前/次）を一度でも押したかどうか。
  // false 状態での findNext は先頭マッチへ、findPrevious は末尾マッチへ
  // ジャンプし、エディタ既存のキャレット位置を考慮しない。
  // 以降の押下は selection 末端／始点を基準にした caret ベースで進む。
  searchNavigated: boolean;
  replaceResult: ReplaceResult | null;
  replaceResultToken: number;
  currentMatches: SearchMatch[];
  currentMatchIndex: number;
  crossNoteResults: NoteMatchGroup[];
  // 別ノートに切替えてからジャンプを反映するための保留情報
  pendingJump: { noteId: string; matchIndexInNote: number } | null;
}

interface SearchReplaceActions {
  setContext: (ctx: Partial<SearchReplaceContext>) => void;
  setMode: (mode: SearchPanelMode) => void;
  setQuery: (query: string) => void;
  setReplacement: (replacement: string) => void;
  setCaseSensitive: (v: boolean) => void;
  setWholeWord: (v: boolean) => void;
  setUseRegex: (v: boolean) => void;
  setScope: (v: SearchScope) => void;
  focusFind: (mode?: SearchPanelMode) => void;
  clearQuery: () => void;
  findNext: () => void;
  findPrevious: () => void;
  jumpToNoteMatch: (noteId: string, matchIndexInNote: number) => void;
  replaceCurrent: () => void;
  replaceAllInCurrent: () => void;
  replaceAllInAllNotes: () => Promise<void>;
}

// =========================================================================
// Monaco ブリッジ（モジュールレベル）
//
// 旧 <SearchReplaceEngine /> の useEffect 群はすべてここに置き換わっている。
// React 外で副作用を完結させることで、useEffect の deps ミスや StrictMode の
// 二重実行・「state 変化監視で副作用」アンチパターンを根本的に回避する。
// =========================================================================

const DECORATION_CLASS_ALL = 'app-search-match';
const DECORATION_CLASS_CURRENT = 'app-search-match-current';

let decorationIds: string[] = [];
let recomputeTimer: ReturnType<typeof setTimeout> | null = null;
let crossNoteTimer: ReturnType<typeof setTimeout> | null = null;
let typingTimer: ReturnType<typeof setTimeout> | null = null;
let monacoListenersCleanup: (() => void) | null = null;
let attachedEditor: editor.IStandaloneCodeEditor | null = null;
let initialized = false;

const buildOptions = (): SearchOptions => {
  const s = useSearchReplaceStore.getState();
  return {
    query: s.query,
    caseSensitive: s.caseSensitive,
    wholeWord: s.wholeWord,
    useRegex: s.useRegex,
  };
};

const updateDecorations = (matches: SearchMatch[], activeIndex: number) => {
  const ed = useSearchReplaceStore.getState().context.getActiveEditor();
  if (!ed) return;
  const model = ed.getModel();
  if (!model) return;
  const monaco = getMonaco();
  const newDecorations = matches.map((m, idx) => {
    const startPos = model.getPositionAt(m.start);
    const endPos = model.getPositionAt(m.end);
    return {
      range: new monaco.Range(
        startPos.lineNumber,
        startPos.column,
        endPos.lineNumber,
        endPos.column,
      ),
      options: {
        inlineClassName:
          idx === activeIndex ? DECORATION_CLASS_CURRENT : DECORATION_CLASS_ALL,
        stickiness:
          monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    };
  });
  decorationIds = ed.deltaDecorations(decorationIds, newDecorations);
};

// 現在マッチの装飾更新 + 該当箇所をエディタ中央へスクロール
const updateDecorationsAndScroll = () => {
  const s = useSearchReplaceStore.getState();
  updateDecorations(s.currentMatches, s.currentMatchIndex);
  const m = s.currentMatches[s.currentMatchIndex];
  const ed = s.context.getActiveEditor();
  if (!ed || !m) return;
  const model = ed.getModel();
  if (!model) return;
  const monaco = getMonaco();
  const startPos = model.getPositionAt(m.start);
  const endPos = model.getPositionAt(m.end);
  const range = new monaco.Range(
    startPos.lineNumber,
    startPos.column,
    endPos.lineNumber,
    endPos.column,
  );
  ed.setSelection(range);
  ed.revealRangeInCenter(range);
};

// 配列のマッチが内容として等価かを浅く比較する。
// 参照が変わっても中身が同じなら setState を抑止し、購読側の不要な再描画を防ぐ。
const matchesEqual = (a: SearchMatch[], b: SearchMatch[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].start !== b[i].start ||
      a[i].end !== b[i].end ||
      a[i].matchText !== b[i].matchText
    )
      return false;
  }
  return true;
};

// 現在ノートのマッチを再計算。終了時に装飾更新と pendingJump 消化まで一気に行う。
const recomputeCurrentMatches = () => {
  // エディタインスタンスが切り替わっていた場合に備えて毎回チェック
  ensureMonacoListeners();
  const s = useSearchReplaceStore.getState();
  const ed = s.context.getActiveEditor();
  const model = ed?.getModel();
  const patternErr = computePatternError(s);
  const options = buildOptions();
  if (!ed || !model || !s.query || patternErr) {
    // すでに空ならここで止める。新しい [] を書くと Zustand は別参照とみなして
    // 購読者を再描画してしまう（特にノート切替時の onDidChangeModel 経路）。
    if (s.currentMatches.length !== 0 || s.currentMatchIndex !== 0) {
      useSearchReplaceStore.setState({
        currentMatches: [],
        currentMatchIndex: 0,
      });
    }
    if (ed) decorationIds = ed.deltaDecorations(decorationIds, []);
    return;
  }
  const text = model.getValue();
  const matches = findAllMatches(text, options);
  const nextIndex =
    matches.length === 0
      ? 0
      : Math.min(s.currentMatchIndex, matches.length - 1);
  // 内容が変わらない場合は setState を打たない。タイピング中は同じヒット集合
  // のまま recompute が連打されるので、ここで止めると panel の再描画が消える。
  if (
    !matchesEqual(s.currentMatches, matches) ||
    s.currentMatchIndex !== nextIndex
  ) {
    useSearchReplaceStore.setState({
      currentMatches: matches,
      currentMatchIndex: nextIndex,
    });
  }
  updateDecorationsAndScroll();

  // 別ノートへの jump 保留があれば、ここで消化する
  // （jumpToNoteMatch がトリガーになり、ノート切替後の再計算が来たタイミングで反映する）
  const after = useSearchReplaceStore.getState();
  if (after.pendingJump) {
    const activeId = after.context.getActiveNoteId();
    if (
      activeId === after.pendingJump.noteId &&
      after.currentMatches.length > 0
    ) {
      const idx = Math.min(
        after.pendingJump.matchIndexInNote,
        after.currentMatches.length - 1,
      );
      useSearchReplaceStore.setState({
        pendingJump: null,
        currentMatchIndex: idx,
      });
      updateDecorationsAndScroll();
    }
  }
};

// crossNoteResults の浅い等価比較。内容が同じなら setState を抑止する。
const crossNoteResultsEqual = (
  a: NoteMatchGroup[],
  b: NoteMatchGroup[],
): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.noteId !== y.noteId ||
      x.noteTitle !== y.noteTitle ||
      x.content !== y.content ||
      !matchesEqual(x.matches, y.matches)
    )
      return false;
  }
  return true;
};

const recomputeCrossNoteMatches = () => {
  const s = useSearchReplaceStore.getState();
  const patternErr = computePatternError(s);
  const options = buildOptions();
  if (!s.query || patternErr) {
    if (s.crossNoteResults.length !== 0) {
      useSearchReplaceStore.setState({ crossNoteResults: [] });
    }
    return;
  }
  const results: NoteMatchGroup[] = [];
  const activeId = s.context.getActiveNoteId();
  // ローカルファイルを先に積む（サイドバーの並び＝上にローカル / 下にノート、と一致させる）。
  // scope='notes' のときはローカルファイルを検索対象から外す。
  if (s.scope !== 'notes') {
    for (const fn of s.context.getFileNotes()) {
      let content = fn.content ?? '';
      if (fn.id === activeId) {
        const ed = s.context.getActiveEditor();
        const model = ed?.getModel();
        if (model) content = model.getValue();
      } else {
        const monaco = getMonaco();
        const uri = monaco.Uri.parse(`inmemory://${fn.id}`);
        const m = monaco.editor.getModel(uri);
        if (m && !m.isDisposed()) content = m.getValue();
      }
      const matches = findAllMatches(content, options);
      if (matches.length > 0) {
        results.push({
          noteId: fn.id,
          noteTitle: fn.fileName,
          content,
          matches,
        });
      }
    }
  }
  // scope='local' のときはノートを検索対象から外す
  if (s.scope !== 'local') {
    for (const note of s.context.getNotes()) {
      if (note.archived) continue;
      let content = note.content ?? '';
      if (note.id === activeId) {
        const ed = s.context.getActiveEditor();
        const model = ed?.getModel();
        if (model) content = model.getValue();
      } else {
        const monaco = getMonaco();
        const uri = monaco.Uri.parse(`inmemory://${note.id}`);
        const m = monaco.editor.getModel(uri);
        if (m && !m.isDisposed()) content = m.getValue();
      }
      const matches = findAllMatches(content, options);
      if (matches.length > 0) {
        results.push({
          noteId: note.id,
          noteTitle: note.title,
          content,
          matches,
        });
      }
    }
  }
  if (!crossNoteResultsEqual(s.crossNoteResults, results)) {
    useSearchReplaceStore.setState({ crossNoteResults: results });
  }
};

// クエリ／オプション変更時の debounced 再計算スケジューラ
// （旧 useEffect の役割。setQuery/setCaseSensitive 等のアクションから直接呼ばれる）
const scheduleRecompute = () => {
  if (recomputeTimer) clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(() => {
    recomputeTimer = null;
    recomputeCurrentMatches();
  }, 150);
  if (crossNoteTimer) clearTimeout(crossNoteTimer);
  crossNoteTimer = setTimeout(() => {
    crossNoteTimer = null;
    recomputeCrossNoteMatches();
  }, 250);
};

// アクティブエディタ変化に応じて Monaco リスナを attach し直す。
// `attachedEditor` がアタッチ済みのエディタを指している間は再 attach をスキップする。
// 複数の入口（subscribe / ensureMonacoListeners）から呼んでも冪等になる。
const reattachMonacoListeners = () => {
  const ed = useSearchReplaceStore.getState().context.getActiveEditor();
  if (ed === attachedEditor) return;
  monacoListenersCleanup?.();
  monacoListenersCleanup = null;
  attachedEditor = null;
  decorationIds = [];

  if (!ed) return;

  let contentDisposable: { dispose: () => void } | null = null;
  const attachToModel = () => {
    contentDisposable?.dispose();
    contentDisposable = null;
    const model = ed.getModel();
    if (!model) return;
    contentDisposable = model.onDidChangeContent(() => {
      if (typingTimer) clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        typingTimer = null;
        recomputeCurrentMatches();
      }, 250);
    });
  };
  attachToModel();
  const modelDisposable = ed.onDidChangeModel(() => {
    attachToModel();
    recomputeCurrentMatches();
  });

  monacoListenersCleanup = () => {
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = null;
    contentDisposable?.dispose();
    modelDisposable.dispose();
  };
  attachedEditor = ed;

  // 新しいエディタで現状のクエリに対する装飾を即時反映する
  recomputeCurrentMatches();
};

// 現在のアクティブエディタにリスナが付いていなければ付け直す。
// `recomputeCurrentMatches` の入口でも呼んで「最初の編集タイミングで listener が無くて
// 以後ノート切替を取りこぼす」事故を防ぐ。
const ensureMonacoListeners = () => {
  const ed = useSearchReplaceStore.getState().context.getActiveEditor();
  if (ed !== attachedEditor) {
    reattachMonacoListeners();
  }
};

// =========================================================================
// 起動時に 1 度だけ呼ぶ初期化関数。
// アクティブエディタの差し替え（split toggle / focused pane 切替）に追随して
// Monaco リスナを attach し直す。
// =========================================================================
export const initSearchReplace = () => {
  if (initialized) return;
  initialized = true;
  // context 自体（=getActiveEditor を含むオブジェクト）が差し変わるたびに再評価する。
  // 実際の attach/detach は `attachedEditor` との一致比較で短絡されるので冪等。
  // この経路だけだとマウント直後にエディタ未生成のケースを取りこぼすので、
  // recomputeCurrentMatches 入口の ensureMonacoListeners が遅延リカバリを担う。
  useSearchReplaceStore.subscribe((state, prevState) => {
    if (state.context !== prevState.context) {
      reattachMonacoListeners();
    }
  });
};

// =========================================================================
// 置換ヘルパ（既存）
// =========================================================================

const announce = (
  set: (
    partial:
      | Partial<SearchReplaceState>
      | ((s: SearchReplaceState) => Partial<SearchReplaceState>),
  ) => void,
  kind: ReplaceResultKind,
  count: number,
) => {
  set((s) => ({
    replaceResult: { kind, count, token: s.replaceResultToken + 1 },
    replaceResultToken: s.replaceResultToken + 1,
  }));
};

const applyEditsToModel = (model: editor.ITextModel, edits: PlannedEdit[]) => {
  const monaco = getMonaco();
  const monacoEdits = edits.map((e) => {
    const startPos = model.getPositionAt(e.start);
    const endPos = model.getPositionAt(e.end);
    return {
      range: new monaco.Range(
        startPos.lineNumber,
        startPos.column,
        endPos.lineNumber,
        endPos.column,
      ),
      text: e.replacement,
      forceMoveMarkers: true,
    };
  });
  model.pushStackElement();
  model.pushEditOperations([], monacoEdits, () => null);
  model.pushStackElement();
};

const tryGetModel = (noteId: string): editor.ITextModel | null => {
  const monaco = getMonaco();
  const uri = monaco.Uri.parse(`inmemory://${noteId}`);
  const model = monaco.editor.getModel(uri);
  if (!model || model.isDisposed()) return null;
  return model;
};

const applyEditsToNote = (
  noteId: string,
  currentContent: string,
  edits: PlannedEdit[],
): string => {
  const model = tryGetModel(noteId);
  if (model) {
    applyEditsToModel(model, edits);
    return model.getValue();
  }
  return applyEditsToString(currentContent, edits);
};

// =========================================================================
// Store 本体
// =========================================================================
export const useSearchReplaceStore = create<
  SearchReplaceState & SearchReplaceActions
>((set, get) => ({
  context: NOOP_CONTEXT,
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

  setContext: (ctx) =>
    set((s) => ({ context: { ...s.context, ...ctx } as SearchReplaceContext })),

  setMode: (mode) => {
    // 置換 → 検索 に戻したらフィードバック表示はクリアする
    set((s) => ({
      mode,
      replaceResult: mode === 'find' ? null : s.replaceResult,
    }));
  },
  // 入力系 setter は debounce 付き再計算をその場でスケジュールする。
  // 旧 useEffect で query などを監視していた挙動を、値を変えている張本人の
  // アクション側に取り込んだ形（useEffect-guard 推奨パターン）。
  // クエリやオプション変更時は searchNavigated をリセット。
  // 次の find* 押下が新しいセッション扱いになり、キャレット無視で先頭/末尾から始まる。
  setQuery: (query) => {
    set({ query, searchNavigated: false });
    scheduleRecompute();
  },
  setReplacement: (replacement) => set({ replacement }),
  setCaseSensitive: (caseSensitive) => {
    set({ caseSensitive, searchNavigated: false });
    scheduleRecompute();
  },
  setWholeWord: (wholeWord) => {
    set({ wholeWord, searchNavigated: false });
    scheduleRecompute();
  },
  setUseRegex: (useRegex) => {
    set({ useRegex, searchNavigated: false });
    scheduleRecompute();
  },
  setScope: (scope) => {
    set({ scope, searchNavigated: false });
    // スコープ変更でクロスノート検索結果に含まれる対象が変わるので再計算
    scheduleRecompute();
  },

  focusFind: (nextMode = 'find') =>
    set((s) => ({ mode: nextMode, focusToken: s.focusToken + 1 })),
  clearQuery: () => {
    set({ query: '', replacement: '', searchNavigated: false });
    scheduleRecompute();
  },

  findNext: () => {
    const s = get();
    // 現ノート内にマッチがある場合の処理。
    if (s.currentMatches.length > 0) {
      // 検索ロケート開始（searchNavigated=false）はキャレット位置を無視して先頭マッチへ。
      if (!s.searchNavigated) {
        set({ currentMatchIndex: 0, searchNavigated: true });
        updateDecorationsAndScroll();
        return;
      }
      // 2 回目以降は selection 末端を基準に次マッチへ。
      // updateDecorationsAndScroll が setSelection でマッチを選択するので
      // 自然と「現マッチ末端より後ろの最初のヒット = 次マッチ」になる。
      const ed = s.context.getActiveEditor();
      const model = ed?.getModel();
      const sel = ed?.getSelection();
      if (ed && model && sel) {
        const refOffset = model.getOffsetAt(sel.getEndPosition());
        const nextIdx = s.currentMatches.findIndex((m) => m.start >= refOffset);
        if (nextIdx >= 0) {
          set({ currentMatchIndex: nextIdx, searchNavigated: true });
          updateDecorationsAndScroll();
          return;
        }
        // 選択末端が最終マッチ以降 → クロスノート / 先頭ラップへフォールスルー
      } else if (s.currentMatchIndex < s.currentMatches.length - 1) {
        // エディタが取得できない場合のフォールバック（インデックスベース）
        set({
          currentMatchIndex: s.currentMatchIndex + 1,
          searchNavigated: true,
        });
        updateDecorationsAndScroll();
        return;
      }
    }
    // 現ノートの最終マッチ（または現ノートにマッチが無い）→ 次ノートへ
    const groups = s.crossNoteResults;
    if (groups.length === 0) {
      // クロスノート結果が無いときは現ノート内ループを維持
      if (s.currentMatches.length > 0) {
        set({ currentMatchIndex: 0, searchNavigated: true });
        updateDecorationsAndScroll();
      }
      return;
    }
    const activeId = s.context.getActiveNoteId();
    const curIdx = groups.findIndex((g) => g.noteId === activeId);
    // 単一グループ＝現ノートのみのときは先頭にループ
    if (groups.length === 1 && curIdx === 0) {
      set({ currentMatchIndex: 0, searchNavigated: true });
      updateDecorationsAndScroll();
      return;
    }
    // 現ノートが結果に含まれていない場合は先頭グループへ、そうでなければ次のグループへ
    const nextIdx = curIdx < 0 ? 0 : (curIdx + 1) % groups.length;
    const target = groups[nextIdx];
    if (!target) return;
    set({
      pendingJump: { noteId: target.noteId, matchIndexInNote: 0 },
      searchNavigated: true,
    });
    void s.context.onSelectNote(target.noteId);
  },
  findPrevious: () => {
    const s = get();
    if (s.currentMatches.length > 0) {
      // 検索ロケート開始（searchNavigated=false）はキャレット位置を無視して末尾マッチへ。
      if (!s.searchNavigated) {
        set({
          currentMatchIndex: s.currentMatches.length - 1,
          searchNavigated: true,
        });
        updateDecorationsAndScroll();
        return;
      }
      // 2 回目以降は selection 始点を基準に前マッチへ。
      const ed = s.context.getActiveEditor();
      const model = ed?.getModel();
      const sel = ed?.getSelection();
      if (ed && model && sel) {
        const refOffset = model.getOffsetAt(sel.getStartPosition());
        let prevIdx = -1;
        for (let i = s.currentMatches.length - 1; i >= 0; i--) {
          if (s.currentMatches[i].start < refOffset) {
            prevIdx = i;
            break;
          }
        }
        if (prevIdx >= 0) {
          set({ currentMatchIndex: prevIdx, searchNavigated: true });
          updateDecorationsAndScroll();
          return;
        }
        // 選択始点が先頭マッチ以前 → クロスノート / 末尾ラップへフォールスルー
      } else if (s.currentMatchIndex > 0) {
        // エディタが取得できない場合のフォールバック
        set({
          currentMatchIndex: s.currentMatchIndex - 1,
          searchNavigated: true,
        });
        updateDecorationsAndScroll();
        return;
      }
    }
    // 先頭マッチ → 前ノートの末尾マッチへ
    const groups = s.crossNoteResults;
    if (groups.length === 0) {
      if (s.currentMatches.length > 0) {
        set({
          currentMatchIndex: s.currentMatches.length - 1,
          searchNavigated: true,
        });
        updateDecorationsAndScroll();
      }
      return;
    }
    const activeId = s.context.getActiveNoteId();
    const curIdx = groups.findIndex((g) => g.noteId === activeId);
    if (groups.length === 1 && curIdx === 0) {
      set({
        currentMatchIndex: s.currentMatches.length - 1,
        searchNavigated: true,
      });
      updateDecorationsAndScroll();
      return;
    }
    const prevIdx =
      curIdx < 0
        ? groups.length - 1
        : (curIdx - 1 + groups.length) % groups.length;
    const target = groups[prevIdx];
    if (!target) return;
    // 末尾マッチへジャンプするため matchIndexInNote = matches.length - 1
    set({
      pendingJump: {
        noteId: target.noteId,
        matchIndexInNote: Math.max(0, target.matches.length - 1),
      },
      searchNavigated: true,
    });
    void s.context.onSelectNote(target.noteId);
  },

  jumpToNoteMatch: (noteId, matchIndexInNote) => {
    const { context } = get();
    // store の currentNote が先に更新されてもエディタのモデル swap は React の
    // useEffect 待ちなので、判定は **エディタの実モデル参照** で行う。
    // これを怠ると、クリック直後 onJumpToNoteMatch が活発な現マッチ
    // (currentMatches = 旧ノート) に対して即時インデックスを書き換えてしまい、
    // 装飾が旧ノートに対して貼られた挙動になる。
    // monaco は URI 単位でモデルをキャッシュするので、対象 URI の model が存在する場合は
    // 同一インスタンスが返る。参照比較で安全に判定できる。
    const ed = context.getActiveEditor();
    const editorModel = ed?.getModel();
    const monaco = getMonaco();
    const targetModel = monaco.editor.getModel(
      monaco.Uri.parse(`inmemory://${noteId}`),
    );
    if (editorModel && targetModel && editorModel === targetModel) {
      set({
        pendingJump: null,
        currentMatchIndex: matchIndexInNote,
        searchNavigated: true,
      });
      updateDecorationsAndScroll();
      return;
    }
    // モデルがまだ目標ノートになっていない（あるいは未生成）→ pendingJump を立てて
    // onDidChangeModel 経由の recomputeCurrentMatches で消化させる。
    set({
      pendingJump: { noteId, matchIndexInNote },
      searchNavigated: true,
    });
  },

  replaceCurrent: () => {
    const s = get();
    if (computePatternError(s)) return;
    const { context } = s;
    const ed = context.getActiveEditor();
    const model = ed?.getModel();
    if (!ed || !model) return;
    const noteId = context.getActiveNoteId();
    if (!noteId) return;
    const m = s.currentMatches[s.currentMatchIndex];
    if (!m) return;
    const edits = buildReplacementEdits([m], s.replacement, s.useRegex);
    if (edits.length === 0) return;
    applyEditsToModel(model, edits);
    const note = context.getNotes().find((n) => n.id === noteId);
    if (note) {
      const newContent = model.getValue();
      context.setNotes((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, content: newContent } : n)),
      );
      SaveNote(
        backend.Note.createFrom({ ...note, content: newContent }),
        'update',
      ).catch(() => {});
    }
    announce(set, 'replaceOne', 1);
    // 現在マッチは onDidChangeContent 経由で recompute がスケジュールされるが、
    // 横断検索結果は触られないため明示再計算する（パネルのプレビュー更新のため）。
    recomputeCurrentMatches();
    recomputeCrossNoteMatches();
  },

  replaceAllInCurrent: () => {
    const s = get();
    if (computePatternError(s)) return;
    const { context } = s;
    const ed = context.getActiveEditor();
    const model = ed?.getModel();
    if (!ed || !model) return;
    const noteId = context.getActiveNoteId();
    if (!noteId) return;
    if (s.currentMatches.length === 0) return;
    const edits = buildReplacementEdits(
      s.currentMatches,
      s.replacement,
      s.useRegex,
    );
    applyEditsToModel(model, edits);
    const note = context.getNotes().find((n) => n.id === noteId);
    if (note) {
      const newContent = model.getValue();
      context.setNotes((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, content: newContent } : n)),
      );
      SaveNote(
        backend.Note.createFrom({ ...note, content: newContent }),
        'update',
      ).catch(() => {});
    }
    announce(set, 'replaceAllInCurrent', edits.length);
    // 横断検索結果は onDidChangeContent では更新されないので明示再計算する。
    recomputeCurrentMatches();
    recomputeCrossNoteMatches();
  },

  replaceAllInAllNotes: async () => {
    const s = get();
    if (computePatternError(s)) return;
    if (s.crossNoteResults.length === 0) return;
    const { context } = s;
    const confirmed = await showMessage(
      context.t('searchReplace.confirmReplaceAllTitle'),
      context.t('searchReplace.confirmReplaceAllMessage', {
        noteCount: s.crossNoteResults.length,
        matchCount: s.crossNoteResults.reduce(
          (sum, g) => sum + g.matches.length,
          0,
        ),
      }),
      true,
      context.t('dialog.ok'),
      context.t('dialog.cancel'),
    );
    if (!confirmed) return;

    type PerEntry = {
      noteId: string;
      edits: PlannedEdit[];
      isFile: boolean;
    };
    const notes = context.getNotes();
    const fileNotes = context.getFileNotes();
    const perEntry: PerEntry[] = [];
    for (const group of s.crossNoteResults) {
      const edits = buildReplacementEdits(
        group.matches,
        s.replacement,
        s.useRegex,
      );
      if (edits.length === 0) continue;
      const isFile = !notes.some((n) => n.id === group.noteId);
      perEntry.push({ noteId: group.noteId, edits, isFile });
    }
    if (perEntry.length === 0) return;

    const updatedNotes: Note[] = [];
    const updatedFileNotes: FileNote[] = [];
    for (const p of perEntry) {
      if (p.isFile) {
        const fn = fileNotes.find((f) => f.id === p.noteId);
        if (!fn) continue;
        const newContent = applyEditsToNote(
          p.noteId,
          fn.content ?? '',
          p.edits,
        );
        // ファイルノートは content だけ更新。originalContent はそのままにして
        // dirty 判定 (content !== originalContent) を成立させ、ディスク保存はしない。
        updatedFileNotes.push({ ...fn, content: newContent });
      } else {
        const note = notes.find((n) => n.id === p.noteId);
        if (!note) continue;
        const newContent = applyEditsToNote(
          p.noteId,
          note.content ?? '',
          p.edits,
        );
        updatedNotes.push({ ...note, content: newContent });
      }
    }

    if (updatedNotes.length > 0) {
      context.setNotes((prev) =>
        prev.map((n) => updatedNotes.find((u) => u.id === n.id) ?? n),
      );
      for (const n of updatedNotes) {
        try {
          await SaveNote(backend.Note.createFrom(n), 'update');
        } catch {
          // ignore
        }
      }
    }
    if (updatedFileNotes.length > 0) {
      context.setFileNotes((prev) =>
        prev.map((f) => updatedFileNotes.find((u) => u.id === f.id) ?? f),
      );
      // ディスク保存は行わない。ユーザーが手動で Ctrl+S 保存する想定。
    }

    const totalReplaced = perEntry.reduce((sum, p) => sum + p.edits.length, 0);
    announce(set, 'replaceAllInAll', totalReplaced);

    // 全ノート置換後は、現在ノート/横断結果ともに再評価しておく
    recomputeCurrentMatches();
    recomputeCrossNoteMatches();
  },
}));

// 派生値: パターンエラー（クエリが正規表現としてコンパイルできるか）
export const computePatternError = (s: {
  context: { t: SearchReplaceContext['t'] };
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}): string | null => {
  if (!s.query) return null;
  const opts: SearchOptions = {
    query: s.query,
    caseSensitive: s.caseSensitive,
    wholeWord: s.wholeWord,
    useRegex: s.useRegex,
  };
  const re = compileSearchRegex(opts);
  return re ? null : s.context.t('searchReplace.invalidPattern');
};

export const usePatternError = (): string | null =>
  useSearchReplaceStore((s) => {
    if (!s.query) return null;
    const opts: SearchOptions = {
      query: s.query,
      caseSensitive: s.caseSensitive,
      wholeWord: s.wholeWord,
      useRegex: s.useRegex,
    };
    return compileSearchRegex(opts)
      ? null
      : s.context.t('searchReplace.invalidPattern');
  });

// 利便用エイリアス
export type { FileNote, Note };
