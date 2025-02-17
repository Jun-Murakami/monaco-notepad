import { useState, useEffect, useRef, useCallback } from 'react';
import { EventsOn, EventsOff } from '../../wailsjs/runtime';
import { AuthorizeDrive, LogoutDrive, SyncNow, CheckDriveConnection, CancelLoginDrive, NotifyFrontendReady } from '../../wailsjs/go/backend/App';

const SYNC_TIMEOUT = 5 * 60 * 1000; // 5分のタイムアウト

export const useDriveSync = (
  showMessage: (title: string, message: string, isTwoButton?: boolean) => Promise<boolean>,
) => {
  const [syncStatus, setSyncStatus] = useState<'synced' | 'syncing' | 'logging in' | 'offline'>('offline');
  const [isHoveringSync, setIsHoveringSync] = useState(false);
  const [isHoverLocked, setIsHoverLocked] = useState(false);
  const syncStartTime = useRef<number | null>(null);
  const syncCheckInterval = useRef<NodeJS.Timeout | null>(null);

  const handleBackendReady = useCallback(async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    await NotifyFrontendReady();
    await new Promise(resolve => setTimeout(resolve, 500));
    // 初期状態のチェック
    CheckDriveConnection().then(isConnected => {
      if (isConnected) {
        setSyncStatus('synced');
      } else {
        setSyncStatus('offline');
      }
    });
  }, []);

  const handleSync = useCallback(() => {
    setSyncStatus('syncing');
  }, []);

  // 同期状態の監視を開始
  const startSyncMonitoring = useCallback(() => {
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
  }, [syncStatus]);

  // 同期状態の監視を停止
  const stopSyncMonitoring = useCallback(() => {
    if (syncCheckInterval.current) {
      clearInterval(syncCheckInterval.current);
      syncCheckInterval.current = null;
    }
    syncStartTime.current = null;
  }, []);

  // ドライブの状態をUIに反映
  const handleDriveStatus = useCallback((status: string) => {
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
  }, [startSyncMonitoring, stopSyncMonitoring]);

  // ドライブのエラーを処理
  const handleDriveError = useCallback((error: string) => {
    showMessage('Drive error', error);
    console.error('Drive error:', error);
  }, [showMessage]);

  // ドライブの状態を監視
  useEffect(() => {
    // 各種イベント登録
    EventsOn('notes:updated', handleSync);
    EventsOn('drive:status', handleDriveStatus);
    EventsOn('drive:error', handleDriveError);

    // バックエンドの準備完了を待ってから通知
    EventsOn('backend:ready', handleBackendReady);

    return () => {
      EventsOff('notes:updated');
      EventsOff('drive:status');
      EventsOff('drive:error');
      EventsOff('backend:ready');
      stopSyncMonitoring();
    };
  }, [handleBackendReady, handleSync, handleDriveStatus, handleDriveError, stopSyncMonitoring]);

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
      const result = await showMessage('Logout from Google Drive', 'Are you sure you want to logout?', true);
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
        showMessage('Sync Error', `Failed to synchronize with Google Drive: ${error}`);
      }
    }
  }, [showMessage, syncStatus]);

  // 強制ログアウト処理
  const handleForcedLogout = useCallback(async (message: string) => {
    stopSyncMonitoring();
    try {
      await LogoutDrive();
      showMessage('Sync Error', message);
    } catch (error) {
      console.error('Forced logout error:', error);
      showMessage('Error', `Failed to logout: ${error}`);
    }
  }, [showMessage, stopSyncMonitoring]);

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