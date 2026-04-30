import React from 'react';
import { HotkeysProvider } from '@tanstack/react-hotkeys';
import { createRoot } from 'react-dom/client';

import App from './App';
import { Providers } from './components/Providers';
import { initI18n } from './i18n';
import { registerMessageDialogBridge } from './stores/useMessageDialogStore';
import { initSearchReplace } from './stores/useSearchReplaceStore';

// i18nの初期化（起動時はシステム言語を使用し、その後設定で上書き）
initI18n('system');

// Wails バックエンド側の `show-message` イベントを 1 度だけ購読する
registerMessageDialogBridge();

// 検索/置換の Monaco ブリッジ初期化（context 変化で listener を attach し直す）
initSearchReplace();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Failed to find the root element');
}

const root = createRoot(container);

root.render(
  <React.StrictMode>
    <HotkeysProvider>
      <Providers>
        <App />
      </Providers>
    </HotkeysProvider>
  </React.StrictMode>,
);
