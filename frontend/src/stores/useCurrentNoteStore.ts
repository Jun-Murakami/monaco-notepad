import { create } from 'zustand';

import type { FileNote, Note } from '../types';

// 現在表示中のノート/ファイルノートを保持するグローバルストア。
// App.tsx から末端コンポーネントへの prop drill を避け、購読粒度を
// 「実際に再描画が必要な箇所」に閉じ込めるための共有 state。
interface CurrentNoteState {
  currentNote: Note | null;
  currentFileNote: FileNote | null;
  // 新規ノート作成時にタイトル欄へフォーカスを向けるトークン。
  // PaneHeader が値の変化を監視して focus + select を行う。
  // （特定ペインに送る必要はなく、フォーカスされているペインの title が拾えば良い）
  titleFocusToken: number;
}

interface CurrentNoteActions {
  setCurrentNote: (note: Note | null) => void;
  setCurrentFileNote: (note: FileNote | null) => void;
  resetCurrentNote: () => void;
  requestTitleFocus: () => void;
}

const INITIAL_STATE: CurrentNoteState = {
  currentNote: null,
  currentFileNote: null,
  titleFocusToken: 0,
};

export const useCurrentNoteStore = create<
  CurrentNoteState & CurrentNoteActions
>((set) => ({
  ...INITIAL_STATE,
  setCurrentNote: (currentNote) => set({ currentNote }),
  setCurrentFileNote: (currentFileNote) => set({ currentFileNote }),
  resetCurrentNote: () => set(INITIAL_STATE),
  requestTitleFocus: () =>
    set((s) => ({ titleFocusToken: s.titleFocusToken + 1 })),
}));

// 末端コンポーネント向け薄い購読 hook。selector を一箇所に集約することで
// 各コンポーネントから余計な参照を作らず、再描画範囲を最小化する。
export const useCurrentNote = () =>
  useCurrentNoteStore((state) => state.currentNote);
export const useCurrentFileNote = () =>
  useCurrentNoteStore((state) => state.currentFileNote);
export const useCurrentNoteId = () =>
  useCurrentNoteStore((state) => state.currentNote?.id ?? null);
export const useCurrentFileNoteId = () =>
  useCurrentNoteStore((state) => state.currentFileNote?.id ?? null);
export const useTitleFocusToken = () =>
  useCurrentNoteStore((state) => state.titleFocusToken);
