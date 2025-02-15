import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useDriveSync } from '../useDriveSync';
import { EventsEmit } from '../../../wailsjs/runtime';
import { AuthorizeDrive, LogoutDrive, SyncNow, CheckDriveConnection, CancelLoginDrive } from '../../../wailsjs/go/backend/App';

// イベントハンドラーの型定義
type EventHandlers = { [key: string]: (data: any) => void };
let eventHandlers: EventHandlers = {};

// モックの設定
vi.mock('../../../wailsjs/runtime', () => ({
  EventsOn: vi.fn((event, callback) => {
    eventHandlers[event] = callback;
  }),
  EventsOff: vi.fn(),
  EventsEmit: vi.fn(),
}));

vi.mock('../../../wailsjs/go/backend/App', () => ({
  AuthorizeDrive: vi.fn(),
  LogoutDrive: vi.fn(),
  SyncNow: vi.fn(),
  CheckDriveConnection: vi.fn(),
  CancelLoginDrive: vi.fn(),
}));

describe('useDriveSync', () => {
  const mockShowMessage = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    mockShowMessage.mockReset();
    mockShowMessage.mockResolvedValue(true);
    eventHandlers = {};
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  const emitEvent = async (event: string, data: any) => {
    await act(async () => {
      if (eventHandlers[event]) {
        eventHandlers[event](data);
      }
      await vi.runAllTimersAsync();
    });
  };

  const waitForEffect = async () => {
    await act(async () => {
      await vi.runAllTimersAsync();
    });
  };

  it('初期状態が正しく設定されること', async () => {
    // 初期状態ではオフライン
    (CheckDriveConnection as any).mockResolvedValue(false);
    const { result } = renderHook(() => useDriveSync(mockShowMessage));
    await waitForEffect();

    expect(result.current.syncStatus).toBe('offline');
    expect(result.current.isHoveringSync).toBe(false);
    expect(result.current.isHoverLocked).toBe(false);
  });

  it('Google認証が正しく機能すること', async () => {
    (CheckDriveConnection as any).mockResolvedValue(true);
    const { result } = renderHook(() => useDriveSync(mockShowMessage));
    await waitForEffect();

    await act(async () => {
      await result.current.handleGoogleAuth();
      await vi.runAllTimersAsync();
    });

    expect(AuthorizeDrive).toHaveBeenCalled();
  });

  it('認証エラー時に適切に処理されること', async () => {
    (AuthorizeDrive as any).mockRejectedValue(new Error('Auth failed'));
    const { result } = renderHook(() => useDriveSync(mockShowMessage));
    await waitForEffect();

    await act(async () => {
      await result.current.handleGoogleAuth();
      await vi.runAllTimersAsync();
    });

    expect(mockShowMessage).toHaveBeenCalledWith(
      'Error',
      'Google authentication failed: Error: Auth failed'
    );
    expect(result.current.syncStatus).toBe('offline');
  });

  it('ログアウトが正しく機能すること', async () => {
    const { result } = renderHook(() => useDriveSync(mockShowMessage));
    await waitForEffect();

    await act(async () => {
      await result.current.handleLogout();
      await vi.runAllTimersAsync();
    });

    expect(LogoutDrive).toHaveBeenCalled();
  });

  it('手動同期が正しく機能すること', async () => {
    const { result } = renderHook(() => useDriveSync(mockShowMessage));
    await waitForEffect();

    // 初期状態を'synced'に設定
    await emitEvent('drive:status', 'synced');
    expect(result.current.syncStatus).toBe('synced');

    await act(async () => {
      await result.current.handleSync();
      await vi.runAllTimersAsync();
    });

    expect(SyncNow).toHaveBeenCalled();
  });

  it('同期エラー時に適切に処理されること', async () => {
    (SyncNow as any).mockRejectedValue(new Error('Sync failed'));
    const { result } = renderHook(() => useDriveSync(mockShowMessage));
    await waitForEffect();

    // 初期状態を'synced'に設定
    await emitEvent('drive:status', 'synced');
    expect(result.current.syncStatus).toBe('synced');

    await act(async () => {
      await result.current.handleSync();
      await vi.runAllTimersAsync();
    });

    expect(mockShowMessage).toHaveBeenCalledWith(
      'Sync Error',
      'Failed to synchronize with Google Drive: Error: Sync failed'
    );
  });

  it('同期タイムアウトが正しく処理されること', async () => {
    const { result } = renderHook(() => useDriveSync(mockShowMessage));
    await waitForEffect();

    // 初期状態を'syncing'に設定
    await act(async () => {
      eventHandlers['drive:status']('syncing');
      await vi.runAllTimersAsync();
    });
    expect(result.current.syncStatus).toBe('syncing');

    // タイムアウト時間を進める
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      await vi.advanceTimersByTimeAsync(10000);
    });

    expect(mockShowMessage).toHaveBeenCalledWith(
      'Sync Error',
      'Sync timeout. Please login again.'
    );
  });

  it('ドライブステータスの変更が正しく反映されること', async () => {
    const { result } = renderHook(() => useDriveSync(mockShowMessage));
    await waitForEffect();

    // 各状態を順番に設定
    await act(async () => {
      eventHandlers['drive:status']('syncing');
      await vi.runAllTimersAsync();
    });
    expect(result.current.syncStatus).toBe('syncing');

    await act(async () => {
      eventHandlers['drive:status']('synced');
      await vi.runAllTimersAsync();
    });
    expect(result.current.syncStatus).toBe('synced');

    await act(async () => {
      eventHandlers['drive:status']('offline');
      await vi.runAllTimersAsync();
    });
    expect(result.current.syncStatus).toBe('offline');
  });

  it('ドライブエラーが正しく処理されること', async () => {
    const { result } = renderHook(() => useDriveSync(mockShowMessage));
    await waitForEffect();

    await act(async () => {
      eventHandlers['drive:error']('Test error');
      await vi.runAllTimersAsync();
    });

    expect(mockShowMessage).toHaveBeenCalledWith(
      'Drive error',
      'Test error'
    );
  });

  it('ログインのキャンセルが正しく機能すること', async () => {
    const { result } = renderHook(() => useDriveSync(mockShowMessage));
    await waitForEffect();

    // 初期状態を'logging in'に設定
    await act(async () => {
      eventHandlers['drive:status']('logging in');
      await vi.runAllTimersAsync();
    });
    expect(result.current.syncStatus).toBe('logging in');

    await act(async () => {
      await result.current.handleLogout();
      await vi.runAllTimersAsync();
    });

    expect(CancelLoginDrive).toHaveBeenCalled();
  });
});