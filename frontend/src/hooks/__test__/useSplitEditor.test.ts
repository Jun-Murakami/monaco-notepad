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
import type { Note } from '../../types';
import { useSplitEditor } from '../useSplitEditor';

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
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('スプリット時に右ペインのタイトル変更が左ペインへ波及しないこと', () => {
    const setCurrentNote = vi.fn();
    const setCurrentFileNote = vi.fn();
    const setNotes = vi.fn();

    const { result } = renderHook(() =>
      useSplitEditor({
        currentNote: leftNote,
        currentFileNote: null,
        setCurrentNote,
        setCurrentFileNote,
        setNotes,
      }),
    );

    act(() => {
      result.current.toggleSplit(rightNote);
    });

    (setNotes as Mock).mockClear();
    (SaveNote as Mock).mockClear();

    act(() => {
      result.current.handleRightNoteTitleChange('Right updated');
    });

    expect(result.current.rightNote?.title).toBe('Right updated');
    expect(result.current.leftNote?.title).toBe('Left title');
    expect(setNotes).toHaveBeenCalled();

    // サイドバー反映用の state updater が「右ノートIDのみ」更新していることを検証する。
    const updater = (setNotes as Mock).mock.calls[0][0] as (
      prev: Note[],
    ) => Note[];
    const updated = updater([leftNote, rightNote]);
    expect(updated.find((n) => n.id === leftNote.id)?.title).toBe('Left title');
    expect(updated.find((n) => n.id === rightNote.id)?.title).toBe(
      'Right updated',
    );
  });

  it('右ペインタイトルの連続入力で最後の値がデバウンス保存されること', async () => {
    const setCurrentNote = vi.fn();
    const setCurrentFileNote = vi.fn();
    const setNotes = vi.fn();

    const { result } = renderHook(() =>
      useSplitEditor({
        currentNote: leftNote,
        currentFileNote: null,
        setCurrentNote,
        setCurrentFileNote,
        setNotes,
      }),
    );

    act(() => {
      result.current.toggleSplit(rightNote);
    });

    (SaveNote as Mock).mockClear();
    (setNotes as Mock).mockClear();

    act(() => {
      result.current.handleRightNoteTitleChange('R');
      result.current.handleRightNoteTitleChange('Ri');
      result.current.handleRightNoteTitleChange('Right final');
    });

    expect(result.current.rightNote?.title).toBe('Right final');

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
    const setCurrentNote = vi.fn();
    const setCurrentFileNote = vi.fn();
    const setNotes = vi.fn();

    const { result } = renderHook(() =>
      useSplitEditor({
        currentNote: leftNote,
        currentFileNote: null,
        setCurrentNote,
        setCurrentFileNote,
        setNotes,
      }),
    );

    act(() => {
      result.current.toggleSplit(rightNote);
    });

    (SaveNote as Mock).mockClear();

    act(() => {
      result.current.handleRightNoteLanguageChange('markdown');
    });

    expect(result.current.rightNote?.language).toBe('markdown');
    expect(result.current.leftNote?.language).toBe('plaintext');

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
    const setCurrentNote = vi.fn();
    const setCurrentFileNote = vi.fn();
    const setNotes = vi.fn();
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

    const { result } = renderHook(() =>
      useSplitEditor({
        currentNote: leftNote,
        currentFileNote: null,
        setCurrentNote,
        setCurrentFileNote,
        setNotes,
      }),
    );

    act(() => {
      result.current.toggleSplit(rightNote);
    });

    (setCurrentNote as Mock).mockClear();
    (setCurrentFileNote as Mock).mockClear();

    act(() => {
      result.current.syncPaneNotes(
        [replacementLeft, replacementRight],
        [
          { type: 'note', id: replacementLeft.id },
          { type: 'note', id: replacementRight.id },
        ],
      );
    });

    expect(result.current.leftNote?.id).toBe(replacementLeft.id);
    expect(result.current.rightNote?.id).toBe(replacementRight.id);
    expect(setCurrentNote).toHaveBeenCalledWith(
      expect.objectContaining({ id: replacementLeft.id }),
    );
    expect(setCurrentFileNote).toHaveBeenCalledWith(null);
  });
});
