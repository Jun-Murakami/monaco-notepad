import { create } from 'zustand';

import type { EditorPane, FileNote, Note } from '../types';

const STORAGE_KEY = 'splitEditorState';

interface SplitEditorStorage {
  isSplit: boolean;
  isMarkdownPreview: boolean;
  leftNoteId: string | null;
  leftIsFile: boolean;
  rightNoteId: string | null;
  rightIsFile: boolean;
}

const loadSavedState = (): SplitEditorStorage | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const savedState = loadSavedState();

// 分割エディタ／Markdown プレビュー／左右ペイン表示ノートを保持するストア。
// 旧 useSplitEditor フック内部の useState 群を Zustand に集約することで、
// App.tsx は購読をやめ、Sidebar / EditorArea がそれぞれ必要な slice を
// 直接購読する形にする。
interface SplitEditorState {
  isSplit: boolean;
  isMarkdownPreview: boolean;
  focusedPane: EditorPane;
  leftNote: Note | null;
  leftFileNote: FileNote | null;
  rightNote: Note | null;
  rightFileNote: FileNote | null;
}

interface SplitEditorActions {
  setIsSplit: (v: boolean) => void;
  setIsMarkdownPreview: (v: boolean) => void;
  setFocusedPane: (v: EditorPane) => void;
  setLeftNote: (v: Note | null) => void;
  setLeftFileNote: (v: FileNote | null) => void;
  setRightNote: (v: Note | null) => void;
  setRightFileNote: (v: FileNote | null) => void;
  reset: () => void;
}

const INITIAL_STATE: SplitEditorState = {
  isSplit: savedState?.isSplit ?? false,
  isMarkdownPreview: savedState?.isMarkdownPreview ?? false,
  focusedPane: 'left',
  leftNote: null,
  leftFileNote: null,
  rightNote: null,
  rightFileNote: null,
};

export const useSplitEditorStore = create<
  SplitEditorState & SplitEditorActions
>((set) => ({
  ...INITIAL_STATE,
  setIsSplit: (isSplit) => set({ isSplit }),
  setIsMarkdownPreview: (isMarkdownPreview) => set({ isMarkdownPreview }),
  setFocusedPane: (focusedPane) => set({ focusedPane }),
  setLeftNote: (leftNote) => set({ leftNote }),
  setLeftFileNote: (leftFileNote) => set({ leftFileNote }),
  setRightNote: (rightNote) => set({ rightNote }),
  setRightFileNote: (rightFileNote) => set({ rightFileNote }),
  reset: () =>
    set({
      ...INITIAL_STATE,
      isSplit: false,
      isMarkdownPreview: false,
    }),
}));

// 末端 consumer 向け薄い購読 hook
export const useIsSplit = () => useSplitEditorStore((s) => s.isSplit);
export const useIsMarkdownPreview = () =>
  useSplitEditorStore((s) => s.isMarkdownPreview);
export const useFocusedPane = () => useSplitEditorStore((s) => s.focusedPane);
export const useLeftNote = () => useSplitEditorStore((s) => s.leftNote);
export const useLeftFileNote = () => useSplitEditorStore((s) => s.leftFileNote);
export const useRightNote = () => useSplitEditorStore((s) => s.rightNote);
export const useRightFileNote = () =>
  useSplitEditorStore((s) => s.rightFileNote);

// 「右ペインに何が表示されているか」を ID として返す。Sidebar の secondarySelected
// 表示用。useShallow なしで問題ない（string|undefined なので equality 判定が効く）。
export const useSecondarySelectedNoteId = () =>
  useSplitEditorStore((s) =>
    s.isSplit
      ? (s.rightNote?.id ?? s.rightFileNote?.id ?? undefined)
      : undefined,
  );
