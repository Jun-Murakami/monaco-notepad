import { useState, useEffect, useRef } from 'react';
import { EventsOn, EventsOff } from '../../wailsjs/runtime';
import { AuthorizeDrive, LogoutDrive, SyncNow, CheckDriveConnection, CancelLoginDrive } from '../../wailsjs/go/backend/App';

const SYNC_TIMEOUT = 5 * 60 * 1000; // 5分のタイムアウト

export const useDriveSync = (
  showMessage: (title: string, message: string, isTwoButton?: boolean) => Promise<boolean>,
) => {
  const [syncStatus, setSyncStatus] = useState<'synced' | 'syncing' | 'logging in' | 'offline'>('offline');
  const [isHoveringSync, setIsHoveringSync] = useState(false);
  const [isHoverLocked, setIsHoverLocked] = useState(false);
  const syncStartTime = useRef<number | null>(null);
  const syncCheckInterval = useRef<NodeJS.Timeout | null>(null);

  // ドライブの状態を監視
  useEffect(() => {
    const handleSync = () => {
      setSyncStatus('syncing');
    };

    // ドライブの状態をUIに反映
    const handleDriveStatus = (status: string) => {
      setSyncStatus(status as 'synced' | 'syncing' | 'logging in' | 'offline');
    };

    // ドライブのエラーを処理
    const handleDriveError = (error: string) => {
      showMessage('Drive error', error);
      console.error('Drive error:', error);
    };

    // 各種イベント登録
    EventsOn('notes:updated', handleSync);
    EventsOn('drive:status', handleDriveStatus);
    EventsOn('drive:error', handleDriveError);

    // 初期状態のチェック
    CheckDriveConnection().then(isConnected => {
      if (isConnected) {
        setSyncStatus('synced');
      } else {
        setSyncStatus('offline');
      }
    });

    return () => {
      EventsOff('notes:updated');
      EventsOff('drive:status');
      EventsOff('drive:error');
    };
  }, [showMessage]);

  // ログイン認証
  const handleGoogleAuth = async () => {
    try {
      setSyncStatus('syncing');
      await AuthorizeDrive();
    } catch (error) {
      console.error('Google authentication error:', error);
      showMessage('Error', 'Google authentication failed: ' + error);
      setSyncStatus('offline');
    }
  };

  // ログアウト
  const handleLogout = async () => {
    try {
      // ログイン中の場合はキャンセル処理を実行
      if (syncStatus === 'logging in') {
        await CancelLoginDrive();
        return;
      }

      // 通常のログアウト処理（確認あり）
      const result = await showMessage('Logout from Google Drive', 'Are you sure you want to logout?', true);
      if (result) {
        await LogoutDrive();
      }
    } catch (error) {
      console.error('Logout error:', error);
      showMessage('Error', 'Logout failed: ' + error);
    }
  };

  // 今すぐ同期
  const handleSync = async () => {
    if (syncStatus === 'synced') {
      try {
        setIsHoveringSync(false);
        setSyncStatus('syncing');
        await SyncNow();
        setSyncStatus('synced');
      } catch (error) {
        console.error('Manual sync error:', error);
        showMessage('Sync Error', 'Failed to synchronize with Google Drive: ' + error);
      }
    }
  };

  // 同期状態の監視を開始
  const startSyncMonitoring = () => {
    // 既存の監視をクリア
    if (syncCheckInterval.current) {
      clearInterval(syncCheckInterval.current);
    }

    syncStartTime.current = Date.now();
    syncCheckInterval.current = setInterval(async () => {
      try {
        // バックエンドの状態をチェック
        const isConnected = await CheckDriveConnection();

        if (!isConnected && syncStatus !== 'logging in') {
          // 切断されている場合は強制ログアウト
          await handleForcedLogout('Drive connection lost. Please login again.');
          return;
        }

        // タイムアウトチェック
        if (syncStartTime.current && Date.now() - syncStartTime.current > SYNC_TIMEOUT) {
          await handleForcedLogout('Sync timeout. Please login again.');
          return;
        }
      } catch (error) {
        console.error('Sync monitoring error:', error);
        await handleForcedLogout('Error checking sync status. Please login again.');
      }
    }, 10000); // 10秒ごとにチェック
  };

  // 同期状態の監視を停止
  const stopSyncMonitoring = () => {
    if (syncCheckInterval.current) {
      clearInterval(syncCheckInterval.current);
      syncCheckInterval.current = null;
    }
    syncStartTime.current = null;
  };

  // 強制ログアウト処理
  const handleForcedLogout = async (message: string) => {
    stopSyncMonitoring();
    try {
      await LogoutDrive();
      showMessage('Sync Error', message);
    } catch (error) {
      console.error('Forced logout error:', error);
      showMessage('Error', 'Failed to logout: ' + error);
    }
  };

  // syncStatusの変更を監視
  useEffect(() => {
    if (syncStatus === 'syncing') {
      startSyncMonitoring();
    } else {
      stopSyncMonitoring();
    }

    return () => {
      stopSyncMonitoring();
    };
  }, [syncStatus]);

  // コンポーネントのクリーンアップ
  useEffect(() => {
    return () => {
      stopSyncMonitoring();
    };
  }, []);

  // syncStatusの変更を監視して、同期完了時にホバー状態をリセット
  useEffect(() => {
    if (syncStatus === 'synced') {
      setIsHoveringSync(false);
      setIsHoverLocked(true);
      const timer = setTimeout(() => {
        setIsHoverLocked(false);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [syncStatus]);

  return {
    syncStatus,
    isHoveringSync,
    setIsHoveringSync,
    isHoverLocked,
    handleGoogleAuth,
    handleLogout,
    handleSync,
  };
}; 