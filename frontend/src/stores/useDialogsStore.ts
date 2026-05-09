import { create } from 'zustand';

import type { Note } from '../types';

// 二次的なダイアログ群（設定 / バージョン / 競合バックアップ）の開閉状態。
// App.tsx 直下の useState を集約し、<DialogHost /> がこれを購読してダイアログを描画する。
// SettingsDialog → ConflictBackupsDialog → About 等のダイアログ間遷移も
// open/close アクションの組合せで完結させる。
// drive:reauth-required イベント payload と一致する。バックエンド (auth_service.go) が
// 通知時に reason を以下のいずれかで送る。
//   - "invalid_grant"  : refresh_token 失効/取り消し → 再ログイン必須
//   - "startup_failed" : 起動時の保存トークン再接続失敗 (ネットワーク等の場合も含む)
//   - "polling_failed" : ポーリング中の再接続が連続失敗
export type DriveReauthReason =
  | 'invalid_grant'
  | 'startup_failed'
  | 'polling_failed';

interface DialogsState {
  isSettingsOpen: boolean;
  settingsKey: number; // 開くたびに増やすことで SettingsDialog の内部 state を初期化する
  isAboutOpen: boolean;
  isConflictBackupsOpen: boolean;
  isMobileAppOpen: boolean;
  // 再ログインを促すダイアログ。同じオフラインセッションでバックエンドが
  // 1 度だけ drive:reauth-required を発火するので、ユーザーが「後で」を押した場合
  // 再接続→切断のたびに改めて出るだけで連続表示はしない。
  isReauthRequiredOpen: boolean;
  reauthReason: DriveReauthReason | null;
  reauthDetail: string | null;
  // ConflictBackupsDialog から復元を要求されたときに呼ぶハンドラ。
  // 復元処理は notes / topLevelOrder / currentNote 等 App 配下の state を触るため、
  // App 側が register/unregister する形でここに格納する。
  onRestoreFromBackup: ((sourceNote: Note) => Promise<void>) | null;
}

interface DialogsActions {
  openSettings: () => void;
  closeSettings: () => void;
  openAbout: () => void;
  closeAbout: () => void;
  openConflictBackups: () => void;
  closeConflictBackups: () => void;
  openMobileApp: () => void;
  closeMobileApp: () => void;
  openReauthRequired: (reason: DriveReauthReason, detail?: string) => void;
  closeReauthRequired: () => void;
  setRestoreHandler: (
    handler: ((sourceNote: Note) => Promise<void>) | null,
  ) => void;
}

const INITIAL_STATE: DialogsState = {
  isSettingsOpen: false,
  settingsKey: 0,
  isAboutOpen: false,
  isConflictBackupsOpen: false,
  isMobileAppOpen: false,
  isReauthRequiredOpen: false,
  reauthReason: null,
  reauthDetail: null,
  onRestoreFromBackup: null,
};

export const useDialogsStore = create<DialogsState & DialogsActions>((set) => ({
  ...INITIAL_STATE,
  openSettings: () =>
    set((s) => ({
      isSettingsOpen: true,
      settingsKey: s.settingsKey + 1,
    })),
  closeSettings: () => set({ isSettingsOpen: false }),
  openAbout: () => set({ isSettingsOpen: false, isAboutOpen: true }),
  closeAbout: () => set({ isAboutOpen: false }),
  openConflictBackups: () =>
    set({ isSettingsOpen: false, isConflictBackupsOpen: true }),
  closeConflictBackups: () => set({ isConflictBackupsOpen: false }),
  // 設定ダイアログの上に重ねて開くため isSettingsOpen は変更しない
  openMobileApp: () => set({ isMobileAppOpen: true }),
  closeMobileApp: () => set({ isMobileAppOpen: false }),
  openReauthRequired: (reason, detail) =>
    set({
      isReauthRequiredOpen: true,
      reauthReason: reason,
      reauthDetail: detail ?? null,
    }),
  closeReauthRequired: () =>
    set({
      isReauthRequiredOpen: false,
      reauthReason: null,
      reauthDetail: null,
    }),
  setRestoreHandler: (handler) => set({ onRestoreFromBackup: handler }),
}));
