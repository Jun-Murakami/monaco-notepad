import { useCallback, useEffect, useRef } from 'react';

import { SaveNote } from '../../wailsjs/go/backend/App';
import { backend } from '../../wailsjs/go/models';
import { useCurrentNoteStore } from '../stores/useCurrentNoteStore';
import { useNotesStore } from '../stores/useNotesStore';
import { useSplitEditorStore } from '../stores/useSplitEditorStore';

import type { EditorPane, FileNote, Note, TopLevelItem } from '../types';

const STORAGE_KEY = 'splitEditorState';

interface SplitEditorStorage {
  isSplit: boolean;
  isMarkdownPreview: boolean;
  leftNoteId: string | null;
  leftIsFile: boolean;
  rightNoteId: string | null;
  rightIsFile: boolean;
}

const loadSavedState = (): SplitEditorStorage | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const savedState = loadSavedState();

// state は useSplitEditorStore に集約済み。フックは action 群と debounce タイマ管理のみ提供。
export const useSplitEditor = () => {
  const setCurrentNote = useCurrentNoteStore((s) => s.setCurrentNote);
  const setCurrentFileNote = useCurrentNoteStore((s) => s.setCurrentFileNote);

  // タイマ・dirty flag は React の外で持つ（Zustand に出すまでもないローカル副作用）
  const isLeftModified = useRef(false);
  const isRightModified = useRef(false);
  const leftDebounceTimer = useRef<NodeJS.Timeout | null>(null);
  const rightDebounceTimer = useRef<NodeJS.Timeout | null>(null);
  const pendingLeftContentRef = useRef<string | null>(null);
  const pendingRightContentRef = useRef<string | null>(null);

  // === Helper: localStorage への状態永続化 ===
  const saveSplitState = useCallback(() => {
    const s = useSplitEditorStore.getState();
    const state: SplitEditorStorage = {
      isSplit: s.isSplit,
      isMarkdownPreview: s.isMarkdownPreview,
      leftNoteId: s.leftNote?.id ?? s.leftFileNote?.id ?? null,
      leftIsFile: s.leftFileNote !== null,
      rightNoteId: s.rightNote?.id ?? s.rightFileNote?.id ?? null,
      rightIsFile: s.rightFileNote !== null,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, []);

  // === Helper: ペインのノートを保存して notes 配列にも反映 ===
  const saveAndSyncPane = useCallback((pane: 'left' | 'right') => {
    const modified = pane === 'left' ? isLeftModified : isRightModified;
    const pendingContent =
      pane === 'left' ? pendingLeftContentRef : pendingRightContentRef;
    const note =
      pane === 'left'
        ? useSplitEditorStore.getState().leftNote
        : useSplitEditorStore.getState().rightNote;

    if (modified.current && note) {
      const noteToSave =
        pendingContent.current !== null
          ? { ...note, content: pendingContent.current }
          : note;
      useNotesStore
        .getState()
        .setNotes((prev) =>
          prev.map((n) => (n.id === noteToSave.id ? noteToSave : n)),
        );
      SaveNote(backend.Note.createFrom(noteToSave), 'update').catch(
        console.error,
      );
      modified.current = false;
      pendingContent.current = null;
    }
  }, []);

  const flushPaneSave = useCallback(
    (pane: 'left' | 'right') => {
      const timer = pane === 'left' ? leftDebounceTimer : rightDebounceTimer;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      saveAndSyncPane(pane);
    },
    [saveAndSyncPane],
  );

  const scheduleSplitSave = useCallback(
    (pane: 'left' | 'right') => {
      const timer = pane === 'left' ? leftDebounceTimer : rightDebounceTimer;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => saveAndSyncPane(pane), 3000);
    },
    [saveAndSyncPane],
  );

  // === Actions ===
  const handleFocusPane = useCallback(
    (pane: EditorPane) => {
      const store = useSplitEditorStore.getState();
      store.setFocusedPane(pane);
      if (!store.isSplit) return;
      if (pane === 'left') {
        setCurrentNote(store.leftNote);
        setCurrentFileNote(store.leftFileNote);
      } else {
        setCurrentNote(store.rightNote);
        setCurrentFileNote(store.rightFileNote);
      }
    },
    [setCurrentNote, setCurrentFileNote],
  );

  const toggleSplit = useCallback(
    (rightPaneNote?: Note | FileNote) => {
      const store = useSplitEditorStore.getState();
      const wasSplit = store.isSplit;
      if (wasSplit) {
        flushPaneSave('left');
        flushPaneSave('right');
      }
      store.setIsMarkdownPreview(false);

      if (!wasSplit) {
        const { currentNote, currentFileNote } = useCurrentNoteStore.getState();
        store.setLeftNote(currentNote);
        store.setLeftFileNote(currentFileNote);
        if (rightPaneNote) {
          const isFile = 'filePath' in rightPaneNote;
          if (isFile) {
            store.setRightFileNote(rightPaneNote as FileNote);
            store.setRightNote(null);
          } else {
            store.setRightNote(rightPaneNote as Note);
            store.setRightFileNote(null);
          }
        }
        store.setFocusedPane('left');
        store.setIsSplit(true);
      } else {
        setCurrentNote(store.leftNote);
        setCurrentFileNote(store.leftFileNote);
        store.setRightNote(null);
        store.setRightFileNote(null);
        store.setLeftNote(null);
        store.setLeftFileNote(null);
        store.setFocusedPane('left');
        store.setIsSplit(false);
      }
      saveSplitState();
    },
    [setCurrentNote, setCurrentFileNote, saveSplitState, flushPaneSave],
  );

  const toggleMarkdownPreview = useCallback(() => {
    const store = useSplitEditorStore.getState();
    if (store.isSplit) {
      flushPaneSave('left');
      flushPaneSave('right');
      setCurrentNote(store.leftNote);
      setCurrentFileNote(store.leftFileNote);
      store.setRightNote(null);
      store.setRightFileNote(null);
      store.setLeftNote(null);
      store.setLeftFileNote(null);
      store.setIsSplit(false);
    }
    store.setIsMarkdownPreview(
      !useSplitEditorStore.getState().isMarkdownPreview,
    );
    useSplitEditorStore.getState().setFocusedPane('left');
    saveSplitState();
  }, [setCurrentNote, setCurrentFileNote, saveSplitState, flushPaneSave]);

  const handleSelectNoteForPane = useCallback(
    async (note: Note | FileNote) => {
      const isFile = 'filePath' in note;
      const store = useSplitEditorStore.getState();
      const pane = store.focusedPane;

      flushPaneSave(pane);

      const otherNoteId =
        pane === 'left'
          ? (store.rightNote?.id ?? store.rightFileNote?.id)
          : (store.leftNote?.id ?? store.leftFileNote?.id);
      if (otherNoteId === note.id) {
        store.setFocusedPane(pane === 'left' ? 'right' : 'left');
        setCurrentNote(isFile ? null : (note as Note));
        setCurrentFileNote(isFile ? (note as FileNote) : null);
        return;
      }

      if (pane === 'left') {
        if (isFile) {
          store.setLeftFileNote(note as FileNote);
          store.setLeftNote(null);
          setCurrentFileNote(note as FileNote);
          setCurrentNote(null);
        } else {
          store.setLeftNote(note as Note);
          store.setLeftFileNote(null);
          setCurrentNote(note as Note);
          setCurrentFileNote(null);
        }
      } else {
        if (isFile) {
          store.setRightFileNote(note as FileNote);
          store.setRightNote(null);
          setCurrentFileNote(note as FileNote);
          setCurrentNote(null);
        } else {
          store.setRightNote(note as Note);
          store.setRightFileNote(null);
          setCurrentNote(note as Note);
          setCurrentFileNote(null);
        }
      }
      saveSplitState();
    },
    [setCurrentNote, setCurrentFileNote, saveSplitState, flushPaneSave],
  );

  // 指定ペインにノートを開く（コンテキストメニュー用）
  const openNoteInPane = useCallback(
    (
      note: Note | FileNote,
      targetPane: EditorPane,
      fallbackNote?: Note | FileNote,
    ) => {
      const isFile = 'filePath' in note;
      const store = useSplitEditorStore.getState();
      const wasSplit = store.isSplit;
      const otherPane: EditorPane = targetPane === 'left' ? 'right' : 'left';

      if (wasSplit) {
        flushPaneSave(targetPane);
      }

      const setPaneNoteRaw = (pane: EditorPane, n: Note | FileNote | null) => {
        const s = useSplitEditorStore.getState();
        const isFileN = !!n && 'filePath' in n;
        if (pane === 'left') {
          s.setLeftFileNote(isFileN ? (n as FileNote) : null);
          s.setLeftNote(isFileN ? null : (n as Note | null));
        } else {
          s.setRightFileNote(isFileN ? (n as FileNote) : null);
          s.setRightNote(isFileN ? null : (n as Note | null));
        }
      };

      if (!wasSplit) {
        store.setIsMarkdownPreview(false);

        const { currentNote, currentFileNote } = useCurrentNoteStore.getState();
        const currentId = currentNote?.id ?? currentFileNote?.id;
        const otherNote =
          currentId === note.id && fallbackNote ? fallbackNote : null;

        setPaneNoteRaw(targetPane, note);

        if (otherNote) {
          setPaneNoteRaw(otherPane, otherNote);
        } else if (targetPane === 'left') {
          store.setRightNote(currentNote);
          store.setRightFileNote(currentFileNote);
        } else {
          store.setLeftNote(currentNote);
          store.setLeftFileNote(currentFileNote);
        }

        setCurrentNote(isFile ? null : (note as Note));
        setCurrentFileNote(isFile ? (note as FileNote) : null);
        store.setFocusedPane(targetPane);
        store.setIsSplit(true);
      } else {
        const otherPaneId =
          targetPane === 'left'
            ? (store.rightNote?.id ?? store.rightFileNote?.id)
            : (store.leftNote?.id ?? store.leftFileNote?.id);

        if (otherPaneId === note.id) {
          if (fallbackNote) {
            setPaneNoteRaw(otherPane, fallbackNote);
          } else {
            setPaneNoteRaw(otherPane, note);
          }
        }

        setPaneNoteRaw(targetPane, note);
        setCurrentNote(isFile ? null : (note as Note));
        setCurrentFileNote(isFile ? (note as FileNote) : null);
        store.setFocusedPane(targetPane);
      }
      saveSplitState();
    },
    [setCurrentNote, setCurrentFileNote, saveSplitState, flushPaneSave],
  );

  const syncPaneNotes = useCallback(
    (newNotes: Note[], topLevelOrder: TopLevelItem[] = []) => {
      const store = useSplitEditorStore.getState();
      if (!store.isSplit) return;

      const activeNotes = newNotes.filter((note) => !note.archived);
      const activeNoteMap = new Map(activeNotes.map((note) => [note.id, note]));
      const orderedActiveNotes: Note[] = [];
      const seenActiveNoteIDs = new Set<string>();

      for (const item of topLevelOrder) {
        if (item.type === 'note') {
          const note = activeNoteMap.get(item.id);
          if (note && !seenActiveNoteIDs.has(note.id)) {
            orderedActiveNotes.push(note);
            seenActiveNoteIDs.add(note.id);
          }
          continue;
        }
        const folderNotes = activeNotes.filter(
          (note) => note.folderId === item.id,
        );
        for (const note of folderNotes) {
          if (seenActiveNoteIDs.has(note.id)) continue;
          orderedActiveNotes.push(note);
          seenActiveNoteIDs.add(note.id);
        }
      }
      for (const note of activeNotes) {
        if (seenActiveNoteIDs.has(note.id)) continue;
        orderedActiveNotes.push(note);
        seenActiveNoteIDs.add(note.id);
      }

      const clearPaneDirtyState = (pane: 'left' | 'right') => {
        const timer = pane === 'left' ? leftDebounceTimer : rightDebounceTimer;
        const modified = pane === 'left' ? isLeftModified : isRightModified;
        const pendingContent =
          pane === 'left' ? pendingLeftContentRef : pendingRightContentRef;
        if (timer.current) {
          clearTimeout(timer.current);
          timer.current = null;
        }
        modified.current = false;
        pendingContent.current = null;
      };

      let changed = false;

      const leftNote = store.leftNote;
      if (leftNote && !isLeftModified.current) {
        const updated = activeNoteMap.get(leftNote.id);
        if (updated && updated.modifiedTime !== leftNote.modifiedTime) {
          store.setLeftNote(updated);
          pendingLeftContentRef.current = null;
          changed = true;
        }
      }

      const rightNote = store.rightNote;
      if (rightNote && !isRightModified.current) {
        const updated = activeNoteMap.get(rightNote.id);
        if (updated && updated.modifiedTime !== rightNote.modifiedTime) {
          store.setRightNote(updated);
          pendingRightContentRef.current = null;
          changed = true;
        }
      }

      const after = useSplitEditorStore.getState();
      const leftIsMissingOrArchived =
        !!after.leftNote && !activeNoteMap.has(after.leftNote.id);
      const rightIsMissingOrArchived =
        !!after.rightNote && !activeNoteMap.has(after.rightNote.id);

      const usedNoteIDs = new Set<string>();
      if (after.leftNote && !leftIsMissingOrArchived) {
        usedNoteIDs.add(after.leftNote.id);
      }
      if (after.rightNote && !rightIsMissingOrArchived) {
        usedNoteIDs.add(after.rightNote.id);
      }

      const pickTopUnopenedNote = (): Note | null => {
        for (const note of orderedActiveNotes) {
          if (!usedNoteIDs.has(note.id)) return note;
        }
        return null;
      };

      const setPaneNoteWithoutFile = (
        pane: 'left' | 'right',
        note: Note | null,
      ) => {
        const s = useSplitEditorStore.getState();
        if (pane === 'left') {
          s.setLeftNote(note);
          s.setLeftFileNote(null);
        } else {
          s.setRightNote(note);
          s.setRightFileNote(null);
        }
      };

      if (leftIsMissingOrArchived) {
        clearPaneDirtyState('left');
        const replacement = pickTopUnopenedNote();
        setPaneNoteWithoutFile('left', replacement);
        if (replacement) usedNoteIDs.add(replacement.id);
        changed = true;
      }
      if (rightIsMissingOrArchived) {
        clearPaneDirtyState('right');
        const replacement = pickTopUnopenedNote();
        setPaneNoteWithoutFile('right', replacement);
        if (replacement) usedNoteIDs.add(replacement.id);
        changed = true;
      }

      if (!changed) return;

      const final = useSplitEditorStore.getState();
      const getPaneSelection = (pane: 'left' | 'right') =>
        pane === 'left'
          ? { note: final.leftNote, file: final.leftFileNote }
          : { note: final.rightNote, file: final.rightFileNote };

      let targetPane: EditorPane = final.focusedPane;
      let targetSelection = getPaneSelection(targetPane);
      if (!targetSelection.note && !targetSelection.file) {
        const otherPane: EditorPane = targetPane === 'left' ? 'right' : 'left';
        const otherSelection = getPaneSelection(otherPane);
        if (otherSelection.note || otherSelection.file) {
          targetPane = otherPane;
          targetSelection = otherSelection;
          final.setFocusedPane(otherPane);
        }
      }

      if (targetSelection.file) {
        setCurrentFileNote(targetSelection.file);
        setCurrentNote(null);
      } else if (targetSelection.note) {
        setCurrentNote(targetSelection.note);
        setCurrentFileNote(null);
      } else {
        setCurrentNote(null);
        setCurrentFileNote(null);
      }
      saveSplitState();
    },
    [setCurrentNote, setCurrentFileNote, saveSplitState],
  );

  useEffect(() => {
    return () => {
      if (leftDebounceTimer.current) clearTimeout(leftDebounceTimer.current);
      if (rightDebounceTimer.current) clearTimeout(rightDebounceTimer.current);
    };
  }, []);

  const handleLeftNoteContentChange = useCallback(
    (newContent: string) => {
      pendingLeftContentRef.current = newContent;
      isLeftModified.current = true;
      scheduleSplitSave('left');
    },
    [scheduleSplitSave],
  );

  const handleRightNoteContentChange = useCallback(
    (newContent: string) => {
      pendingRightContentRef.current = newContent;
      isRightModified.current = true;
      scheduleSplitSave('right');
    },
    [scheduleSplitSave],
  );

  const handleLeftNoteLanguageChange = useCallback(
    (newLanguage: string) => {
      const store = useSplitEditorStore.getState();
      const prev = store.leftNote;
      if (!prev) return;
      const pendingContent = pendingLeftContentRef.current;
      isLeftModified.current = true;
      store.setLeftNote({
        ...prev,
        language: newLanguage,
        ...(pendingContent !== null ? { content: pendingContent } : {}),
        modifiedTime: new Date().toISOString(),
      });
      pendingLeftContentRef.current = null;
      scheduleSplitSave('left');
    },
    [scheduleSplitSave],
  );

  const handleLeftNoteTitleChange = useCallback(
    (newTitle: string) => {
      const prev = useSplitEditorStore.getState().leftNote;
      if (!prev) return;

      const pendingContent = pendingLeftContentRef.current;
      isLeftModified.current = true;

      useSplitEditorStore.getState().setLeftNote({
        ...prev,
        title: newTitle,
        ...(pendingContent !== null ? { content: pendingContent } : {}),
        modifiedTime: new Date().toISOString(),
      });

      // ノート一覧（左サイドバー）への即時反映
      useNotesStore
        .getState()
        .setNotes((prevNotes) =>
          prevNotes.map((n) =>
            n.id === prev.id ? { ...n, title: newTitle } : n,
          ),
        );

      pendingLeftContentRef.current = null;
      scheduleSplitSave('left');
    },
    [scheduleSplitSave],
  );

  const handleRightNoteLanguageChange = useCallback(
    (newLanguage: string) => {
      const prev = useSplitEditorStore.getState().rightNote;
      if (!prev) return;
      const pendingContent = pendingRightContentRef.current;
      isRightModified.current = true;
      useSplitEditorStore.getState().setRightNote({
        ...prev,
        language: newLanguage,
        ...(pendingContent !== null ? { content: pendingContent } : {}),
        modifiedTime: new Date().toISOString(),
      });
      pendingRightContentRef.current = null;
      scheduleSplitSave('right');
    },
    [scheduleSplitSave],
  );

  const handleRightNoteTitleChange = useCallback(
    (newTitle: string) => {
      const prev = useSplitEditorStore.getState().rightNote;
      if (!prev) return;

      const pendingContent = pendingRightContentRef.current;
      isRightModified.current = true;

      useSplitEditorStore.getState().setRightNote({
        ...prev,
        title: newTitle,
        ...(pendingContent !== null ? { content: pendingContent } : {}),
        modifiedTime: new Date().toISOString(),
      });

      useNotesStore
        .getState()
        .setNotes((prevNotes) =>
          prevNotes.map((n) =>
            n.id === prev.id ? { ...n, title: newTitle } : n,
          ),
        );

      pendingRightContentRef.current = null;
      scheduleSplitSave('right');
    },
    [scheduleSplitSave],
  );

  const handleLeftFileNoteContentChange = useCallback((newContent: string) => {
    const prev = useSplitEditorStore.getState().leftFileNote;
    if (!prev) return;
    useSplitEditorStore.getState().setLeftFileNote({
      ...prev,
      content: newContent,
    });
  }, []);

  const handleRightFileNoteContentChange = useCallback((newContent: string) => {
    const prev = useSplitEditorStore.getState().rightFileNote;
    if (!prev) return;
    useSplitEditorStore.getState().setRightFileNote({
      ...prev,
      content: newContent,
    });
  }, []);

  const restorePaneNotes = useCallback(
    (notes: Note[], fileNotes: FileNote[]) => {
      if (!savedState) return;
      const {
        isSplit: wasSplit,
        isMarkdownPreview: wasMdPreview,
        leftNoteId,
        leftIsFile,
        rightNoteId,
        rightIsFile,
      } = savedState;
      if (!wasSplit && !wasMdPreview) return;

      const findNote = (
        id: string | null,
        isFile: boolean,
      ): Note | FileNote | null => {
        if (!id) return null;
        if (isFile) return fileNotes.find((f) => f.id === id) ?? null;
        return notes.find((n) => n.id === id && !n.archived) ?? null;
      };

      const left = findNote(leftNoteId, leftIsFile);
      const right = findNote(rightNoteId, rightIsFile);

      const store = useSplitEditorStore.getState();
      if (wasSplit && left) {
        if ('filePath' in left) {
          store.setLeftFileNote(left as FileNote);
          setCurrentFileNote(left as FileNote);
          setCurrentNote(null);
        } else {
          store.setLeftNote(left as Note);
          setCurrentNote(left as Note);
          setCurrentFileNote(null);
        }
        if (right) {
          if ('filePath' in right) {
            store.setRightFileNote(right as FileNote);
          } else {
            store.setRightNote(right as Note);
          }
        }
      }
      // wasMdPreview: currentNote は useInitialize で設定済みなので no-op
    },
    [setCurrentNote, setCurrentFileNote],
  );

  return {
    toggleSplit,
    toggleMarkdownPreview,
    handleFocusPane,
    handleSelectNoteForPane,
    openNoteInPane,
    handleLeftNoteContentChange,
    handleRightNoteContentChange,
    handleLeftNoteTitleChange,
    handleRightNoteTitleChange,
    handleLeftNoteLanguageChange,
    handleRightNoteLanguageChange,
    handleLeftFileNoteContentChange,
    handleRightFileNoteContentChange,
    restorePaneNotes,
    saveSplitState,
    syncPaneNotes,
  };
};
