import { showMessage } from '../stores/useMessageDialogStore';

// 旧 useMessageDialog API の互換シム。
// 実体は useMessageDialogStore (Zustand) に移っているので、ここでは hook が
// 「showMessage を返す」だけのラッパに縮退している。
// hook 内で useState を持たないため、呼び出し元コンポーネントは
// メッセージダイアログ表示で再レンダーされなくなる（ダイアログ自身だけが再描画）。
//
// 既存の `useFileNotes({ showMessage })` のような prop 渡しの形は維持する。
// 段階的移行用：将来的には呼び出し元から `import { showMessage } from '...'`
// 直接呼べるので、props 渡しは順次撤去可能。
export const useMessageDialog = () => {
  return { showMessage };
};
