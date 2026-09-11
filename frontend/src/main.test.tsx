import { beforeEach, describe, expect, it, vi } from 'vitest';

const boot = vi.hoisted(() => ({
  wait: vi.fn(),
  render: vi.fn(),
}));

vi.mock('../wailsjs/go/backend/App', () => ({
  WaitForBackendReady: boot.wait,
}));
vi.mock('react-dom/client', () => ({
  createRoot: () => ({ render: boot.render }),
}));
vi.mock('./App', () => ({ default: () => null }));
vi.mock('./components/Providers', () => ({ Providers: () => null }));
vi.mock('./stores/useMessageDialogStore', () => ({
  registerMessageDialogBridge: vi.fn(),
}));
vi.mock('./stores/useSearchReplaceStore', () => ({
  initSearchReplace: vi.fn(),
}));

describe('desktop bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="root"></div>';
  });

  it('コールド起動で準備が遅れても、初期化前に画面を起動しない', async () => {
    let ready!: () => void;
    boot.wait.mockReturnValue(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    await import('./main');

    // Startup がディスクを読む間に React を起動すると、各 hook が未初期化の API を呼ぶ。
    expect(boot.render).not.toHaveBeenCalled();
    expect(boot.wait).toHaveBeenCalledOnce();
    ready();
    await Promise.resolve();
    expect(boot.render).toHaveBeenCalledOnce();
  });

  it('バックエンドが先に準備済みでも通知を取り逃さず画面を起動する', async () => {
    boot.wait.mockResolvedValue(undefined);
    await import('./main');
    await Promise.resolve();
    expect(boot.wait).toHaveBeenCalledOnce();
    expect(boot.render).toHaveBeenCalledOnce();
  });
});
