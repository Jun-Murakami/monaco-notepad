import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AuthorizeDrive,
  CancelLoginDrive,
  CheckDriveConnection,
  LogoutDrive,
  NotifyFrontendReady,
  SyncNow,
} from '../../wailsjs/go/backend/App';
import { EventsOff, EventsOn } from '../../wailsjs/runtime';

const SYNC_TIMEOUT = 5 * 60 * 1000; // 5分のタイムアウト

export const useDriveSync = (
  showMessage: (
    title: string,
    message: string,
    isTwoButton?: boolean,
  ) => Promise<boolean>,
) => {
  const [syncStatus, setSyncStatus] = useState<
    'synced' | 'syncing' | 'logging in' | 'offline'
  >('offline');
  const [isHoveringSync, setIsHoveringSync] = useState(false);
  const [isHoverLocked, setIsHoverLocked] = useState(false);
  const syncStartTime = useRef<number | null>(null);
  const syncCheckInterval = useRef<NodeJS.Timeout | null>(null);

  const handleBackendReady = useCallback(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await NotifyFrontendReady();
    // フォールバック: Drive初期化完了を待ってから接続チェック（通常はdrive:statusイベントで更新される）
    await new Promise((resolve) => setTimeout(resolve, 3000));
    CheckDriveConnection().then((isConnected) => {
      if (isConnected && syncStatus === 'offline') {
        setSyncStatus('synced');
      }
    });
  }, [syncStatus]);

  const handleSync = useCallback(() => {
    setSyncStatus('syncing');
  }, []);

  // 同期状態の監視を停止
  const stopSyncMonitoring = useCallback(() => {
    if (syncCheckInterval.current) {
      clearInterval(syncCheckInterval.current);
      syncCheckInterval.current = null;
    }
    syncStartTime.current = null;
  }, []);

  // 強制ログアウト処理
  const handleForcedLogout = useCallback(
    async (message: string) => {
      stopSyncMonitoring();
      try {
        await LogoutDrive();
        showMessage('Sync Error', message);
      } catch (error) {
        console.error('Forced logout error:', error);
        showMessage('Error', `Failed to logout: ${error}`);
      }
    },
    [showMessage, stopSyncMonitoring],
  );

  // 同期状態の監視を開始
  const startSyncMonitoring = useCallback(() => {
    if (syncCheckInterval.current) {
      clearInterval(syncCheckInterval.current);
    }

    syncStartTime.current = Date.now();
    syncCheckInterval.current = setInterval(async () => {
      try {
        const isConnected = await CheckDriveConnection();

        if (!isConnected && syncStatus !== 'logging in') {
          await handleForcedLogout(
            'Drive connection lost. Please login again.',
          );
          return;
        }

        if (isConnected) {
          syncStartTime.current = Date.now();
        }

        if (
          syncStartTime.current &&
          Date.now() - syncStartTime.current > SYNC_TIMEOUT
        ) {
          await handleForcedLogout('Sync timeout. Please login again.');
          return;
        }
      } catch (error) {
        console.error('Sync monitoring error:', error);
        await handleForcedLogout(
          'Error checking sync status. Please login again.',
        );
      }
    }, 10000);
  }, [syncStatus, handleForcedLogout]);

  // ドライブの状態をUIに反映
  const handleDriveStatus = useCallback(
    (status: string) => {
      setSyncStatus(status as 'synced' | 'syncing' | 'logging in' | 'offline');
      // 同期中の場合は監視を開始
      if (status === 'syncing') {
        startSyncMonitoring();
      } else {
        // 同期完了時は監視を停止
        stopSyncMonitoring();
        // 同期完了時はホバー状態をリセット
        if (status === 'synced') {
          setIsHoveringSync(false);
          setIsHoverLocked(true);
          const timer = setTimeout(() => {
            setIsHoverLocked(false);
          }, 500);
          return () => clearTimeout(timer);
        }
      }
    },
    [startSyncMonitoring, stopSyncMonitoring],
  );

  // ドライブのエラーを処理
  const handleDriveError = useCallback(
    (error: string) => {
      showMessage('Drive error', error);
      console.error('Drive error:', error);
    },
    [showMessage],
  );

  // ドライブの状態を監視
  useEffect(() => {
    EventsOn('notes:updated', handleSync);
    EventsOn('drive:status', handleDriveStatus);
    EventsOn('drive:error', handleDriveError);

    // DomReadyはuseEffectより先に完了するため、直接呼び出し
    handleBackendReady();

    return () => {
      EventsOff('notes:updated');
      EventsOff('drive:status');
      EventsOff('drive:error');
      stopSyncMonitoring();
    };
  }, [
    handleBackendReady,
    handleSync,
    handleDriveStatus,
    handleDriveError,
    stopSyncMonitoring,
  ]);

  // ログイン認証
  const handleGoogleAuth = useCallback(async () => {
    try {
      setSyncStatus('syncing');
      await AuthorizeDrive();
    } catch (error) {
      console.error('Google authentication error:', error);
      showMessage('Error', `Google authentication failed: ${error}`);
      setSyncStatus('offline');
    }
  }, [showMessage]);

  // ログアウト
  const handleLogout = useCallback(async () => {
    try {
      // ログイン中の場合はキャンセル処理を実行
      if (syncStatus === 'logging in') {
        await CancelLoginDrive();
        return;
      }

      // 通常のログアウト処理（確認あり）
      const result = await showMessage(
        'Logout from Google Drive',
        'Are you sure you want to logout?',
        true,
      );
      if (result) {
        await LogoutDrive();
      }
    } catch (error) {
      console.error('Logout error:', error);
      showMessage('Error', `Logout failed: ${error}`);
    }
  }, [showMessage, syncStatus]);

  // 今すぐ同期
  const handleSyncNow = useCallback(async () => {
    if (syncStatus === 'synced') {
      try {
        setIsHoveringSync(false);
        setSyncStatus('syncing');
        await SyncNow();
        setSyncStatus('synced');
      } catch (error) {
        console.error('Manual sync error:', error);
        showMessage(
          'Sync Error',
          `Failed to synchronize with Google Drive: ${error}`,
        );
      }
    }
  }, [showMessage, syncStatus]);

  return {
    syncStatus,
    isHoveringSync,
    setIsHoveringSync,
    isHoverLocked,
    handleGoogleAuth,
    handleLogout,
    handleSyncNow,
  };
};
