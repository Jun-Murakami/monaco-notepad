import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom';

import { useMessageDialogStore } from '../../stores/useMessageDialogStore';
import { MessageDialog } from '../MessageDialog';

// 各テスト前にストアをリセットして、表示状態が漏れないようにする
beforeEach(() => {
  useMessageDialogStore.getState().reset();
});

const seedOpen = (
  overrides: Partial<{
    title: string;
    message: string;
    isTwoButton: boolean;
    primaryButtonText: string;
    secondaryButtonText: string;
  }> = {},
) => {
  useMessageDialogStore.setState({
    isOpen: true,
    title: overrides.title ?? 'Test Title',
    message: overrides.message ?? 'Test Message',
    isTwoButton: overrides.isTwoButton ?? false,
    primaryButtonText: overrides.primaryButtonText ?? 'OK',
    secondaryButtonText: overrides.secondaryButtonText ?? 'Cancel',
    resolver: null,
  });
};

describe('MessageDialog', () => {
  it('ダイアログが閉じているとき、要素が表示されないこと', () => {
    render(<MessageDialog />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ダイアログが開いているとき、タイトルとメッセージが表示されること', () => {
    seedOpen();
    render(<MessageDialog />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Test Title')).toBeInTheDocument();
    expect(screen.getByText('Test Message')).toBeInTheDocument();
  });

  it('シングルボタンモードで、Closeボタンのみ表示されること', () => {
    seedOpen();
    render(<MessageDialog />);

    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('ツーボタンモードで、両方のボタンが表示されること', async () => {
    seedOpen({ isTwoButton: true });
    await act(async () => {
      render(<MessageDialog />);
    });

    expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('カスタムボタンテキストが正しく表示されること', async () => {
    seedOpen({
      isTwoButton: true,
      primaryButtonText: 'はい',
      secondaryButtonText: 'いいえ',
    });
    await act(async () => {
      render(<MessageDialog />);
    });

    expect(screen.getByRole('button', { name: 'はい' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'いいえ' })).toBeInTheDocument();
  });

  it('Closeボタンクリック時に showMessage の Promise が true で解決されること', async () => {
    const promise = useMessageDialogStore
      .getState()
      .showMessage('Test Title', 'Test Message');
    render(<MessageDialog />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await expect(promise).resolves.toBe(true);
    expect(useMessageDialogStore.getState().isOpen).toBe(false);
  });

  it('Cancelボタンクリック時に showMessage の Promise が false で解決されること', async () => {
    const promise = useMessageDialogStore
      .getState()
      .showMessage('Test Title', 'Test Message', true);
    render(<MessageDialog />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(promise).resolves.toBe(false);
    expect(useMessageDialogStore.getState().isOpen).toBe(false);
  });

  // アクセシビリティテスト
  it('ダイアログが適切なARIAラベルを持つこと', () => {
    seedOpen();
    render(<MessageDialog />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-labelledby');
    expect(dialog).toHaveAttribute('aria-describedby');
  });
});
