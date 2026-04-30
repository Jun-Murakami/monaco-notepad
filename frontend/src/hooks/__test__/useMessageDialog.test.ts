import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useMessageDialogStore } from '../../stores/useMessageDialogStore';

// useMessageDialog は薄いシムになったので、このテストはストア（実体）の挙動を検証する。
// 旧 hook が持っていた state 群はストアに移動している。

describe('useMessageDialogStore', () => {
  beforeEach(() => {
    useMessageDialogStore.getState().reset();
  });

  afterEach(() => {
    useMessageDialogStore.getState().reset();
  });

  it('初期状態が正しく設定されていること', () => {
    const state = useMessageDialogStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.title).toBe('');
    expect(state.message).toBe('');
    expect(state.isTwoButton).toBe(false);
    expect(state.primaryButtonText).toBe('');
    expect(state.secondaryButtonText).toBe('');
    expect(state.resolver).toBeNull();
  });

  it('showMessage を呼ぶとダイアログが開き、resolveResult で Promise が解決される', async () => {
    const promise = useMessageDialogStore
      .getState()
      .showMessage('Test Title', 'Test Message');

    let state = useMessageDialogStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.title).toBe('Test Title');
    expect(state.message).toBe('Test Message');

    await act(async () => {
      useMessageDialogStore.getState().resolveResult(true);
    });

    state = useMessageDialogStore.getState();
    expect(state.isOpen).toBe(false);
    await expect(promise).resolves.toBe(true);
  });

  it('カスタムボタンテキストが正しく設定されること', () => {
    void useMessageDialogStore
      .getState()
      .showMessage('Test Title', 'Test Message', true, 'はい', 'いいえ');

    const state = useMessageDialogStore.getState();
    expect(state.primaryButtonText).toBe('はい');
    expect(state.secondaryButtonText).toBe('いいえ');
    expect(state.isTwoButton).toBe(true);
  });

  it('resolveResult(false) で Promise が false で解決されること', async () => {
    const promise = useMessageDialogStore
      .getState()
      .showMessage('Title', 'Msg', true);

    await act(async () => {
      useMessageDialogStore.getState().resolveResult(false);
    });

    await expect(promise).resolves.toBe(false);
  });
});
