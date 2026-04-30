import { create } from 'zustand';

import type { FileNote } from '../types';

// FileNote 一覧のグローバル state。
// 旧 useFileNotes フックが useState で抱えていたものを Zustand に集約することで、
// App.tsx は購読をやめ、Sidebar / EditorArea などの末端だけが必要な slice を
// 購読する形にする。
interface FileNotesState {
  fileNotes: FileNote[];
}

interface FileNotesActions {
  setFileNotes: (
    updater: FileNote[] | ((prev: FileNote[]) => FileNote[]),
  ) => void;
  reset: () => void;
}

const INITIAL_STATE: FileNotesState = {
  fileNotes: [],
};

const applyUpdater = <T>(prev: T, updater: T | ((prev: T) => T)): T =>
  typeof updater === 'function' ? (updater as (p: T) => T)(prev) : updater;

export const useFileNotesStore = create<FileNotesState & FileNotesActions>(
  (set) => ({
    ...INITIAL_STATE,
    setFileNotes: (updater) =>
      set((s) => ({ fileNotes: applyUpdater(s.fileNotes, updater) })),
    reset: () => set(INITIAL_STATE),
  }),
);

// 末端コンポーネント向けの薄い購読 hook。
// hooks/useFileNotes（lifecycle hook）と区別するため All プレフィックスを付ける。
export const useAllFileNotes = () => useFileNotesStore((s) => s.fileNotes);
