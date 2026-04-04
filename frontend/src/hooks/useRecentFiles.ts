import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckFileExists,
  LoadRecentFiles,
  SaveRecentFiles,
} from '../../wailsjs/go/backend/App';
import i18n from '../i18n';
import type { FileNote } from '../types';

const MAX_RECENT_FILES = 20;

interface UseRecentFilesProps {
  fileNotes: FileNote[];
  handleOpenFileByPath: (filePath: string) => Promise<void>;
  showMessage: (
    title: string,
    message: string,
    isTwoButton?: boolean,
    button1?: string,
    button2?: string,
  ) => Promise<boolean>;
}

export const useRecentFiles = ({
  fileNotes,
  handleOpenFileByPath,
  showMessage,
}: UseRecentFilesProps) => {
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const recentFilesRef = useRef(recentFiles);
  recentFilesRef.current = recentFiles;

  // 初期化時にロード
  useEffect(() => {
    LoadRecentFiles()
      .then((files) => setRecentFiles(files ?? []))
      .catch(() => setRecentFiles([]));
  }, []);

  // 最近開いたファイルにパスを追加
  const addRecentFile = useCallback(async (filePath: string) => {
    if (!filePath) return;
    const updated = [
      filePath,
      ...recentFilesRef.current.filter((p) => p !== filePath),
    ].slice(0, MAX_RECENT_FILES);
    recentFilesRef.current = updated;
    setRecentFiles(updated);
    await SaveRecentFiles(updated).catch(() => {});
  }, []);

  // 最近開いたファイルからパスを削除
  const removeRecentFile = useCallback(async (filePath: string) => {
    const updated = recentFilesRef.current.filter((p) => p !== filePath);
    recentFilesRef.current = updated;
    setRecentFiles(updated);
    await SaveRecentFiles(updated).catch(() => {});
  }, []);

  // 履歴をクリア
  const clearRecentFiles = useCallback(async () => {
    recentFilesRef.current = [];
    setRecentFiles([]);
    await SaveRecentFiles([]).catch(() => {});
  }, []);

  // 最近開いたファイルを選択して開く
  const openRecentFile = useCallback(
    async (filePath: string) => {
      // 既に開いているファイルの場合はスキップ（呼び出し元で処理される）
      const exists = await CheckFileExists(filePath);
      if (!exists) {
        const shouldRemove = await showMessage(
          i18n.t('file.recentFileNotFoundTitle'),
          i18n.t('file.recentFileNotFound'),
          true,
          i18n.t('dialog.delete'),
          i18n.t('dialog.cancel'),
        );
        if (shouldRemove) {
          await removeRecentFile(filePath);
        }
        return;
      }
      await handleOpenFileByPath(filePath);
    },
    [handleOpenFileByPath, showMessage, removeRecentFile],
  );

  // ファイルが開かれたら自動的に最近開いたファイルに追加
  const prevFilePathsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentPaths = new Set(
      fileNotes.map((f) => f.filePath).filter(Boolean),
    );
    // 初回は初期化のみ
    if (prevFilePathsRef.current.size === 0 && currentPaths.size > 0) {
      prevFilePathsRef.current = currentPaths;
      return;
    }
    // 新しく追加されたパスを検出
    for (const path of currentPaths) {
      if (!prevFilePathsRef.current.has(path)) {
        addRecentFile(path);
      }
    }
    prevFilePathsRef.current = currentPaths;
  }, [fileNotes, addRecentFile]);

  // 現在開いているファイルを除外したリスト
  const availableRecentFiles = recentFiles.filter(
    (path) => !fileNotes.some((f) => f.filePath === path),
  );

  return {
    recentFiles: availableRecentFiles,
    addRecentFile,
    removeRecentFile,
    clearRecentFiles,
    openRecentFile,
  };
};
