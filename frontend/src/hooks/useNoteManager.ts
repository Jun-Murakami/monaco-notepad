import { useState, useEffect, useRef } from 'react';
import { Note, MemoryNote, FileNote } from '../types';
import { SaveNote, ListNotes, LoadArchivedNote, DeleteNote, SaveFileNotes, CheckFileModified, LoadFileNotes, GetModifiedTime, OpenFile } from '../../wailsjs/go/backend/App';
import { backend } from '../../wailsjs/go/models';
import * as runtime from '../../wailsjs/runtime';

interface UseNoteManagerProps {
  showMessage: (title: string, message: string, isTwoButton?: boolean, button1?: string, button2?: string) => Promise<boolean>;
}

export const useNoteManager = ({ showMessage }: UseNoteManagerProps) => {
  // 状態管理
  const [notes, setNotes] = useState<Note[]>([]);
  const [currentNote, setCurrentNote] = useState<Note | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // 変更状態の追跡用ref
  const isContentModified = useRef(false);
  const previousContent = useRef<string>('');
  const isClosing = useRef(false);
  const currentNoteRef = useRef<Note | null>(null);

  // currentNoteの参照を最新に保つ
  useEffect(() => {
    currentNoteRef.current = currentNote;
  }, [currentNote]);

  // 型ガード関数
  const isMemoryNote = (note: Note): note is MemoryNote => note.type === 'memory';
  const isFileNote = (note: Note): note is FileNote => note.type === 'file';

  // 新規メモリノート作成
  const createNewNote = async () => {
    const newNote: MemoryNote = {
      type: 'memory',
      id: crypto.randomUUID(),
      title: '',
      content: '',
      contentHeader: null,
      language: currentNote?.language || 'plaintext',
      modifiedTime: new Date().toISOString(),
      archived: false,
    };

    setShowArchived(false);
    setNotes(prev => [newNote, ...prev]);
    setCurrentNote(newNote);
    await SaveNote(backend.Note.createFrom(newNote), "create");
    return newNote;
  };

  // ファイルの変更をチェックして必要に応じてリロード
  const checkFileModification = async (note: FileNote) => {
    try {
      const isModified = await CheckFileModified(note.filePath, note.modifiedTime);
      if (isModified) {
        const shouldReload = await showMessage(
          'File has been modified outside of the app',
          'Do you want to reload the file?',
          true,
          'Reload',
          'Keep current state'
        );

        if (shouldReload) {
          const reloadedContent = await OpenFile(note.filePath);
          const modifiedTime = await GetModifiedTime(note.filePath);
          const updatedNote: FileNote = {
            ...note,
            content: reloadedContent,
            originalContent: reloadedContent,
            modifiedTime: modifiedTime.toString(),
          };
          // ノートリストも更新
          setNotes(prev => prev.map(n => n.id === note.id ? updatedNote : n));
          previousContent.current = updatedNote.content;
          setCurrentNote(updatedNote);
          isContentModified.current = false;
        }
      }
    } catch (error) {
      console.error('Failed to check file modification:', error);
    }
  };

  // ノート選択
  const handleNoteSelect = async (note: Note) => {
    if (currentNote?.id && isContentModified.current) {
      if (isFileNote(currentNote)) {
        await SaveFileNotes([backend.FileNote.createFrom(currentNote)]);
      } else {
        await SaveNote(backend.Note.createFrom(currentNote), "update");
      }
      setNotes(prev => prev.map(n => n.id === currentNote.id ? note : n));
    }
    setShowArchived(false);

    if (isMemoryNote(note) && note.archived) {
      const fullNote = await LoadArchivedNote(note.id);
      if (fullNote) {
        note = {
          ...note,
          content: fullNote.content,
        };
      }
    }

    previousContent.current = note.content;
    setCurrentNote(note);
    isContentModified.current = false;

    if (isFileNote(note)) {
      await checkFileModification(note);
    }
  };

  // ノートの内容変更
  const handleNoteContentChange = (newContent: string) => {
    setCurrentNote(prev => {
      if (!prev) return prev;

      if (newContent === previousContent.current) {
        return prev;
      }

      previousContent.current = newContent;
      isContentModified.current = true;

      return {
        ...prev,
        content: newContent,
        modifiedTime: prev?.type === 'memory' ? new Date().toISOString() : prev?.modifiedTime,
      };
    });
  };

  // メモリノート固有の操作
  const handleArchiveNote = async (noteId: string) => {
    const note = notes.find(n => n.id === noteId);
    if (!note || !isMemoryNote(note)) return;

    const content = note.content || '';
    const contentHeader = content
      .split('\n')
      .filter(line => line.trim().length > 0)
      .slice(0, 3)
      .join('\n')
      .slice(0, 200);

    const archivedNote: MemoryNote = {
      ...note,
      archived: true,
      contentHeader,
    };

    await SaveNote(backend.Note.createFrom(archivedNote), "update");
    setNotes(prev => prev.map(n => n.id === noteId ? archivedNote : n));

    if (currentNote?.id === noteId) {
      const activeNotes = notes.filter(n => isMemoryNote(n) && !n.archived);
      if (activeNotes.length > 0) {
        setCurrentNote(activeNotes[0]);
      } else {
        await createNewNote();
      }
    }
  };

  const handleUnarchiveNote = async (noteId: string) => {
    const note = notes.find(n => n.id === noteId);
    if (!note || !isMemoryNote(note)) return;

    const fullNote = await LoadArchivedNote(noteId);
    if (fullNote) {
      const unarchivedNote: MemoryNote = {
        ...note,
        archived: false,
        content: fullNote.content,
      };
      await SaveNote(backend.Note.createFrom(unarchivedNote), "update");
      setNotes(prev => prev.map(n => n.id === noteId ? unarchivedNote : n));
    }
  };

  // ファイルノート固有の操作
  const handleCloseFile = async (note: FileNote) => {
    if (note.content !== note.originalContent) {
      const shouldClose = await showMessage(
        'File has unsaved changes',
        'Do you want to discard the changes and close the file?',
        true,
        'Discard',
        'Cancel'
      );

      if (!shouldClose) return;
    }

    setNotes(prev => prev.filter(n => n.id !== note.id));
    if (currentNote?.id === note.id) {
      const remainingNotes = notes.filter(n => n.id !== note.id);
      setCurrentNote(remainingNotes[0] || null);
    }
  };

  const isNoteModified = (noteId: string) => {
    const note = notes.find(n => n.id === noteId);
    if (!note) return false;

    return isFileNote(note)
      ? note.content !== note.originalContent
      : isContentModified.current && currentNote?.id === noteId;
  };

  // 共通の操作
  const handleDeleteNote = async (noteId: string) => {
    const note = notes.find(n => n.id === noteId);
    if (!note) return;

    if (isMemoryNote(note)) {
      await DeleteNote(noteId);
    }

    setNotes(prev => prev.filter(n => n.id !== noteId));
    if (currentNote?.id === noteId) {
      const remainingNotes = notes.filter(n =>
        n.id !== noteId && (showArchived ? true : !isMemoryNote(n) || !n.archived)
      );
      setCurrentNote(remainingNotes[0] || null);
    }
  };

  const handleDeleteAllArchivedNotes = async () => {
    const archivedNotes = notes.filter(note => isMemoryNote(note) && note.archived);
    for (const note of archivedNotes) {
      await handleDeleteNote(note.id);
    }
  };

  const handleTitleChange = (newTitle: string) => {
    setCurrentNote(prev => {
      if (!prev || !isMemoryNote(prev)) return prev;
      isContentModified.current = true;
      return {
        ...prev,
        title: newTitle,
        modifiedTime: new Date().toISOString(),
      };
    });
  };

  const handleLanguageChange = (newLanguage: string) => {
    setCurrentNote(prev => {
      if (!prev) return prev;
      isContentModified.current = true;
      return {
        ...prev,
        language: newLanguage,
      };
    });
  };

  // 初期化とイベントリスナー
  useEffect(() => {
    const loadNotes = async () => {
      const memoryNotes = await ListNotes();
      const fileNotes = await LoadFileNotes();
      const mergedNotes = [
        ...memoryNotes.map(note => ({ ...note, type: 'memory' as const, modifiedTime: note.modifiedTime.toString() })),
        ...fileNotes.map(note => ({ ...note, type: 'file' as const, modifiedTime: note.modifiedTime.toString() }))
      ];
      setNotes(mergedNotes);
    };

    loadNotes();

    // イベントリスナーの設定
    runtime.EventsOn('notes:reload', loadNotes);

    const handleBeforeClose = async () => {
      if (isClosing.current) return;
      isClosing.current = true;

      try {
        if (currentNoteRef.current && isContentModified.current) {
          if (isFileNote(currentNoteRef.current)) {
            await SaveFileNotes([backend.FileNote.createFrom(currentNoteRef.current)]);
          } else {
            await SaveNote(backend.Note.createFrom(currentNoteRef.current), "update");
          }
        }
      } catch (error) {
        console.error('Failed to save note before close:', error);
      }
    };

    runtime.EventsOn('app:beforeclose', handleBeforeClose);

    return () => {
      runtime.EventsOff('app:beforeclose');
      runtime.EventsOff('notes:reload');
    };
  }, []);

  // 自動保存とフォーカスイベントのリスナー
  useEffect(() => {
    // 自動保存の設定
    let debounceTimer: NodeJS.Timeout | null = null;
    if (currentNote) {
      debounceTimer = setTimeout(async () => {
        if (isContentModified.current) {
          console.log('saveCurrentNote', currentNote);
          if (isFileNote(currentNote)) {
            await SaveFileNotes([backend.FileNote.createFrom(currentNote)]);
          } else {
            await SaveNote(backend.Note.createFrom(currentNote), "update");
          }
        }
      }, 5000);
    }

    // フォーカスイベントのリスナー
    const handleFocus = async () => {
      if (currentNote && isFileNote(currentNote)) {
        console.log('focus', currentNote);
        await checkFileModification(currentNote);
      }
    };

    window.addEventListener('focus', handleFocus);

    return () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      window.removeEventListener('focus', handleFocus);
    };
  }, [currentNote, isContentModified, checkFileModification]);

  return {
    notes,
    setNotes,
    currentNote,
    showArchived,
    setShowArchived,
    isNoteModified,
    createNewNote,
    handleNoteSelect,
    handleArchiveNote,
    handleUnarchiveNote,
    handleDeleteNote,
    handleCloseFile,
    handleTitleChange,
    handleLanguageChange,
    handleNoteContentChange,
    handleDeleteAllArchivedNotes,
  };
}; 