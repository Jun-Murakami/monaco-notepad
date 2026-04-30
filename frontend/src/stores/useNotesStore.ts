import { create } from 'zustand';

import type { Folder, Note, TopLevelItem } from '../types';

// ノートライブラリ全体（notes / folders / topLevelOrder / archived 系 / 折りたたみ /
// showArchived）のグローバル state。
// 旧 useNotes フックが内部 useState で抱えていたものを Zustand に集約することで、
// App.tsx は購読をやめ、Sidebar / EditorArea / ArchivedNoteList などの末端だけが
// 必要な slice を購読する形にする。
interface NotesState {
  notes: Note[];
  folders: Folder[];
  topLevelOrder: TopLevelItem[];
  archivedTopLevelOrder: TopLevelItem[];
  collapsedFolders: Set<string>;
  showArchived: boolean;
}

interface NotesActions {
  setNotes: (updater: Note[] | ((prev: Note[]) => Note[])) => void;
  setFolders: (updater: Folder[] | ((prev: Folder[]) => Folder[])) => void;
  setTopLevelOrder: (
    updater: TopLevelItem[] | ((prev: TopLevelItem[]) => TopLevelItem[]),
  ) => void;
  setArchivedTopLevelOrder: (
    updater: TopLevelItem[] | ((prev: TopLevelItem[]) => TopLevelItem[]),
  ) => void;
  setCollapsedFolders: (
    updater: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => void;
  setShowArchived: (updater: boolean | ((prev: boolean) => boolean)) => void;
  reset: () => void;
}

const INITIAL_STATE: NotesState = {
  notes: [],
  folders: [],
  topLevelOrder: [],
  archivedTopLevelOrder: [],
  collapsedFolders: new Set<string>(),
  showArchived: false,
};

const applyUpdater = <T>(prev: T, updater: T | ((prev: T) => T)): T =>
  typeof updater === 'function' ? (updater as (p: T) => T)(prev) : updater;

export const useNotesStore = create<NotesState & NotesActions>((set) => ({
  ...INITIAL_STATE,
  setNotes: (updater) =>
    set((s) => ({ notes: applyUpdater(s.notes, updater) })),
  setFolders: (updater) =>
    set((s) => ({ folders: applyUpdater(s.folders, updater) })),
  setTopLevelOrder: (updater) =>
    set((s) => ({ topLevelOrder: applyUpdater(s.topLevelOrder, updater) })),
  setArchivedTopLevelOrder: (updater) =>
    set((s) => ({
      archivedTopLevelOrder: applyUpdater(s.archivedTopLevelOrder, updater),
    })),
  setCollapsedFolders: (updater) =>
    set((s) => ({
      collapsedFolders: applyUpdater(s.collapsedFolders, updater),
    })),
  setShowArchived: (updater) =>
    set((s) => ({ showArchived: applyUpdater(s.showArchived, updater) })),
  reset: () => set(INITIAL_STATE),
}));

// 末端コンポーネント向け薄い購読 hook。selector を集中管理することで
// 不要な再描画範囲を抑える。
// （既存 `hooks/useNotes` フックと名前衝突するので、こちらは AllNotes プレフィックス）
export const useAllNotes = () => useNotesStore((s) => s.notes);
export const useFolders = () => useNotesStore((s) => s.folders);
export const useTopLevelOrder = () => useNotesStore((s) => s.topLevelOrder);
export const useArchivedTopLevelOrder = () =>
  useNotesStore((s) => s.archivedTopLevelOrder);
export const useCollapsedFolders = () =>
  useNotesStore((s) => s.collapsedFolders);
export const useShowArchived = () => useNotesStore((s) => s.showArchived);

// アクティブノートの個数だけを返す。canSplit 等の閾値判定に使う。
// 数値の比較なので、配列要素の追加削除があっても閾値を跨がなければ再レンダーしない。
export const useActiveNotesCount = () =>
  useNotesStore((s) => s.notes.reduce((c, n) => c + (n.archived ? 0 : 1), 0));
