import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SaveNote } from '../../wailsjs/go/backend/App';
import { backend } from '../../wailsjs/go/models';
import { getMonaco } from '../lib/monaco';
import {
  applyEditsToString,
  buildReplacementEdits,
  compileSearchRegex,
  findAllMatches,
  type SearchMatch,
  type SearchOptions,
} from '../utils/searchUtils';
import {
  type BulkCommand,
  type BulkEdit,
  type CommandApplier,
  useBulkEditHistory,
} from './useBulkEditHistory';

import type { editor } from 'monaco-editor';
import type { Note } from '../types';

// ノート横断検索は常に有効。find / replace は置換欄の表示切替のみ。
export type SearchPanelMode = 'find' | 'replace';

export interface NoteMatchGroup {
  noteId: string;
  noteTitle: string;
  content: string; // スナップショット（プレビュー用）
  matches: SearchMatch[];
}

export interface UseSearchReplaceOptions {
  notes: Note[];
  setNotes: React.Dispatch<React.SetStateAction<Note[]>>;
  // 現在フォーカスされているエディタインスタンスを返す
  getActiveEditor: () => editor.IStandaloneCodeEditor | null;
  // 現在のノート ID を返す（Note のみ、FileNote は null）
  getActiveNoteId: () => string | null;
  // 競合時のユーザー確認
  showMessage: (
    title: string,
    message: string,
    isTwoButton?: boolean,
    primaryButtonText?: string,
    secondaryButtonText?: string,
  ) => Promise<boolean>;
  t: (key: string, args?: Record<string, string | number>) => string;
}

// デコレーションクラス（lib/monaco には触らず、パネルから style tag で付与）
const DECORATION_CLASS_ALL = 'app-search-match';
const DECORATION_CLASS_CURRENT = 'app-search-match-current';

// 指定モデルに対して編集を適用（pushEditOperations 経由で Monaco の undo stack に載せる）
const applyEditsToModel = (
  model: editor.ITextModel,
  edits: BulkEdit['edits'],
) => {
  const monaco = getMonaco();
  // Monaco は range ベースなので、offset から Position を導出
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

// ノート id から Monaco モデルを取得（なければ null）
const tryGetModel = (noteId: string): editor.ITextModel | null => {
  const monaco = getMonaco();
  const uri = monaco.Uri.parse(`inmemory://${noteId}`);
  const model = monaco.editor.getModel(uri);
  if (!model || model.isDisposed()) return null;
  return model;
};

// Note に一括編集を適用し、新しい content 文字列を返す。
// モデルがロードされていれば Monaco 経由で適用し、なければ文字列操作。
const applyEditsToNote = (
  noteId: string,
  currentContent: string,
  edits: BulkEdit['edits'],
): string => {
  const model = tryGetModel(noteId);
  if (model) {
    applyEditsToModel(model, edits);
    return model.getValue();
  }
  return applyEditsToString(currentContent, edits);
};

export const useSearchReplace = ({
  notes,
  setNotes,
  getActiveEditor,
  getActiveNoteId,
  showMessage,
  t,
}: UseSearchReplaceOptions) => {
  // ref を最新に同期
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const setNotesRef = useRef(setNotes);
  setNotesRef.current = setNotes;
  const getActiveEditorRef = useRef(getActiveEditor);
  getActiveEditorRef.current = getActiveEditor;
  const getActiveNoteIdRef = useRef(getActiveNoteId);
  getActiveNoteIdRef.current = getActiveNoteId;
  const tRef = useRef(t);
  tRef.current = t;

  // UI 状態（パネルは常時表示なので isOpen は持たない）
  const [mode, setMode] = useState<SearchPanelMode>('find');

  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  // 外部（Ctrl+F 等のショートカット）から入力フィールドへフォーカスを要求するトークン
  const [focusToken, setFocusToken] = useState(0);

  const options: SearchOptions = useMemo(
    () => ({ query, caseSensitive, wholeWord, useRegex }),
    [query, caseSensitive, wholeWord, useRegex],
  );

  const patternError = useMemo((): string | null => {
    if (!query) return null;
    const re = compileSearchRegex(options);
    return re ? null : tRef.current('searchReplace.invalidPattern');
  }, [options, query]);

  // --- 現在のノート用マッチ（アクティブエディタのモデル） ---
  const [currentMatches, setCurrentMatches] = useState<SearchMatch[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const decorationsRef = useRef<string[]>([]);

  // デコレーション更新
  const updateDecorations = useCallback(
    (matches: SearchMatch[], activeIndex: number) => {
      const ed = getActiveEditorRef.current();
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
              idx === activeIndex
                ? DECORATION_CLASS_CURRENT
                : DECORATION_CLASS_ALL,
            stickiness:
              monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        };
      });
      decorationsRef.current = ed.deltaDecorations(
        decorationsRef.current,
        newDecorations,
      );
    },
    [],
  );

  const clearDecorations = useCallback(() => {
    const ed = getActiveEditorRef.current();
    if (!ed) return;
    decorationsRef.current = ed.deltaDecorations(decorationsRef.current, []);
  }, []);

  // 現在のモデルから再計算
  const recomputeCurrentMatches = useCallback(() => {
    const ed = getActiveEditorRef.current();
    const model = ed?.getModel();
    if (!ed || !model || !query || patternError) {
      setCurrentMatches([]);
      setCurrentMatchIndex(0);
      decorationsRef.current = ed
        ? ed.deltaDecorations(decorationsRef.current, [])
        : [];
      return;
    }
    const text = model.getValue();
    const matches = findAllMatches(text, options);
    setCurrentMatches(matches);
    setCurrentMatchIndex((prev) => {
      if (matches.length === 0) return 0;
      return Math.min(prev, matches.length - 1);
    });
  }, [options, query, patternError]);

  // クエリ／オプション変更時に再計算（query が空なら内部でデコレーション解除）
  useEffect(() => {
    recomputeCurrentMatches();
  }, [recomputeCurrentMatches]);

  // クエリが空になったらハイライト消去
  useEffect(() => {
    if (!query) clearDecorations();
  }, [query, clearDecorations]);

  // エディタの内容が変わったら再計算（デバウンス）
  useEffect(() => {
    const ed = getActiveEditorRef.current();
    const model = ed?.getModel();
    if (!ed || !model) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const dispose = model.onDidChangeContent(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => recomputeCurrentMatches(), 120);
    });
    return () => {
      if (timer) clearTimeout(timer);
      dispose.dispose();
    };
  }, [recomputeCurrentMatches]);

  // current match が変わったらハイライト更新＋スクロール
  useEffect(() => {
    updateDecorations(currentMatches, currentMatchIndex);
    const m = currentMatches[currentMatchIndex];
    const ed = getActiveEditorRef.current();
    if (ed && m) {
      const model = ed.getModel();
      if (model) {
        const monaco = getMonaco();
        const startPos = model.getPositionAt(m.start);
        const endPos = model.getPositionAt(m.end);
        const range = new monaco.Range(
          startPos.lineNumber,
          startPos.column,
          endPos.lineNumber,
          endPos.column,
        );
        ed.revealRangeInCenterIfOutsideViewport(range);
      }
    }
  }, [currentMatches, currentMatchIndex, updateDecorations]);

  // --- ノート横断検索 ---
  const [crossNoteResults, setCrossNoteResults] = useState<NoteMatchGroup[]>(
    [],
  );

  const recomputeCrossNoteMatches = useCallback(() => {
    if (!query || patternError) {
      setCrossNoteResults([]);
      return;
    }
    const results: NoteMatchGroup[] = [];
    const activeId = getActiveNoteIdRef.current();
    for (const note of notesRef.current) {
      if (note.archived) continue;
      // 現在編集中のノートはエディタの生の値を優先
      let content = note.content ?? '';
      if (note.id === activeId) {
        const ed = getActiveEditorRef.current();
        const model = ed?.getModel();
        if (model) content = model.getValue();
      } else {
        const model = tryGetModel(note.id);
        if (model) content = model.getValue();
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
    setCrossNoteResults(results);
  }, [options, query, patternError]);

  // ノート横断検索は常時有効（UI にトグルを持たない）
  useEffect(() => {
    recomputeCrossNoteMatches();
  }, [recomputeCrossNoteMatches]);

  // --- ナビゲーション ---
  const findNext = useCallback(() => {
    setCurrentMatchIndex((i) =>
      currentMatches.length === 0 ? 0 : (i + 1) % currentMatches.length,
    );
  }, [currentMatches.length]);

  const findPrevious = useCallback(() => {
    setCurrentMatchIndex((i) =>
      currentMatches.length === 0
        ? 0
        : (i - 1 + currentMatches.length) % currentMatches.length,
    );
  }, [currentMatches.length]);

  const pendingJumpRef = useRef<{ noteId: string; index: number } | null>(null);
  const jumpToNoteMatch = useCallback(
    (noteId: string, matchIndexInNote: number) => {
      // 呼び出し側で該当ノートを選択した後にエディタモデルが切り替わる。
      // ここでは目的位置だけ記憶し、currentMatches が再計算されてから適用する。
      pendingJumpRef.current = { noteId, index: matchIndexInNote };
    },
    [],
  );

  // currentMatches が更新された直後、保留中のジャンプがあれば反映する
  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!pending) return;
    const activeId = getActiveNoteIdRef.current();
    if (activeId !== pending.noteId) return;
    if (currentMatches.length === 0) return;
    pendingJumpRef.current = null;
    const idx = Math.min(pending.index, currentMatches.length - 1);
    setCurrentMatchIndex(idx);
  }, [currentMatches]);

  // --- 置換処理 ---
  const applyCommand: CommandApplier = useCallback((cmd, direction) => {
    type Prepared = {
      noteId: string;
      edits: BulkEdit['edits'];
    };
    const prepared: Prepared[] = [];
    for (const perNote of cmd.perNote) {
      const note = notesRef.current.find((n) => n.id === perNote.noteId);
      if (!note) return false;

      const base = note.content ?? '';
      const inverted = perNote.edits.map((e) => {
        if (direction === 'undo') {
          const endInCurrent = e.start + e.replacement.length;
          return {
            start: e.start,
            end: endInCurrent,
            original: e.replacement,
            replacement: e.original,
          };
        }
        const endInCurrent = e.start + e.original.length;
        return {
          start: e.start,
          end: endInCurrent,
          original: e.original,
          replacement: e.replacement,
        };
      });

      // 競合検出: 期待する文字列が対象位置に存在しているか
      const model = tryGetModel(note.id);
      const liveContent = model ? model.getValue() : base;
      for (const e of inverted) {
        const sliceNow = liveContent.slice(e.start, e.end);
        if (sliceNow !== e.original) {
          return false;
        }
      }
      prepared.push({ noteId: note.id, edits: inverted });
    }

    // 適用
    const toSave: Note[] = [];
    for (const p of prepared) {
      const note = notesRef.current.find((n) => n.id === p.noteId);
      if (!note) continue;
      const next = applyEditsToNote(note.id, note.content ?? '', p.edits);
      toSave.push({ ...note, content: next });
    }

    if (toSave.length === 0) return true;
    setNotesRef.current((prev) =>
      prev.map((n) => toSave.find((ts) => ts.id === n.id) ?? n),
    );
    // バックエンド永続化は fire-and-forget（失敗は既存ログ経路で扱う）
    (async () => {
      for (const n of toSave) {
        try {
          await SaveNote(backend.Note.createFrom(n), 'update');
        } catch {
          // エラーは既存の通知経路で処理
        }
      }
    })();
    return true;
  }, []);

  const history = useBulkEditHistory({ apply: applyCommand });

  // コマンドを生成して push
  const commitCommand = useCallback(
    (
      labelKey: string,
      perNote: BulkEdit[],
      labelArgs?: BulkCommand['labelArgs'],
    ) => {
      if (perNote.length === 0) return;
      const cmd: BulkCommand = {
        id: `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        labelKey,
        labelArgs,
        perNote,
        timestamp: Date.now(),
      };
      history.pushCommand(cmd);
    },
    [history],
  );

  // 現在ノートで現在のマッチを 1 件置換
  const replaceCurrent = useCallback(() => {
    if (patternError) return;
    const ed = getActiveEditorRef.current();
    const model = ed?.getModel();
    if (!ed || !model) return;
    const noteId = getActiveNoteIdRef.current();
    if (!noteId) return;
    const m = currentMatches[currentMatchIndex];
    if (!m) return;
    const edits = buildReplacementEdits([m], replacement, useRegex);
    if (edits.length === 0) return;
    const perNote: BulkEdit[] = [{ noteId, edits }];
    applyEditsToModel(model, edits);
    const note = notesRef.current.find((n) => n.id === noteId);
    if (note) {
      const newContent = model.getValue();
      setNotesRef.current((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, content: newContent } : n)),
      );
      // 保存
      SaveNote(
        backend.Note.createFrom({ ...note, content: newContent }),
        'update',
      ).catch(() => {});
    }
    commitCommand('searchReplace.historyReplace', perNote, { count: 1 });
  }, [
    currentMatches,
    currentMatchIndex,
    replacement,
    useRegex,
    patternError,
    commitCommand,
  ]);

  // 現在ノートの全マッチを置換
  const replaceAllInCurrent = useCallback(() => {
    if (patternError) return;
    const ed = getActiveEditorRef.current();
    const model = ed?.getModel();
    if (!ed || !model) return;
    const noteId = getActiveNoteIdRef.current();
    if (!noteId) return;
    if (currentMatches.length === 0) return;

    const edits = buildReplacementEdits(currentMatches, replacement, useRegex);
    const perNote: BulkEdit[] = [{ noteId, edits }];
    applyEditsToModel(model, edits);
    const note = notesRef.current.find((n) => n.id === noteId);
    if (note) {
      const newContent = model.getValue();
      setNotesRef.current((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, content: newContent } : n)),
      );
      SaveNote(
        backend.Note.createFrom({ ...note, content: newContent }),
        'update',
      ).catch(() => {});
    }
    commitCommand('searchReplace.historyReplaceAll', perNote, {
      count: edits.length,
    });
  }, [currentMatches, replacement, useRegex, patternError, commitCommand]);

  // 全ノートで一括置換
  const replaceAllInAllNotes = useCallback(async () => {
    if (patternError) return;
    if (crossNoteResults.length === 0) return;

    const confirmed = await showMessage(
      tRef.current('searchReplace.confirmReplaceAllTitle'),
      tRef.current('searchReplace.confirmReplaceAllMessage', {
        noteCount: crossNoteResults.length,
        matchCount: crossNoteResults.reduce(
          (sum, g) => sum + g.matches.length,
          0,
        ),
      }),
      true,
      tRef.current('dialog.ok'),
      tRef.current('dialog.cancel'),
    );
    if (!confirmed) return;

    const perNote: BulkEdit[] = [];
    for (const group of crossNoteResults) {
      const edits = buildReplacementEdits(group.matches, replacement, useRegex);
      if (edits.length > 0) {
        perNote.push({ noteId: group.noteId, edits });
      }
    }
    if (perNote.length === 0) return;

    // 各ノートに適用（Monaco モデルがあれば経由、なければ文字列）
    const updated: Note[] = [];
    for (const p of perNote) {
      const note = notesRef.current.find((n) => n.id === p.noteId);
      if (!note) continue;
      const newContent = applyEditsToNote(
        p.noteId,
        note.content ?? '',
        p.edits,
      );
      updated.push({ ...note, content: newContent });
    }
    setNotesRef.current((prev) =>
      prev.map((n) => updated.find((u) => u.id === n.id) ?? n),
    );
    // バックエンド永続化
    for (const n of updated) {
      try {
        await SaveNote(backend.Note.createFrom(n), 'update');
      } catch {
        // 既存のログ経路で扱う
      }
    }

    commitCommand('searchReplace.historyReplaceAllNotes', perNote, {
      noteCount: perNote.length,
      matchCount: perNote.reduce((s, p) => s + p.edits.length, 0),
    });

    // 結果を再計算（すべて置換済みなのでクリアされるはず）
    recomputeCrossNoteMatches();
    recomputeCurrentMatches();
  }, [
    crossNoteResults,
    replacement,
    useRegex,
    patternError,
    showMessage,
    commitCommand,
    recomputeCrossNoteMatches,
    recomputeCurrentMatches,
  ]);

  // Undo（競合時はダイアログ）
  const undo = useCallback(async () => {
    const cmd = history.peekUndo();
    if (!cmd) return;
    const ok = await history.undo();
    if (ok) {
      recomputeCurrentMatches();
      recomputeCrossNoteMatches();
      return;
    }
    await showMessage(
      tRef.current('searchReplace.conflictTitle'),
      tRef.current('searchReplace.conflictMessage'),
      false,
      tRef.current('dialog.ok'),
    );
  }, [
    history,
    showMessage,
    recomputeCurrentMatches,
    recomputeCrossNoteMatches,
  ]);

  const redo = useCallback(async () => {
    const cmd = history.peekRedo();
    if (!cmd) return;
    const ok = await history.redo();
    if (ok) {
      recomputeCurrentMatches();
      recomputeCrossNoteMatches();
      return;
    }
    await showMessage(
      tRef.current('searchReplace.conflictTitle'),
      tRef.current('searchReplace.conflictMessage'),
      false,
      tRef.current('dialog.ok'),
    );
  }, [
    history,
    showMessage,
    recomputeCurrentMatches,
    recomputeCrossNoteMatches,
  ]);

  // 外部からフォーカス要求（モードも合わせて切替）
  const focusFind = useCallback((nextMode: SearchPanelMode = 'find') => {
    setMode(nextMode);
    setFocusToken((t) => t + 1);
  }, []);
  // クエリ・置換文字列を消去（Escape で使用）
  const clearQuery = useCallback(() => {
    setQuery('');
    setReplacement('');
  }, []);

  return {
    // 状態
    mode,
    query,
    replacement,
    caseSensitive,
    wholeWord,
    useRegex,
    patternError,
    currentMatches,
    currentMatchIndex,
    crossNoteResults,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    focusToken,
    // アクション
    setQuery,
    setReplacement,
    setCaseSensitive,
    setWholeWord,
    setUseRegex,
    setMode,
    focusFind,
    clearQuery,
    findNext,
    findPrevious,
    jumpToNoteMatch,
    replaceCurrent,
    replaceAllInCurrent,
    replaceAllInAllNotes,
    undo,
    redo,
    invalidateForNote: history.invalidateForNote,
  };
};
