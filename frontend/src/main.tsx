import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initI18n } from './i18n';

// i18nの初期化（デフォルトは英語、後で設定から読み込み）
initI18n('en');

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
