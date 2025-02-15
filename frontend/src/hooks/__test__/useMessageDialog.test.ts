import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useMessageDialog } from '../useMessageDialog';
import * as runtime from '../../../wailsjs/runtime';

// runtimeのモック
vi.mock('../../../wailsjs/runtime', () => ({
  EventsOn: vi.fn((event, callback) => {
    if (event === 'show-message') {
      eventHandler = callback;
    }
    return () => { };
  }),
  EventsOff: vi.fn(),
}));

let eventHandler: ((title: string, message: string, isTwoButton: boolean) => void) | null = null;

describe('useMessageDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandler = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('初期状態が正しく設定されていること', () => {
    const { result } = renderHook(() => useMessageDialog());

    expect(result.current.isMessageDialogOpen).toBe(false);
    expect(result.current.messageTitle).toBe('');
    expect(result.current.messageContent).toBe('');
    expect(result.current.isTwoButton).toBe(false);
    expect(result.current.primaryButtonText).toBe('OK');
    expect(result.current.secondaryButtonText).toBe('Cancel');
    expect(result.current.onResult).toBeNull();
  });

  it('showMessageが正しく動作すること', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useMessageDialog());

    // showMessageの戻り値は必ずPromise<boolean>
    const dialogPromise = result.current.showMessage('Test Title', 'Test Message');

    // ダイアログの表示を待つ
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // ダイアログが開いていることを確認
    expect(result.current.isMessageDialogOpen).toBe(true);
    expect(result.current.messageTitle).toBe('Test Title');
    expect(result.current.messageContent).toBe('Test Message');

    // ダイアログを閉じる
    await act(async () => {
      if (result.current.onResult) {
        await result.current.onResult(true);
      }
      await vi.runAllTimersAsync();
    });

    // ダイアログが閉じていることを確認
    expect(result.current.isMessageDialogOpen).toBe(false);
    const dialogResult = await dialogPromise;
    expect(dialogResult).toBe(true);

    vi.useRealTimers();
  });

  it('カスタムボタンテキストが正しく設定されること', async () => {
    const { result } = renderHook(() => useMessageDialog());

    let dialogPromise: Promise<boolean>;
    await act(async () => {
      dialogPromise = result.current.showMessage(
        'Test Title',
        'Test Message',
        true,
        'はい',
        'いいえ'
      );
    });

    expect(result.current.primaryButtonText).toBe('はい');
    expect(result.current.secondaryButtonText).toBe('いいえ');
    expect(result.current.isTwoButton).toBe(true);

    // クリーンアップ
    await act(async () => {
      if (result.current.onResult) {
        await result.current.onResult(true);
      }
    });
  });

  it('show-messageイベントを正しく処理すること', async () => {
    const { result } = renderHook(() => useMessageDialog());

    // イベントをシミュレート
    await act(async () => {
      if (eventHandler) {
        eventHandler('Event Title', 'Event Message', true);
      }
    });

    expect(result.current.isMessageDialogOpen).toBe(true);
    expect(result.current.messageTitle).toBe('Event Title');
    expect(result.current.messageContent).toBe('Event Message');
    expect(result.current.isTwoButton).toBe(true);

    // クリーンアップ
    await act(async () => {
      if (result.current.onResult) {
        await result.current.onResult(true);
      }
    });
  });

  it('クリーンアップ時にイベントリスナーが解除されること', () => {
    const { unmount } = renderHook(() => useMessageDialog());
    unmount();
    expect(runtime.EventsOff).toHaveBeenCalledWith('show-message');
  });
}); 