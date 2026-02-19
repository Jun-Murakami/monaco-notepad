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
import i18n from '../i18n';
import type { MessageCode } from '../utils/messageCode';
import { isMessageCode, translateMessageCode } from '../utils/messageCode';

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
  const syncStatusRef = useRef(syncStatus);
  syncStatusRef.current = syncStatus;
  const [isHoveringSync, setIsHoveringSync] = useState(false);
  const [isHoverLocked, setIsHoverLocked] = useState(false);
  const [isMigrationDialogOpen, setIsMigrationDialogOpen] = useState(false);
  const syncStartTime = useRef<number | null>(null);
  const syncCheckInterval = useRef<NodeJS.Timeout | null>(null);

  const handleBackendReady = useCallback(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await NotifyFrontendReady();
    // フォールバック: Drive初期化完了を待ってから接続チェック（通常はdrive:statusイベントで更新される）
    await new Promise((resolve) => setTimeout(resolve, 3000));
    CheckDriveConnection().then((isConnected) => {
      if (isConnected && syncStatusRef.current === 'offline') {
        setSyncStatus('synced');
      }
    });
  }, []);

  const handleSync = useCallback(() => {
    setSyncStatus('syncing');
  }, []);

  const stopSyncMonitoring = useCallback(() => {
    if (syncCheckInterval.current) {
      clearInterval(syncCheckInterval.current);
      syncCheckInterval.current = null;
    }
    syncStartTime.current = null;
  }, []);

  const startSyncMonitoring = useCallback(() => {
    if (syncCheckInterval.current) {
      clearInterval(syncCheckInterval.current);
    }

    syncStartTime.current = Date.now();
    syncCheckInterval.current = setInterval(async () => {
      try {
        const isConnected = await CheckDriveConnection();

        if (!isConnected && syncStatusRef.current !== 'logging in') {
          stopSyncMonitoring();
          setSyncStatus('offline');
          console.warn('Drive connection lost. Waiting for auto-recovery.');
          return;
        }

        if (isConnected) {
          syncStartTime.current = Date.now();
        }

        if (
          syncStartTime.current &&
          Date.now() - syncStartTime.current > SYNC_TIMEOUT
        ) {
          stopSyncMonitoring();
          setSyncStatus('offline');
          console.warn('Sync timeout. Please try manual sync.');
          return;
        }
      } catch (error) {
        console.error('Sync monitoring error:', error);
        stopSyncMonitoring();
        setSyncStatus('offline');
      }
    }, 10000);
  }, [stopSyncMonitoring]);

  // ドライブの状態を監視（イベントハンドラはrefで管理し、effectの再登録を防ぐ）
  const handleDriveStatusRef = useRef((_status: string) => {});
  handleDriveStatusRef.current = (status: string) => {
    setSyncStatus(status as 'synced' | 'syncing' | 'logging in' | 'offline');
    if (status === 'syncing') {
      startSyncMonitoring();
    } else {
      stopSyncMonitoring();
      if (status === 'synced') {
        setIsHoveringSync(false);
        setIsHoverLocked(true);
        setTimeout(() => {
          setIsHoverLocked(false);
        }, 500);
      }
    }
  };

  const handleDriveErrorRef = useRef((_error: string | MessageCode) => {});
  handleDriveErrorRef.current = (error: string | MessageCode) => {
    const message = isMessageCode(error)
      ? translateMessageCode(error)
      : String(error);
    showMessage(i18n.t('driveUI.syncErrorTitle'), message);
    console.error('Drive error:', error);
  };

  useEffect(() => {
    EventsOn('notes:updated', handleSync);
    EventsOn('drive:status', (status: string) =>
      handleDriveStatusRef.current(status),
    );
    EventsOn('drive:error', (error: string | MessageCode) =>
      handleDriveErrorRef.current(error),
    );
    EventsOn('drive:migration-needed', () => {
      setIsMigrationDialogOpen(true);
    });

    handleBackendReady();

    return () => {
      EventsOff('notes:updated');
      EventsOff('drive:status');
      EventsOff('drive:error');
      EventsOff('drive:migration-needed');
      stopSyncMonitoring();
    };
  }, [handleBackendReady, handleSync, stopSyncMonitoring]);

  // ログイン認証
  const handleGoogleAuth = useCallback(async () => {
    try {
      setSyncStatus('syncing');
      await AuthorizeDrive();
    } catch (error) {
      console.error('Google authentication error:', error);
      showMessage(
        i18n.t('driveUI.signInFailedTitle'),
        i18n.t('driveUI.signInFailedMessage', {
          error: String(error),
        }),
      );
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
        i18n.t('driveUI.disconnectTitle'),
        i18n.t('driveUI.disconnectMessage'),
        true,
      );
      if (result) {
        await LogoutDrive();
      }
    } catch (error) {
      console.error('Logout error:', error);
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
          i18n.t('driveUI.syncFailedTitle'),
          i18n.t('driveUI.syncFailedMessage', {
            error: String(error),
          }),
        );
      }
    }
  }, [showMessage, syncStatus]);

  return {
    syncStatus,
    isHoveringSync,
    setIsHoveringSync,
    isHoverLocked,
    isMigrationDialogOpen,
    setIsMigrationDialogOpen,
    handleGoogleAuth,
    handleLogout,
    handleSyncNow,
  };
};
