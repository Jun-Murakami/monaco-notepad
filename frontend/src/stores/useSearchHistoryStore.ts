import { create } from 'zustand';

// クロスノート検索ボックスの履歴。最大 MAX_ITEMS 件、新しい順、重複は前詰めで吸収。
// localStorage に永続化することで、Wails の埋め込み WebView でも確実に保持できる。
// （WebView2 / WKWebView の form autofill ストアは不安定なため自前管理）

const STORAGE_KEY = 'monaco-notepad.search-history';
const MAX_ITEMS = 50;

const loadFromStorage = (): string[] => {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
};

const saveToStorage = (history: string[]): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // クォータ超過等は無視（履歴は失われても致命的でないため）
  }
};

interface SearchHistoryState {
  history: string[];
}

interface SearchHistoryActions {
  add: (query: string) => void;
  remove: (query: string) => void;
  clear: () => void;
}

export const useSearchHistoryStore = create<
  SearchHistoryState & SearchHistoryActions
>((set, get) => ({
  history: loadFromStorage(),
  add: (query) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const current = get().history;
    // 既存エントリを除去してから先頭に追加（=最近使った順を維持）
    const next = [trimmed, ...current.filter((q) => q !== trimmed)].slice(
      0,
      MAX_ITEMS,
    );
    set({ history: next });
    saveToStorage(next);
  },
  remove: (query) => {
    const next = get().history.filter((q) => q !== query);
    set({ history: next });
    saveToStorage(next);
  },
  clear: () => {
    set({ history: [] });
    saveToStorage([]);
  },
}));
