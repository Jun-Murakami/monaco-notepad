import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';
import '@testing-library/jest-dom';
import { VersionUp } from '../VersionUp';
import { GetAppVersion, Console } from '../../../wailsjs/go/backend/App';

// モックの設定
vi.mock('../../../wailsjs/go/backend/App', () => ({
  GetAppVersion: vi.fn(),
  Console: vi.fn(),
}));

// window.openのモック
const mockOpen = vi.fn();
window.open = mockOpen;

// fetchのモック
global.fetch = vi.fn();

describe('VersionUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpen.mockClear();
  });

  it('新しいバージョンが利用可能な場合、更新チップが表示されること', async () => {
    // モックの設定
    (GetAppVersion as Mock).mockResolvedValue('1.0.0');
    (global.fetch as Mock).mockResolvedValue({
      json: () => Promise.resolve({ tag_name: 'v1.0.1' }),
    });

    render(<VersionUp />);

    // チップが表示されることを確認
    await waitFor(() => {
      expect(screen.getByText('Update? v1.0.1')).toBeInTheDocument();
    });
  });

  it('現在のバージョンが最新の場合、更新チップが表示されないこと', async () => {
    // モックの設定
    (GetAppVersion as Mock).mockResolvedValue('1.0.1');
    (global.fetch as Mock).mockResolvedValue({
      json: () => Promise.resolve({ tag_name: 'v1.0.1' }),
    });

    render(<VersionUp />);

    // チップが表示されないことを確認
    await waitFor(() => {
      expect(screen.queryByText(/Update\?/)).not.toBeInTheDocument();
    });
  });

  it('チップをクリックすると、更新ページが開くこと', async () => {
    // モックの設定
    (GetAppVersion as Mock).mockResolvedValue('1.0.0');
    (global.fetch as Mock).mockResolvedValue({
      json: () => Promise.resolve({ tag_name: 'v1.0.1' }),
    });

    render(<VersionUp />);

    // チップをクリック
    await waitFor(() => {
      const chip = screen.getByText('Update? v1.0.1');
      fireEvent.click(chip);
    });

    // window.openが正しく呼ばれることを確認
    expect(mockOpen).toHaveBeenCalledWith('https://jun-murakami.web.app/#monacoNotepad', '_blank');
  });

  it('削除ボタンをクリックすると、チップが非表示になること', async () => {
    // モックの設定
    (GetAppVersion as Mock).mockResolvedValue('1.0.0');
    (global.fetch as Mock).mockResolvedValue({
      json: () => Promise.resolve({ tag_name: 'v1.0.1' }),
    });

    render(<VersionUp />);

    // チップが表示されるのを待つ
    await waitFor(() => {
      expect(screen.getByText('Update? v1.0.1')).toBeInTheDocument();
    });

    // 削除ボタンをクリック
    const deleteButton = screen.getByTestId('CancelIcon');
    fireEvent.click(deleteButton);

    // チップが非表示になるのを待つ
    await waitFor(() => {
      expect(screen.queryByText('Update? v1.0.1')).not.toBeInTheDocument();
    });
  });

  it('バージョン取得に失敗した場合、エラーがログに記録されること', async () => {
    // モックの設定
    (GetAppVersion as Mock).mockResolvedValue('1.0.0');
    (global.fetch as Mock).mockRejectedValue(new Error('Network error'));

    render(<VersionUp />);

    // Consoleが呼ばれることを確認
    await waitFor(() => {
      expect(Console).toHaveBeenCalledWith('Failed to get version', [new Error('Network error')]);
    });
  });
});
