import { useCallback, useEffect, useRef, useState } from 'react';
import { SaveNote } from '../../wailsjs/go/backend/App';
import { backend } from '../../wailsjs/go/models';
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

interface UseSplitEditorProps {
  currentNote: Note | null;
  currentFileNote: FileNote | null;
  setCurrentNote: (note: Note | null) => void;
  setCurrentFileNote: (note: FileNote | null) => void;
  setNotes: React.Dispatch<React.SetStateAction<Note[]>>;
}

export const useSplitEditor = ({
  currentNote,
  currentFileNote,
  setCurrentNote,
  setCurrentFileNote,
  setNotes,
}: UseSplitEditorProps) => {
  const [isSplit, setIsSplit] = useState(savedState?.isSplit ?? false);
  const [isMarkdownPreview, setIsMarkdownPreview] = useState(
    savedState?.isMarkdownPreview ?? false,
  );
  const [focusedPane, setFocusedPane] = useState<EditorPane>('left');
  const focusedPaneRef = useRef<EditorPane>('left');

  const [leftNote, setLeftNote] = useState<Note | null>(null);
  const [leftFileNote, setLeftFileNote] = useState<FileNote | null>(null);
  const [rightNote, setRightNote] = useState<Note | null>(null);
  const [rightFileNote, setRightFileNote] = useState<FileNote | null>(null);

  const updateFocusedPane = useCallback((pane: EditorPane) => {
    focusedPaneRef.current = pane;
    setFocusedPane(pane);
  }, []);

  const isSplitRef = useRef(isSplit);
  isSplitRef.current = isSplit;
  const isMarkdownPreviewRef = useRef(isMarkdownPreview);
  isMarkdownPreviewRef.current = isMarkdownPreview;

  const leftNoteRef = useRef<Note | null>(null);
  const leftFileNoteRef = useRef<FileNote | null>(null);
  const rightNoteRef = useRef<Note | null>(null);
  const rightFileNoteRef = useRef<FileNote | null>(null);
  leftNoteRef.current = leftNote;
  leftFileNoteRef.current = leftFileNote;
  rightNoteRef.current = rightNote;
  rightFileNoteRef.current = rightFileNote;

  // Debounce refs for split editor content changes
  const isLeftModified = useRef(false);
  const isRightModified = useRef(false);
  const leftDebounceTimer = useRef<NodeJS.Timeout | null>(null);
  const rightDebounceTimer = useRef<NodeJS.Timeout | null>(null);
  const pendingLeftContentRef = useRef<string | null>(null);
  const pendingRightContentRef = useRef<string | null>(null);

  // refから現在の状態を読み取ってlocalStorageに保存（ハンドラから直接呼び出す）
  const saveSplitState = useCallback(() => {
    const state: SplitEditorStorage = {
      isSplit: isSplitRef.current,
      isMarkdownPreview: isMarkdownPreviewRef.current,
      leftNoteId:
        leftNoteRef.current?.id ?? leftFileNoteRef.current?.id ?? null,
      leftIsFile: leftFileNoteRef.current !== null,
      rightNoteId:
        rightNoteRef.current?.id ?? rightFileNoteRef.current?.id ?? null,
      rightIsFile: rightFileNoteRef.current !== null,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, []);

  const saveAndSyncNote = useCallback(
    (
      noteRef: React.RefObject<Note | null>,
      modified: React.RefObject<boolean>,
      pendingContent: React.RefObject<string | null>,
    ) => {
      if (modified.current && noteRef.current) {
        const noteToSave =
          pendingContent.current !== null
            ? { ...noteRef.current, content: pendingContent.current }
            : noteRef.current;
        setNotes((prev) =>
          prev.map((n) => (n.id === noteToSave.id ? noteToSave : n)),
        );
        SaveNote(backend.Note.createFrom(noteToSave), 'update').catch(
          console.error,
        );
        modified.current = false;
        pendingContent.current = null;
      }
    },
    [setNotes],
  );

  const flushPaneSave = useCallback(
    (pane: 'left' | 'right') => {
      const timer = pane === 'left' ? leftDebounceTimer : rightDebounceTimer;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      saveAndSyncNote(
        pane === 'left' ? leftNoteRef : rightNoteRef,
        pane === 'left' ? isLeftModified : isRightModified,
        pane === 'left' ? pendingLeftContentRef : pendingRightContentRef,
      );
    },
    [saveAndSyncNote],
  );

  const scheduleSplitSave = useCallback(
    (pane: 'left' | 'right') => {
      const timer = pane === 'left' ? leftDebounceTimer : rightDebounceTimer;
      const modified = pane === 'left' ? isLeftModified : isRightModified;
      const noteRef = pane === 'left' ? leftNoteRef : rightNoteRef;
      const pendingContent =
        pane === 'left' ? pendingLeftContentRef : pendingRightContentRef;

      if (timer.current) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => {
        saveAndSyncNote(noteRef, modified, pendingContent);
      }, 3000);
    },
    [saveAndSyncNote],
  );

  const handleFocusPane = useCallback(
    (pane: EditorPane) => {
      updateFocusedPane(pane);
      if (!isSplitRef.current) return;
      if (pane === 'left') {
        setCurrentNote(leftNote);
        setCurrentFileNote(leftFileNote);
      } else {
        setCurrentNote(rightNote);
        setCurrentFileNote(rightFileNote);
      }
    },
    [
      updateFocusedPane,
      leftNote,
      leftFileNote,
      rightNote,
      rightFileNote,
      setCurrentNote,
      setCurrentFileNote,
    ],
  );

  const toggleSplit = useCallback(
    (rightPaneNote?: Note | FileNote) => {
      const wasSplit = isSplitRef.current;
      if (wasSplit) {
        flushPaneSave('left');
        flushPaneSave('right');
      }
      setIsMarkdownPreview(false);
      isMarkdownPreviewRef.current = false;

      if (!wasSplit) {
        setLeftNote(currentNote);
        setLeftFileNote(currentFileNote);
        leftNoteRef.current = currentNote;
        leftFileNoteRef.current = currentFileNote;
        if (rightPaneNote) {
          const isFile = 'filePath' in rightPaneNote;
          if (isFile) {
            setRightFileNote(rightPaneNote as FileNote);
            rightFileNoteRef.current = rightPaneNote as FileNote;
            rightNoteRef.current = null;
          } else {
            setRightNote(rightPaneNote as Note);
            rightNoteRef.current = rightPaneNote as Note;
            rightFileNoteRef.current = null;
          }
        }
        updateFocusedPane('left');
        setIsSplit(true);
        isSplitRef.current = true;
      } else {
        setCurrentNote(leftNote);
        setCurrentFileNote(leftFileNote);
        setRightNote(null);
        setRightFileNote(null);
        setLeftNote(null);
        setLeftFileNote(null);
        rightNoteRef.current = null;
        rightFileNoteRef.current = null;
        leftNoteRef.current = null;
        leftFileNoteRef.current = null;
        updateFocusedPane('left');
        setIsSplit(false);
        isSplitRef.current = false;
      }
      saveSplitState();
    },
    [
      updateFocusedPane,
      currentNote,
      currentFileNote,
      leftNote,
      leftFileNote,
      setCurrentNote,
      setCurrentFileNote,
      saveSplitState,
      flushPaneSave,
    ],
  );

  const toggleMarkdownPreview = useCallback(() => {
    if (isSplitRef.current) {
      flushPaneSave('left');
      flushPaneSave('right');
      setCurrentNote(leftNote);
      setCurrentFileNote(leftFileNote);
      setRightNote(null);
      setRightFileNote(null);
      setLeftNote(null);
      setLeftFileNote(null);
      rightNoteRef.current = null;
      rightFileNoteRef.current = null;
      leftNoteRef.current = null;
      leftFileNoteRef.current = null;
      setIsSplit(false);
      isSplitRef.current = false;
    }
    const newMdPreview = !isMarkdownPreviewRef.current;
    setIsMarkdownPreview(newMdPreview);
    isMarkdownPreviewRef.current = newMdPreview;
    updateFocusedPane('left');
    saveSplitState();
  }, [
    leftNote,
    leftFileNote,
    setCurrentNote,
    setCurrentFileNote,
    updateFocusedPane,
    saveSplitState,
    flushPaneSave,
  ]);

  const handleSelectNoteForPane = useCallback(
    async (note: Note | FileNote) => {
      const isFile = 'filePath' in note;
      const pane = focusedPaneRef.current;

      flushPaneSave(pane);

      const otherNoteId =
        pane === 'left'
          ? (rightNoteRef.current?.id ?? rightFileNoteRef.current?.id)
          : (leftNoteRef.current?.id ?? leftFileNoteRef.current?.id);
      if (otherNoteId === note.id) {
        updateFocusedPane(pane === 'left' ? 'right' : 'left');
        setCurrentNote(isFile ? null : (note as Note));
        setCurrentFileNote(isFile ? (note as FileNote) : null);
        return;
      }

      if (pane === 'left') {
        if (isFile) {
          setLeftFileNote(note as FileNote);
          setLeftNote(null);
          leftFileNoteRef.current = note as FileNote;
          leftNoteRef.current = null;
          setCurrentFileNote(note as FileNote);
          setCurrentNote(null);
        } else {
          setLeftNote(note as Note);
          setLeftFileNote(null);
          leftNoteRef.current = note as Note;
          leftFileNoteRef.current = null;
          setCurrentNote(note as Note);
          setCurrentFileNote(null);
        }
      } else {
        if (isFile) {
          setRightFileNote(note as FileNote);
          setRightNote(null);
          rightFileNoteRef.current = note as FileNote;
          rightNoteRef.current = null;
          setCurrentFileNote(note as FileNote);
          setCurrentNote(null);
        } else {
          setRightNote(note as Note);
          setRightFileNote(null);
          rightNoteRef.current = note as Note;
          rightFileNoteRef.current = null;
          setCurrentNote(note as Note);
          setCurrentFileNote(null);
        }
      }
      saveSplitState();
    },
    [
      setCurrentNote,
      setCurrentFileNote,
      updateFocusedPane,
      saveSplitState,
      flushPaneSave,
    ],
  );

  const setPaneNote = useCallback((pane: EditorPane, note: Note | FileNote) => {
    const isFile = 'filePath' in note;
    if (pane === 'left') {
      if (isFile) {
        setLeftFileNote(note as FileNote);
        setLeftNote(null);
        leftFileNoteRef.current = note as FileNote;
        leftNoteRef.current = null;
      } else {
        setLeftNote(note as Note);
        setLeftFileNote(null);
        leftNoteRef.current = note as Note;
        leftFileNoteRef.current = null;
      }
    } else {
      if (isFile) {
        setRightFileNote(note as FileNote);
        setRightNote(null);
        rightFileNoteRef.current = note as FileNote;
        rightNoteRef.current = null;
      } else {
        setRightNote(note as Note);
        setRightFileNote(null);
        rightNoteRef.current = note as Note;
        rightFileNoteRef.current = null;
      }
    }
  }, []);

  // 指定ペインにノートを開く（コンテキストメニュー用）
  // fallbackNote: 反対ペインが同じノートになる場合に代わりに読み込むノート
  const openNoteInPane = useCallback(
    (
      note: Note | FileNote,
      targetPane: EditorPane,
      fallbackNote?: Note | FileNote,
    ) => {
      const isFile = 'filePath' in note;
      const wasSplit = isSplitRef.current;
      const otherPane: EditorPane = targetPane === 'left' ? 'right' : 'left';

      if (wasSplit) {
        flushPaneSave(targetPane);
      }

      if (!wasSplit) {
        setIsMarkdownPreview(false);
        isMarkdownPreviewRef.current = false;

        const currentId = currentNote?.id ?? currentFileNote?.id;
        const otherNote =
          currentId === note.id && fallbackNote ? fallbackNote : null;

        setPaneNote(targetPane, note);

        if (otherNote) {
          setPaneNote(otherPane, otherNote);
        } else if (targetPane === 'left') {
          setRightNote(currentNote);
          setRightFileNote(currentFileNote);
          rightNoteRef.current = currentNote;
          rightFileNoteRef.current = currentFileNote;
        } else {
          setLeftNote(currentNote);
          setLeftFileNote(currentFileNote);
          leftNoteRef.current = currentNote;
          leftFileNoteRef.current = currentFileNote;
        }

        setCurrentNote(isFile ? null : (note as Note));
        setCurrentFileNote(isFile ? (note as FileNote) : null);
        updateFocusedPane(targetPane);
        setIsSplit(true);
        isSplitRef.current = true;
      } else {
        const otherPaneId =
          targetPane === 'left'
            ? (rightNoteRef.current?.id ?? rightFileNoteRef.current?.id)
            : (leftNoteRef.current?.id ?? leftFileNoteRef.current?.id);

        if (otherPaneId === note.id) {
          if (fallbackNote) {
            setPaneNote(otherPane, fallbackNote);
          } else {
            setPaneNote(otherPane, note);
          }
        }

        setPaneNote(targetPane, note);
        setCurrentNote(isFile ? null : (note as Note));
        setCurrentFileNote(isFile ? (note as FileNote) : null);
        updateFocusedPane(targetPane);
      }
      saveSplitState();
    },
    [
      currentNote,
      currentFileNote,
      setCurrentNote,
      setCurrentFileNote,
      updateFocusedPane,
      saveSplitState,
      setPaneNote,
      flushPaneSave,
    ],
  );

  const syncPaneNotes = useCallback(
    (newNotes: Note[], topLevelOrder: TopLevelItem[] = []) => {
      if (!isSplitRef.current) return;

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

      const setPaneNoteWithoutFile = (
        pane: 'left' | 'right',
        note: Note | null,
      ) => {
        if (pane === 'left') {
          setLeftNote(note);
          setLeftFileNote(null);
          leftNoteRef.current = note;
          leftFileNoteRef.current = null;
        } else {
          setRightNote(note);
          setRightFileNote(null);
          rightNoteRef.current = note;
          rightFileNoteRef.current = null;
        }
      };

      let changed = false;

      if (leftNoteRef.current && !isLeftModified.current) {
        const updated = activeNoteMap.get(leftNoteRef.current.id);
        if (
          updated &&
          updated.modifiedTime !== leftNoteRef.current.modifiedTime
        ) {
          setLeftNote(updated);
          leftNoteRef.current = updated;
          pendingLeftContentRef.current = null;
          changed = true;
        }
      }

      if (rightNoteRef.current && !isRightModified.current) {
        const updated = activeNoteMap.get(rightNoteRef.current.id);
        if (
          updated &&
          updated.modifiedTime !== rightNoteRef.current.modifiedTime
        ) {
          setRightNote(updated);
          rightNoteRef.current = updated;
          pendingRightContentRef.current = null;
          changed = true;
        }
      }

      const leftIsMissingOrArchived =
        !!leftNoteRef.current && !activeNoteMap.has(leftNoteRef.current.id);
      const rightIsMissingOrArchived =
        !!rightNoteRef.current && !activeNoteMap.has(rightNoteRef.current.id);

      const usedNoteIDs = new Set<string>();
      if (leftNoteRef.current && !leftIsMissingOrArchived) {
        usedNoteIDs.add(leftNoteRef.current.id);
      }
      if (rightNoteRef.current && !rightIsMissingOrArchived) {
        usedNoteIDs.add(rightNoteRef.current.id);
      }

      const pickTopUnopenedNote = (): Note | null => {
        for (const note of orderedActiveNotes) {
          if (!usedNoteIDs.has(note.id)) {
            return note;
          }
        }
        return null;
      };

      if (leftIsMissingOrArchived) {
        clearPaneDirtyState('left');
        const replacement = pickTopUnopenedNote();
        setPaneNoteWithoutFile('left', replacement);
        if (replacement) {
          usedNoteIDs.add(replacement.id);
        }
        changed = true;
      }

      if (rightIsMissingOrArchived) {
        clearPaneDirtyState('right');
        const replacement = pickTopUnopenedNote();
        setPaneNoteWithoutFile('right', replacement);
        if (replacement) {
          usedNoteIDs.add(replacement.id);
        }
        changed = true;
      }

      if (!changed) return;

      const getPaneSelection = (pane: 'left' | 'right') => {
        if (pane === 'left') {
          return {
            note: leftNoteRef.current,
            file: leftFileNoteRef.current,
          };
        }
        return {
          note: rightNoteRef.current,
          file: rightFileNoteRef.current,
        };
      };

      let targetPane: EditorPane = focusedPaneRef.current;
      let targetSelection = getPaneSelection(targetPane);
      if (!targetSelection.note && !targetSelection.file) {
        const otherPane: EditorPane = targetPane === 'left' ? 'right' : 'left';
        const otherSelection = getPaneSelection(otherPane);
        if (otherSelection.note || otherSelection.file) {
          targetPane = otherPane;
          targetSelection = otherSelection;
          updateFocusedPane(otherPane);
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
    [setCurrentNote, setCurrentFileNote, updateFocusedPane, saveSplitState],
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
      const pendingContent = pendingLeftContentRef.current;
      setLeftNote((prev) => {
        if (!prev) return prev;
        isLeftModified.current = true;
        return {
          ...prev,
          language: newLanguage,
          ...(pendingContent !== null ? { content: pendingContent } : {}),
          modifiedTime: new Date().toISOString(),
        };
      });
      pendingLeftContentRef.current = null;
      scheduleSplitSave('left');
    },
    [scheduleSplitSave],
  );

  const handleLeftNoteTitleChange = useCallback(
    (newTitle: string) => {
      const currentLeftNote = leftNoteRef.current;
      if (!currentLeftNote) return;

      const pendingContent = pendingLeftContentRef.current;

      // タイトル変更時も「左ペイン側に未保存変更がある」ことを明示的に記録する。
      // これを立てないと、他経路の同期で左ペイン内容が上書きされる可能性がある。
      isLeftModified.current = true;

      setLeftNote((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          title: newTitle,
          // タイトル変更時に未反映の本文があれば同時に保持して保存へ流す。
          ...(pendingContent !== null ? { content: pendingContent } : {}),
          modifiedTime: new Date().toISOString(),
        };
      });

      // ノート一覧（左サイドバー）へ即時反映するために notes 状態も同時更新する。
      // これをしないと入力中に一覧表示が古いまま残り、視覚的に不整合が発生しやすい。
      setNotes((prev) =>
        prev.map((n) =>
          n.id === currentLeftNote.id ? { ...n, title: newTitle } : n,
        ),
      );

      pendingLeftContentRef.current = null;
      scheduleSplitSave('left');
    },
    [scheduleSplitSave, setNotes],
  );

  const handleRightNoteLanguageChange = useCallback(
    (newLanguage: string) => {
      const pendingContent = pendingRightContentRef.current;
      setRightNote((prev) => {
        if (!prev) return prev;
        isRightModified.current = true;
        return {
          ...prev,
          language: newLanguage,
          ...(pendingContent !== null ? { content: pendingContent } : {}),
          modifiedTime: new Date().toISOString(),
        };
      });
      pendingRightContentRef.current = null;
      scheduleSplitSave('right');
    },
    [scheduleSplitSave],
  );

  const handleRightNoteTitleChange = useCallback(
    (newTitle: string) => {
      const currentRightNote = rightNoteRef.current;
      if (!currentRightNote) return;

      const pendingContent = pendingRightContentRef.current;

      // 右ペインのタイトル編集を「右ペインの変更」として確実にマーキングする。
      // これにより、左ペイン側の保存や同期イベントで右ペイン編集中データが
      // 意図せず巻き戻るのを防ぐ。
      isRightModified.current = true;

      setRightNote((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          title: newTitle,
          // タイトル入力中でも、未保存本文があれば同一ノートへ一貫して保持する。
          ...(pendingContent !== null ? { content: pendingContent } : {}),
          modifiedTime: new Date().toISOString(),
        };
      });

      // サイドバーの表示を右ペイン編集内容に追随させるため、
      // グローバル notes も rightNote の ID 限定で更新する。
      setNotes((prev) =>
        prev.map((n) =>
          n.id === currentRightNote.id ? { ...n, title: newTitle } : n,
        ),
      );

      pendingRightContentRef.current = null;
      scheduleSplitSave('right');
    },
    [scheduleSplitSave, setNotes],
  );

  const handleLeftFileNoteContentChange = useCallback((newContent: string) => {
    setLeftFileNote((prev) => {
      if (!prev) return prev;
      return { ...prev, content: newContent };
    });
  }, []);

  const handleRightFileNoteContentChange = useCallback((newContent: string) => {
    setRightFileNote((prev) => {
      if (!prev) return prev;
      return { ...prev, content: newContent };
    });
  }, []);

  const activeNote = focusedPane === 'left' ? leftNote : rightNote;
  const activeFileNote = focusedPane === 'left' ? leftFileNote : rightFileNote;

  // 右ペインのノートID（セカンダリ選択表示用）
  const secondarySelectedNoteId = isSplit
    ? (rightNote?.id ?? rightFileNote?.id ?? undefined)
    : undefined;

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

      if (wasSplit && left) {
        if ('filePath' in left) {
          setLeftFileNote(left as FileNote);
          setCurrentFileNote(left as FileNote);
          setCurrentNote(null);
        } else {
          setLeftNote(left as Note);
          setCurrentNote(left as Note);
          setCurrentFileNote(null);
        }
        if (right) {
          if ('filePath' in right) {
            setRightFileNote(right as FileNote);
          } else {
            setRightNote(right as Note);
          }
        }
      } else if (wasMdPreview) {
        // no-op: currentNote is already set by useInitialize
      }
    },
    [setCurrentNote, setCurrentFileNote],
  );

  return {
    isSplit,
    isMarkdownPreview,
    toggleSplit,
    toggleMarkdownPreview,
    focusedPane,
    updateFocusedPane,
    handleFocusPane,
    leftNote,
    setLeftNote,
    leftFileNote,
    setLeftFileNote,
    rightNote,
    setRightNote,
    rightFileNote,
    setRightFileNote,
    activeNote,
    activeFileNote,
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
    secondarySelectedNoteId,
    restorePaneNotes,
    saveSplitState,
    syncPaneNotes,
  };
};
