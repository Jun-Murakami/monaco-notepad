import { useCallback, useRef, useState } from 'react';

import { useEditorSettingsStore } from '../stores/useEditorSettingsStore';

const DEFAULT_SIDEBAR_WIDTH = 242;
const DEFAULT_SPLIT_PANE_RATIO = 0.5;
const DEFAULT_MARKDOWN_PREVIEW_RATIO = 0.5;

export interface PaneSizes {
  sidebarWidth: number;
  splitPaneSize: number;
  markdownPreviewPaneSize: number;
}

// 初期値は store の現在値から取得（settings が後から非同期ロードされるため、
// 初期マウント時点ではデフォルト値の場合もある。ロード後の反映はせず初期値のみ参照）
export const usePaneSizes = () => {
  const initialSettings = useEditorSettingsStore.getState().settings;

  // サイドバーの幅（ピクセル）
  const [sidebarWidth, setSidebarWidth] = useState(
    initialSettings.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH,
  );

  // スプリットモード時の左ペインの割合（0-1）
  const [splitPaneSize, setSplitPaneSize] = useState(
    initialSettings.splitPaneSize ?? DEFAULT_SPLIT_PANE_RATIO,
  );

  // マークダウンプレビューのペインサイズ割合（0-1）
  const [markdownPreviewPaneSize, setMarkdownPreviewPaneSize] = useState(
    initialSettings.markdownPreviewPaneSize ?? DEFAULT_MARKDOWN_PREVIEW_RATIO,
  );

  // 変更をデバウンスして保存
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);

  const scheduleSave = useCallback(
    (onSave: (sizes: PaneSizes) => void) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = setTimeout(() => {
        onSave({
          sidebarWidth,
          splitPaneSize,
          markdownPreviewPaneSize,
        });
      }, 500);
    },
    [sidebarWidth, splitPaneSize, markdownPreviewPaneSize],
  );

  const handleSidebarWidthChange = useCallback((width: number) => {
    setSidebarWidth(Math.max(150, Math.min(500, width)));
  }, []);

  const handleSplitPaneSizeChange = useCallback((size: number) => {
    setSplitPaneSize(Math.max(0.1, Math.min(0.9, size)));
  }, []);

  const handleMarkdownPreviewPaneSizeChange = useCallback((size: number) => {
    setMarkdownPreviewPaneSize(Math.max(0.1, Math.min(0.9, size)));
  }, []);

  const getAllotmentSizes = useCallback(
    (
      isSplit: boolean,
      isMarkdownPreview: boolean,
      isMarkdownOnLeft: boolean,
    ): number[] => {
      if (isSplit) {
        // スプリットモード: 左右のエディタ
        return [splitPaneSize * 100, (1 - splitPaneSize) * 100];
      }
      if (isMarkdownPreview) {
        // マークダウンプレビューモード
        const editorSize = (1 - markdownPreviewPaneSize) * 100;
        const previewSize = markdownPreviewPaneSize * 100;
        return isMarkdownOnLeft
          ? [previewSize, editorSize]
          : [editorSize, previewSize];
      }
      // 通常モード: 単一エディタ
      return [100];
    },
    [splitPaneSize, markdownPreviewPaneSize],
  );

  return {
    sidebarWidth,
    splitPaneSize,
    markdownPreviewPaneSize,
    handleSidebarWidthChange,
    handleSplitPaneSizeChange,
    handleMarkdownPreviewPaneSizeChange,
    scheduleSave,
    getAllotmentSizes,
  };
};

export type UsePaneSizesReturn = ReturnType<typeof usePaneSizes>;
