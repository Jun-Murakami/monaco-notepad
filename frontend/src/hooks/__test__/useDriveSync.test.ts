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
import {
  AuthorizeDrive,
  CancelLoginDrive,
  CheckDriveConnection,
  LogoutDrive,
  SyncNow,
} from '../../../wailsjs/go/backend/App';
import { useDriveSync } from '../useDriveSync';

// イベントハンドラーの型定義
type EventHandlers = { [key: string]: (data: unknown) => void };
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
  NotifyFrontendReady: vi.fn(),
}));

describe('useDriveSync', () => {
  const mockShowMessage = vi.fn();
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockShowMessage.mockReset();
    mockShowMessage.mockResolvedValue(true);
    eventHandlers = {};
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    vi.useRealTimers();
  });

  const emitEvent = async (event: string, data: unknown) => {
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
    (CheckDriveConnection as unknown as Mock).mockResolvedValue(false);
    const { result } = renderHook(() => useDriveSync(mockShowMessage));
    await waitForEffect();

    expect(result.current.syncStatus).toBe('offline');
    expect(result.current.isHoveringSync).toBe(false);
    expect(result.current.isHoverLocked).toBe(false);
  });

  it('Google認証が正しく機能すること', async () => {
    (CheckDriveConnection as unknown as Mock).mockResolvedValue(true);
    const { result } = renderHook(() => useDriveSync(mockShowMessage));
    await waitForEffect();

    await act(async () => {
      await result.current.handleGoogleAuth();
      await vi.runAllTimersAsync();
    });

    expect(AuthorizeDrive).toHaveBeenCalled();
  });

  it('認証エラー時に適切に処理されること', async () => {
    (AuthorizeDrive as unknown as Mock).mockRejectedValue(
      new Error('Auth failed'),
    );
    const { result } = renderHook(() => useDriveSync(mockShowMessage));
    await waitForEffect();

    await act(async () => {
      await result.current.handleGoogleAuth();
      await vi.runAllTimersAsync();
    });

    expect(mockShowMessage).toHaveBeenCalledWith(
      'Sign-in failed',
      'Could not authenticate with Google. Please try again.\n\nDetails: Error: Auth failed',
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
      await result.current.handleSyncNow();
      await vi.runAllTimersAsync();
    });

    expect(SyncNow).toHaveBeenCalled();
  });

  it('同期エラー時に適切に処理されること', async () => {
    (SyncNow as unknown as Mock).mockRejectedValue(new Error('Sync failed'));
    const { result } = renderHook(() => useDriveSync(mockShowMessage));
    await waitForEffect();

    // 初期状態を'synced'に設定
    await emitEvent('drive:status', 'synced');
    expect(result.current.syncStatus).toBe('synced');

    await act(async () => {
      await result.current.handleSyncNow();
      await vi.runAllTimersAsync();
    });

    expect(mockShowMessage).toHaveBeenCalledWith(
      'Sync failed',
      'Could not sync with Google Drive. Notes are safe locally.\n\nDetails: Error: Sync failed',
    );
  });

  it('接続が生きている間は同期がタイムアウトしないこと', async () => {
    (CheckDriveConnection as unknown as Mock).mockResolvedValue(true);
    const { result } = renderHook(() => useDriveSync(mockShowMessage));
    await waitForEffect();

    await act(async () => {
      eventHandlers['drive:status']('syncing');
    });
    expect(result.current.syncStatus).toBe('syncing');

    // 10秒ごとのチェックを35回分（5分50秒）進める
    for (let i = 0; i < 35; i++) {
      await act(async () => {
        vi.advanceTimersByTime(10000);
        await vi.runAllTicks();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(LogoutDrive).not.toHaveBeenCalled();
    expect(result.current.syncStatus).toBe('syncing');
  });

  it('接続断時にLogoutDriveが呼ばれずofflineになること', async () => {
    (CheckDriveConnection as unknown as Mock).mockResolvedValue(true);
    const { result } = renderHook(() => useDriveSync(mockShowMessage));
    await waitForEffect();

    await act(async () => {
      eventHandlers['drive:status']('syncing');
    });
    expect(result.current.syncStatus).toBe('syncing');

    (CheckDriveConnection as unknown as Mock).mockResolvedValue(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(11000);
    });

    expect(LogoutDrive).not.toHaveBeenCalled();
    expect(result.current.syncStatus).toBe('offline');
  });

  it('ドライブステータスの変更が正しく反映されること', async () => {
    const { result } = renderHook(() => useDriveSync(mockShowMessage));
    await waitForEffect();

    await act(async () => {
      eventHandlers['drive:status']('syncing');
    });
    expect(result.current.syncStatus).toBe('syncing');

    await act(async () => {
      eventHandlers['drive:status']('synced');
    });
    expect(result.current.syncStatus).toBe('synced');

    await act(async () => {
      eventHandlers['drive:status']('offline');
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
      'Drive sync error',
      'Test error',
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
