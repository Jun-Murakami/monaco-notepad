import { create } from 'zustand';

import * as wailsRuntime from '../../wailsjs/runtime';
import i18n from '../i18n';

// メッセージ・確認ダイアログのグローバルストア。
// 旧 useMessageDialog フックを呼んでいた App.tsx 直下の useState 群を Zustand に移し、
// ダイアログ表示はトップレベルの <MessageDialog /> が購読する形に変える。
// これにより `showMessage` をフック経由で props バケツリレーする必要がなくなる
// （非コンポーネント文脈からも import するだけで呼べる）。
interface MessageDialogState {
  isOpen: boolean;
  title: string;
  message: string;
  isTwoButton: boolean;
  primaryButtonText: string;
  secondaryButtonText: string;
  resolver: ((result: boolean) => void) | null;
}

interface MessageDialogActions {
  showMessage: (
    title: string,
    message: string,
    isTwoButton?: boolean,
    primaryButtonText?: string,
    secondaryButtonText?: string,
  ) => Promise<boolean>;
  resolveResult: (result: boolean) => void;
  reset: () => void;
}

const INITIAL_STATE: MessageDialogState = {
  isOpen: false,
  title: '',
  message: '',
  isTwoButton: false,
  primaryButtonText: '',
  secondaryButtonText: '',
  resolver: null,
};

export const useMessageDialogStore = create<
  MessageDialogState & MessageDialogActions
>((set, get) => ({
  ...INITIAL_STATE,
  showMessage: (title, message, isTwoButton = false, primary, secondary) => {
    return new Promise<boolean>((resolve) => {
      set({
        isOpen: true,
        title,
        message,
        isTwoButton,
        primaryButtonText: primary ?? i18n.t('dialog.ok'),
        secondaryButtonText: secondary ?? i18n.t('dialog.cancel'),
        resolver: resolve,
      });
    });
  },
  resolveResult: (result) => {
    const { resolver } = get();
    set({ isOpen: false, resolver: null });
    resolver?.(result);
  },
  reset: () => set(INITIAL_STATE),
}));

// コンポーネント外からも呼べるトップレベル関数。
// import { showMessage } from '...' で hook 不要に使える。
export const showMessage = (
  ...args: Parameters<MessageDialogActions['showMessage']>
): Promise<boolean> => useMessageDialogStore.getState().showMessage(...args);

// バックエンドからの 'show-message' イベントを 1 度だけ購読する。
// 旧 useMessageDialog 内では useEffect 登録だったが、ストア化したので
// app 起動時に 1 回だけ登録すれば足りる。
let bridgeRegistered = false;
export const registerMessageDialogBridge = () => {
  if (bridgeRegistered) return;
  bridgeRegistered = true;
  wailsRuntime.EventsOn(
    'show-message',
    (title: string, message: string, isTwoButton: boolean) => {
      void useMessageDialogStore
        .getState()
        .showMessage(title, message, isTwoButton);
    },
  );
};
