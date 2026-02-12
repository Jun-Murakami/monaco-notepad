import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
import { MessageDialog } from '../MessageDialog';

describe('MessageDialog', () => {
  const defaultProps = {
    isOpen: false,
    title: 'Test Title',
    message: 'Test Message',
    isTwoButton: false,
    primaryButtonText: 'OK',
    secondaryButtonText: 'Cancel',
    onResult: vi.fn(),
  };

  it('ダイアログが閉じているとき、要素が表示されないこと', () => {
    render(<MessageDialog {...defaultProps} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ダイアログが開いているとき、タイトルとメッセージが表示されること', () => {
    render(<MessageDialog {...defaultProps} isOpen={true} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Test Title')).toBeInTheDocument();
    expect(screen.getByText('Test Message')).toBeInTheDocument();
  });

  it('シングルボタンモードで、Closeボタンのみ表示されること', () => {
    render(<MessageDialog {...defaultProps} isOpen={true} />);

    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('ツーボタンモードで、両方のボタンが表示されること', async () => {
    await act(async () => {
      render(
        <MessageDialog {...defaultProps} isOpen={true} isTwoButton={true} />,
      );
    });

    expect(
      screen.getByRole('button', { name: defaultProps.primaryButtonText }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: defaultProps.secondaryButtonText }),
    ).toBeInTheDocument();
  });

  it('カスタムボタンテキストが正しく表示されること', async () => {
    await act(async () => {
      render(
        <MessageDialog
          {...defaultProps}
          isOpen={true}
          isTwoButton={true}
          primaryButtonText="はい"
          secondaryButtonText="いいえ"
        />,
      );
    });

    expect(screen.getByRole('button', { name: 'はい' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'いいえ' })).toBeInTheDocument();
  });

  it('Closeボタンクリック時にonResultがtrueで呼ばれること', async () => {
    render(<MessageDialog {...defaultProps} isOpen={true} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(defaultProps.onResult).toHaveBeenCalledWith(true);
  });

  it('Cancelボタンクリック時にonResultがfalseで呼ばれること', async () => {
    render(
      <MessageDialog {...defaultProps} isOpen={true} isTwoButton={true} />,
    );
    const user = userEvent.setup();

    await user.click(
      screen.getByRole('button', { name: defaultProps.secondaryButtonText }),
    );
    expect(defaultProps.onResult).toHaveBeenCalledWith(false);
  });

  // アクセシビリティテスト
  it('ダイアログが適切なARIAラベルを持つこと', () => {
    render(<MessageDialog {...defaultProps} isOpen={true} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-labelledby');
    expect(dialog).toHaveAttribute('aria-describedby');
  });
});
