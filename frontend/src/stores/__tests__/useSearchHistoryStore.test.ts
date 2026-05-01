import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSearchHistoryStore } from '../useSearchHistoryStore';

const STORAGE_KEY = 'monaco-notepad.search-history';

const reset = () => {
  localStorage.clear();
  useSearchHistoryStore.setState({ history: [] });
};

beforeEach(() => {
  reset();
});
afterEach(() => {
  reset();
  vi.restoreAllMocks();
});

describe('useSearchHistoryStore', () => {
  describe('add', () => {
    it('新規クエリは履歴の先頭に追加される', () => {
      const { add } = useSearchHistoryStore.getState();
      add('hello');
      add('world');
      expect(useSearchHistoryStore.getState().history).toEqual([
        'world',
        'hello',
      ]);
    });

    it('既存と同じクエリは重複追加せず先頭に詰め直される', () => {
      const { add } = useSearchHistoryStore.getState();
      add('a');
      add('b');
      add('c');
      add('a'); // 既存の "a" を先頭に持ってくる
      expect(useSearchHistoryStore.getState().history).toEqual([
        'a',
        'c',
        'b',
      ]);
    });

    it('前後の空白は trim され、空文字 / 空白のみは無視される', () => {
      const { add } = useSearchHistoryStore.getState();
      add('  hello  ');
      add('');
      add('   ');
      const history = useSearchHistoryStore.getState().history;
      expect(history).toEqual(['hello']);
    });

    it('最大 50 件で頭打ち、はみ出た古い項目は捨てられる', () => {
      const { add } = useSearchHistoryStore.getState();
      for (let i = 0; i < 60; i++) add(`q${i}`);
      const history = useSearchHistoryStore.getState().history;
      expect(history).toHaveLength(50);
      // 最新が先頭
      expect(history[0]).toBe('q59');
      // 最古は q10 (q0..q9 が落ちる)
      expect(history[49]).toBe('q10');
    });

    it('localStorage に永続化される', () => {
      useSearchHistoryStore.getState().add('persist-me');
      const raw = localStorage.getItem(STORAGE_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw as string)).toEqual(['persist-me']);
    });
  });

  describe('remove', () => {
    it('指定エントリのみが削除される', () => {
      const { add, remove } = useSearchHistoryStore.getState();
      add('a');
      add('b');
      add('c');
      remove('b');
      expect(useSearchHistoryStore.getState().history).toEqual(['c', 'a']);
    });

    it('存在しないエントリは noop（履歴は変わらない）', () => {
      const { add, remove } = useSearchHistoryStore.getState();
      add('a');
      add('b');
      remove('nonexistent');
      expect(useSearchHistoryStore.getState().history).toEqual(['b', 'a']);
    });

    it('削除も localStorage に反映される', () => {
      const { add, remove } = useSearchHistoryStore.getState();
      add('a');
      add('b');
      remove('a');
      const raw = localStorage.getItem(STORAGE_KEY);
      expect(JSON.parse(raw as string)).toEqual(['b']);
    });
  });

  describe('clear', () => {
    it('全エントリが削除される', () => {
      const { add, clear } = useSearchHistoryStore.getState();
      add('a');
      add('b');
      clear();
      expect(useSearchHistoryStore.getState().history).toEqual([]);
      const raw = localStorage.getItem(STORAGE_KEY);
      expect(JSON.parse(raw as string)).toEqual([]);
    });
  });

  describe('永続化エラーは握り潰す', () => {
    it('localStorage.setItem が例外を投げてもストアの更新は行われる', () => {
      // QuotaExceeded などを模擬
      const spy = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(() => {
          throw new Error('quota');
        });
      // 例外で死なないこと
      expect(() => useSearchHistoryStore.getState().add('x')).not.toThrow();
      expect(useSearchHistoryStore.getState().history).toEqual(['x']);
      spy.mockRestore();
    });
  });
});
