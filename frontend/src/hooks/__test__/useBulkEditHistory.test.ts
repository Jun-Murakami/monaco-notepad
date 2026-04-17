import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { type BulkCommand, useBulkEditHistory } from '../useBulkEditHistory';

const makeCommand = (id: string, noteId = 'n1'): BulkCommand => ({
  id,
  labelKey: 'test',
  perNote: [
    {
      noteId,
      edits: [{ start: 0, end: 3, original: 'foo', replacement: 'bar' }],
    },
  ],
  timestamp: 0,
});

describe('useBulkEditHistory', () => {
  it('初期状態は canUndo / canRedo ともに false', () => {
    const apply = vi.fn(() => true);
    const { result } = renderHook(() => useBulkEditHistory({ apply }));
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('push したコマンドで undo できること', async () => {
    const apply = vi.fn(() => true);
    const { result } = renderHook(() => useBulkEditHistory({ apply }));

    act(() => {
      result.current.pushCommand(makeCommand('c1'));
    });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);

    await act(async () => {
      await result.current.undo();
    });
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1' }),
      'undo',
    );
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });

  it('undo 後に redo でスタックが入れ替わること', async () => {
    const apply = vi.fn(() => true);
    const { result } = renderHook(() => useBulkEditHistory({ apply }));

    act(() => {
      result.current.pushCommand(makeCommand('c1'));
    });
    await act(async () => {
      await result.current.undo();
    });
    await act(async () => {
      await result.current.redo();
    });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
    expect(apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'c1' }),
      'redo',
    );
  });

  it('新しい push で redo スタックがクリアされること', async () => {
    const apply = vi.fn(() => true);
    const { result } = renderHook(() => useBulkEditHistory({ apply }));
    act(() => {
      result.current.pushCommand(makeCommand('c1'));
    });
    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.canRedo).toBe(true);
    act(() => {
      result.current.pushCommand(makeCommand('c2'));
    });
    expect(result.current.canRedo).toBe(false);
    expect(result.current.canUndo).toBe(true);
  });

  it('apply が false を返すと履歴は変化しないこと（競合時）', async () => {
    const apply = vi.fn(() => false);
    const { result } = renderHook(() => useBulkEditHistory({ apply }));
    act(() => {
      result.current.pushCommand(makeCommand('c1'));
    });
    await act(async () => {
      const r = await result.current.undo();
      expect(r).toBeNull();
    });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('上限を超えると古い履歴が捨てられること', () => {
    const apply = vi.fn(() => true);
    const { result } = renderHook(() =>
      useBulkEditHistory({ apply, maxHistory: 2 }),
    );
    act(() => {
      result.current.pushCommand(makeCommand('c1'));
      result.current.pushCommand(makeCommand('c2'));
      result.current.pushCommand(makeCommand('c3'));
    });
    // c1 が捨てられ、c3 が先頭
    expect(result.current.peekUndo()?.id).toBe('c3');
  });

  it('invalidateForNote で該当ノートを含む履歴を除外すること', () => {
    const apply = vi.fn(() => true);
    const { result } = renderHook(() => useBulkEditHistory({ apply }));
    act(() => {
      result.current.pushCommand(makeCommand('c1', 'n1'));
      result.current.pushCommand(makeCommand('c2', 'n2'));
    });
    act(() => {
      result.current.invalidateForNote('n1');
    });
    expect(result.current.peekUndo()?.id).toBe('c2');
  });

  it('clear で両方のスタックが空になること', async () => {
    const apply = vi.fn(() => true);
    const { result } = renderHook(() => useBulkEditHistory({ apply }));
    act(() => {
      result.current.pushCommand(makeCommand('c1'));
    });
    await act(async () => {
      await result.current.undo();
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });
});
