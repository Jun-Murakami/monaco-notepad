import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initI18n } from './i18n';

// i18nの初期化（起動時はシステム言語を使用し、その後設定で上書き）
initI18n('system');

const container = document.getElementById('root');
if (!container) {
  throw new Error('Failed to find the root element');
}

const root = createRoot(container);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
