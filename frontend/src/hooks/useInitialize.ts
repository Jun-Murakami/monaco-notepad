import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ApplyIntegrityFixes,
  GetArchivedTopLevelOrder,
  GetNativeSystemLocale,
  GetTopLevelOrder,
  ListFolders,
  ListNotes,
  LoadFileNotes,
  LoadSettings,
  NotifyFrontendReady,
} from '../../wailsjs/go/backend/App';
import * as runtime from '../../wailsjs/runtime';
import i18n from '../i18n';
import { getSupportedLanguages, type LanguageInfo } from '../lib/monaco';
import { useFileNotesStore } from '../stores/useFileNotesStore';

import type {
  FileNote,
  Folder,
  IntegrityFixSelection,
  IntegrityIssue,
  Note,
  TopLevelItem,
} from '../types';

const SPLIT_EDITOR_STATE_KEY = 'splitEditorState';

const loadSplitEditorState = (): {
  isSplit: boolean;
  leftNoteId: string | null;
  leftIsFile: boolean;
} | null => {
  try {
    const raw = localStorage.getItem(SPLIT_EDITOR_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const useInitialize = (
  setNotes: (notes: Note[]) => void,
  setFolders: (folders: Folder[]) => void,
  setTopLevelOrder: (order: TopLevelItem[]) => void,
  setArchivedTopLevelOrder: (order: TopLevelItem[]) => void,
  handleNewNote: () => void,
  handleSelecAnyNote: (note: Note | FileNote) => Promise<void>,
  showMessage: (
    title: string,
    message: string,
    isTwoButton?: boolean,
    primaryButtonText?: string,
    secondaryButtonText?: string,
  ) => Promise<boolean>,
  restorePaneNotes: (notes: Note[], fileNotes: FileNote[]) => void,
) => {
  // setFileNotes は Zustand action（参照不変）。store から直接取り出す。
  const setFileNotes = useFileNotesStore((s) => s.setFileNotes);
  const [languages, setLanguages] = useState<LanguageInfo[]>([]);
  const [platform, setPlatform] = useState<string>('');
  const [systemLocale, setSystemLocale] = useState<string>('');
  const isInitializedRef = useRef(false);

  const initialNortLoader = useCallback(async () => {
    // ファイルノート一覧を取得
    const fileNotes = await LoadFileNotes();
    const loadedFileNotes = fileNotes.map((file) => ({
      id: file.id,
      filePath: file.filePath,
      fileName: file.fileName,
      content: file.content,
      originalContent: file.content,
      language: file.language,
      modifiedTime: file.modifiedTime.toString(),
    }));
    if (loadedFileNotes.length > 0) {
      setFileNotes(loadedFileNotes);
    }

    const [notes, folders, rawOrder, rawArchivedOrder] = await Promise.all([
      ListNotes(),
      ListFolders(),
      GetTopLevelOrder(),
      GetArchivedTopLevelOrder(),
    ]);
    setFolders(folders ?? []);
    setTopLevelOrder(
      (rawOrder ?? []).map((item) => ({
        type: item.type as 'note' | 'folder',
        id: item.id,
      })),
    );
    setArchivedTopLevelOrder(
      (rawArchivedOrder ?? []).map((item) => ({
        type: item.type as 'note' | 'folder',
        id: item.id,
      })),
    );
    if (!notes) {
      setNotes([]);
      handleNewNote();
      return;
    }
    const parsedNotes = notes.map((note) => ({
      ...note,
      modifiedTime: note.modifiedTime.toString(),
    }));
    setNotes(parsedNotes);
    const activeNotes = parsedNotes.filter((note) => !note.archived);

    // Try to restore the previously active note from saved state
    let restored = false;
    const settings = await LoadSettings();
    const splitState = loadSplitEditorState();

    if (settings.isSplit && splitState?.leftNoteId) {
      // Split mode was active: find the left pane note to initialize
      const leftNote = splitState.leftIsFile
        ? loadedFileNotes.find((f) => f.id === splitState.leftNoteId)
        : activeNotes.find((n) => n.id === splitState.leftNoteId);
      if (leftNote) {
        await handleSelecAnyNote(leftNote);
        restored = true;
      }
    } else if (settings.lastActiveNoteId) {
      // Single pane: try to restore the last active note
      const note = settings.lastActiveNoteIsFile
        ? loadedFileNotes.find((f) => f.id === settings.lastActiveNoteId)
        : activeNotes.find((n) => n.id === settings.lastActiveNoteId);
      if (note) {
        await handleSelecAnyNote(note);
        restored = true;
      }
    }

    if (!restored) {
      if (loadedFileNotes.length > 0) {
        await handleSelecAnyNote(loadedFileNotes[0]);
      } else if (activeNotes.length > 0) {
        await handleSelecAnyNote(activeNotes[0]);
      } else {
        handleNewNote();
      }
    }

    restorePaneNotes(parsedNotes, loadedFileNotes);
  }, [
    handleNewNote,
    handleSelecAnyNote,
    setFileNotes,
    setFolders,
    setTopLevelOrder,
    setArchivedTopLevelOrder,
    setNotes,
    restorePaneNotes,
  ]);

  useEffect(() => {
    const handleIntegrityIssues = async (issues: IntegrityIssue[]) => {
      if (!issues || issues.length === 0) {
        return;
      }

      const selections: IntegrityFixSelection[] = [];

      for (const issue of issues) {
        if (!issue.needsUserDecision) {
          continue;
        }

        if (!issue.fixOptions || issue.fixOptions.length < 2) {
          await showMessage(
            i18n.t('integrity.noticeTitle'),
            issue.summary,
            false,
            i18n.t('dialog.ok'),
          );
          continue;
        }

        const primary = issue.fixOptions[0];
        const secondary = issue.fixOptions[1];
        const confirmed = await showMessage(
          i18n.t('integrity.unknownFileTitle'),
          issue.summary,
          true,
          primary.label,
          secondary.label,
        );
        selections.push({
          issueId: issue.id,
          fixId: confirmed ? primary.id : secondary.id,
        });
      }

      if (selections.length > 0) {
        try {
          await ApplyIntegrityFixes(selections);
        } catch (error) {
          console.error('Failed to apply integrity fixes:', error);
        }
      }
    };

    runtime.EventsOn('notes:integrity-issues', handleIntegrityIssues);
    return () => {
      runtime.EventsOff('notes:integrity-issues');
    };
  }, [showMessage]);

  useEffect(() => {
    const handleOrphanRecoveries = async (
      recoveries: {
        source: string;
        count: number;
        folderName: string;
        deletedDuplicates: number;
      }[],
    ) => {
      if (!recoveries || recoveries.length === 0) return;
      for (const recovery of recoveries) {
        const lines: string[] = [];
        if (recovery.count > 0) {
          const messageKey =
            recovery.source === 'local'
              ? 'orphan.recoveryDialogLocal'
              : 'orphan.recoveryDialogCloud';
          lines.push(
            i18n.t(messageKey, {
              count: recovery.count,
              folder: recovery.folderName,
            }),
          );
        }
        if (recovery.deletedDuplicates > 0) {
          lines.push(
            i18n.t('orphan.recoveryDialogCloudDeleted', {
              count: recovery.deletedDuplicates,
            }),
          );
        }
        if (lines.length === 0) continue;
        await showMessage(
          i18n.t('orphan.recoveryDialogTitle'),
          lines.join('\n'),
          false,
          i18n.t('dialog.ok'),
        );
      }
    };
    runtime.EventsOn('notes:orphans-recovered', handleOrphanRecoveries);
    return () => {
      runtime.EventsOff('notes:orphans-recovered');
    };
  }, [showMessage]);

  useEffect(() => {
    if (isInitializedRef.current) return;
    isInitializedRef.current = true;
    const asyncFunc = async () => {
      try {
        // プラットフォームを取得
        const env = await runtime.Environment();
        setPlatform(env.platform);

        // OS のシステムロケール (例: "ja-JP", "en-US") を取得。
        // 失敗しても致命傷ではないので無視する (ランタイム既定にフォールバック)。
        try {
          const locale = await GetNativeSystemLocale();
          if (locale) setSystemLocale(locale);
        } catch (_e) {
          /* noop */
        }

        // ノートリストを先に読み込み（UIを早く表示するため）
        await initialNortLoader();

        // 言語一覧はノート表示後に取得（Monaco初期化を遅延）
        setLanguages(getSupportedLanguages());
      } catch (_error) {
        setNotes([]);
        handleNewNote();
      }
    };
    asyncFunc();

    // DomReadyはuseEffectより先に完了するため、直接通知
    NotifyFrontendReady();
  }, [initialNortLoader, handleNewNote, setNotes]);

  return {
    languages,
    platform,
    systemLocale,
  };
};
