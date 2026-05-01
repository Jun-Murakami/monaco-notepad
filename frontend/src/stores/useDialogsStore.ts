import { create } from 'zustand';

import type { Note } from '../types';

// 二次的なダイアログ群（設定 / バージョン / 競合バックアップ）の開閉状態。
// App.tsx 直下の useState を集約し、<DialogHost /> がこれを購読してダイアログを描画する。
// SettingsDialog → ConflictBackupsDialog → About 等のダイアログ間遷移も
// open/close アクションの組合せで完結させる。
interface DialogsState {
  isSettingsOpen: boolean;
  settingsKey: number; // 開くたびに増やすことで SettingsDialog の内部 state を初期化する
  isAboutOpen: boolean;
  isConflictBackupsOpen: boolean;
  isMobileAppOpen: boolean;
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
  setRestoreHandler: (handler) => set({ onRestoreFromBackup: handler }),
}));
