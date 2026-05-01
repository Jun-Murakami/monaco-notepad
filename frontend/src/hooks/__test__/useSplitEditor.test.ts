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

import { SaveNote } from '../../../wailsjs/go/backend/App';
import { useCurrentNoteStore } from '../../stores/useCurrentNoteStore';
import { useNotesStore } from '../../stores/useNotesStore';
import { useSplitEditorStore } from '../../stores/useSplitEditorStore';
import { useSplitEditor } from '../useSplitEditor';

import type { Note } from '../../types';

vi.mock('../../../wailsjs/go/backend/App', () => ({
  SaveNote: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../wailsjs/go/models', () => ({
  backend: {
    Note: {
      createFrom: (note: Note) => note,
    },
  },
}));

describe('useSplitEditor', () => {
  const leftNote: Note = {
    id: 'left-note',
    title: 'Left title',
    content: 'Left content',
    contentHeader: null,
    language: 'plaintext',
    modifiedTime: '2026-01-01T00:00:00.000Z',
    archived: false,
  };

  const rightNote: Note = {
    id: 'right-note',
    title: 'Right title',
    content: 'Right content',
    contentHeader: null,
    language: 'plaintext',
    modifiedTime: '2026-01-01T00:00:00.000Z',
    archived: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    // テスト前にストアを初期化し、currentNote を leftNote にセット
    useCurrentNoteStore.getState().resetCurrentNote();
    useCurrentNoteStore.setState({ currentNote: leftNote });
    useSplitEditorStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    useCurrentNoteStore.getState().resetCurrentNote();
    useSplitEditorStore.getState().reset();
  });

  // notes 配列も store 経由で書き換えられるので spy で観測する
  const observeSetNotes = () => {
    const calls: Array<(prev: Note[]) => Note[]> = [];
    const setNotesFn = useNotesStore.getState().setNotes;
    type SetNotesUpdater = Note[] | ((prev: Note[]) => Note[]);
    const spy = vi.fn((updater: SetNotesUpdater) => {
      if (typeof updater === 'function') calls.push(updater);
      setNotesFn(updater);
    });
    useNotesStore.setState({ setNotes: spy as never });
    return { spy, calls };
  };

  it('スプリット時に右ペインのタイトル変更が左ペインへ波及しないこと', () => {
    const { spy, calls } = observeSetNotes();
    const { result } = renderHook(() => useSplitEditor());

    act(() => {
      result.current.toggleSplit(rightNote);
    });

    spy.mockClear();
    (SaveNote as Mock).mockClear();

    act(() => {
      result.current.handleRightNoteTitleChange('Right updated');
    });

    expect(useSplitEditorStore.getState().rightNote?.title).toBe(
      'Right updated',
    );
    expect(useSplitEditorStore.getState().leftNote?.title).toBe('Left title');
    expect(spy).toHaveBeenCalled();

    // サイドバー反映用の state updater が「右ノートIDのみ」更新していることを検証する。
    const updater = calls[calls.length - 1];
    const updated = updater([leftNote, rightNote]);
    expect(updated.find((n) => n.id === leftNote.id)?.title).toBe('Left title');
    expect(updated.find((n) => n.id === rightNote.id)?.title).toBe(
      'Right updated',
    );
  });

  it('右ペインタイトルの連続入力で最後の値がデバウンス保存されること', async () => {
    const { result } = renderHook(() => useSplitEditor());

    act(() => {
      result.current.toggleSplit(rightNote);
    });

    (SaveNote as Mock).mockClear();

    act(() => {
      result.current.handleRightNoteTitleChange('R');
      result.current.handleRightNoteTitleChange('Ri');
      result.current.handleRightNoteTitleChange('Right final');
    });

    expect(useSplitEditorStore.getState().rightNote?.title).toBe('Right final');

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(SaveNote).toHaveBeenCalledTimes(1);
    expect(SaveNote).toHaveBeenCalledWith(
      expect.objectContaining({
        id: rightNote.id,
        title: 'Right final',
      }),
      'update',
    );
  });

  it('右ペインの言語変更でも右ノートのみ更新・保存されること', async () => {
    const { result } = renderHook(() => useSplitEditor());

    act(() => {
      result.current.toggleSplit(rightNote);
    });

    (SaveNote as Mock).mockClear();

    act(() => {
      result.current.handleRightNoteLanguageChange('markdown');
    });

    expect(useSplitEditorStore.getState().rightNote?.language).toBe('markdown');
    expect(useSplitEditorStore.getState().leftNote?.language).toBe('plaintext');

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(SaveNote).toHaveBeenCalledWith(
      expect.objectContaining({
        id: rightNote.id,
        language: 'markdown',
      }),
      'update',
    );
  });

  it('同期で左右の表示ノートが消えた場合、未オープンの上位ノートへ自動差し替えされること', () => {
    const replacementLeft: Note = {
      ...leftNote,
      id: 'replacement-left',
      title: 'Replacement Left',
      modifiedTime: '2026-01-02T00:00:00.000Z',
    };
    const replacementRight: Note = {
      ...rightNote,
      id: 'replacement-right',
      title: 'Replacement Right',
      modifiedTime: '2026-01-02T00:00:00.000Z',
    };

    const { result } = renderHook(() => useSplitEditor());

    act(() => {
      result.current.toggleSplit(rightNote);
    });

    act(() => {
      result.current.syncPaneNotes(
        [replacementLeft, replacementRight],
        [
          { type: 'note', id: replacementLeft.id },
          { type: 'note', id: replacementRight.id },
        ],
      );
    });

    expect(useSplitEditorStore.getState().leftNote?.id).toBe(
      replacementLeft.id,
    );
    expect(useSplitEditorStore.getState().rightNote?.id).toBe(
      replacementRight.id,
    );
    // フォーカスペイン（既定は左）が置換後ノートに更新されていること
    expect(useCurrentNoteStore.getState().currentNote?.id).toBe(
      replacementLeft.id,
    );
    expect(useCurrentNoteStore.getState().currentFileNote).toBeNull();
  });
});
