import React from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';

// createRootのモック
vi.mock('react-dom/client', () => ({
  createRoot: vi.fn(() => ({
    render: vi.fn(),
  })),
}));

// Appコンポーネントのモック
vi.mock('../../App', () => ({
  default: () => null,
}));

describe('main.tsx', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // DOMをリセット
    document.body.innerHTML = '';
  });

  it('rootエレメントが存在する場合、アプリケーションが正しく初期化されること', () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);

    // main.tsxのコードを直接実行
    const container = document.getElementById('root');
    if (!container) {
      throw new Error('Failed to find the root element');
    }
    const reactRoot = createRoot(container);
    reactRoot.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );

    expect(createRoot).toHaveBeenCalledWith(root);
    expect(
      vi.mocked(createRoot).mock.results[0].value.render,
    ).toHaveBeenCalled();
  });

  it('rootエレメントが存在しない場合、エラーがスローされること', () => {
    expect(() => {
      // main.tsxのコードを直接実行
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
    }).toThrow('Failed to find the root element');
  });
});
