import { useState, useEffect, useRef } from 'react';
import { Note } from '../types';
import { SaveNote, ListNotes, LoadArchivedNote, DeleteNote, DestroyApp } from '../../wailsjs/go/backend/App';
import * as runtime from '../../wailsjs/runtime';
import { backend } from '../../wailsjs/go/models';

export const useNotes = () => {
  const [notes, setNotes] = useState<Note[]>([]);
  const [currentNote, setCurrentNote] = useState<Note | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const isNoteModified = useRef(false);
  const previousContent = useRef<string>('');
  const isClosing = useRef(false);
  const currentNoteRef = useRef<Note | null>(null);

  // currentNoteの変更を追跡
  useEffect(() => {
    currentNoteRef.current = currentNote;
  }, [currentNote]);

  // 初期ロードとイベントリスナーの設定
  useEffect(() => {
    const loadNotes = async () => {
      const notes = await ListNotes();
      setNotes(notes);
    };

    loadNotes();

    // notes:reloadイベントのハンドラを登録
    runtime.EventsOn('notes:reload', async () => {
      const notes = await ListNotes();
      setNotes(notes);
    });

    // 個別のノート更新イベントのハンドラを登録
    runtime.EventsOn('note:updated', async (noteId: string) => {
      // 更新されたノートを再読み込み
      const notes = await ListNotes();
      setNotes(notes);

      // 現在表示中のノートが更新された場合、その内容も更新
      if (currentNoteRef.current?.id === noteId) {
        const updatedNote = notes.find(note => note.id === noteId);
        if (updatedNote) {
          setCurrentNote(updatedNote);
          previousContent.current = updatedNote.content || '';
          isNoteModified.current = false;
        }
      }
    });

    // BeforeCloseイベントのリスナーを一度だけ設定
    const handleBeforeClose = async () => {
      if (isClosing.current) return;
      isClosing.current = true;

      try {
        const noteToSave = currentNoteRef.current;
        if (noteToSave?.id && isNoteModified.current) {
          await SaveNote(backend.Note.createFrom(noteToSave));
        }
      } catch (error) {
      }
      DestroyApp();
    };

    runtime.EventsOn('app:beforeclose', handleBeforeClose);

    return () => {
      runtime.EventsOff('app:beforeclose');
      runtime.EventsOff('notes:reload');
      runtime.EventsOff('note:updated');
    };
  }, []);

  // 自動保存の処理
  useEffect(() => {
    if (!currentNote || !isNoteModified.current) return;

    const debounce = setTimeout(() => {
      if (isNoteModified.current) {
        saveCurrentNote();
      }
    }, 10000);

    return () => {
      clearTimeout(debounce);
    };
  }, [currentNote]);

  const saveCurrentNote = async () => {
    if (!currentNote?.id || !isNoteModified.current) return;
    try {
      setNotes((prev) => prev.map((note) => (note.id === currentNote.id ? currentNote : note)));
      await SaveNote(backend.Note.createFrom(currentNote));
      isNoteModified.current = false;
    } catch (error) {
    }
  };

  const handleNewNote = async () => {
    if (currentNote) {
      await saveCurrentNote();
    }
    const newNote: Note = {
      id: crypto.randomUUID(),
      title: '',
      content: '',
      contentHeader: null,
      language: currentNote?.language || 'plaintext',
      modifiedTime: new Date().toISOString(),
      archived: false,
    };
    setShowArchived(false);
    setNotes((prev) => [newNote, ...prev]);
    setCurrentNote(newNote);
    await SaveNote(backend.Note.createFrom(newNote));
  };

  const handleArchiveNote = async (noteId: string) => {
    const note = notes.find((note) => note.id === noteId);
    if (!note) return;

    // コンテンツヘッダーを生成
    const content = note.content || '';
    const contentHeader = content
      .split('\n')
      .filter(line => line.trim().length > 0)
      .slice(0, 3)  // 最初の3行を取得
      .join('\n')
      .slice(0, 200);  // 最大200文字まで

    const archivedNote = {
      ...note,
      archived: true,
      content: content,
      contentHeader,
    };

    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? archivedNote : n))
    );
    await SaveNote(backend.Note.createFrom(archivedNote));

    if (currentNote?.id === noteId) {
      const activeNotes = notes.filter((note) => !note.archived && note.id !== noteId);
      if (activeNotes.length > 0) {
        setCurrentNote(activeNotes[0]);
      } else {
        const emptyNote: Note = {
          id: crypto.randomUUID(),
          title: '',
          content: '',
          contentHeader: null,
          language: currentNote?.language || 'plaintext',
          modifiedTime: new Date().toISOString(),
          archived: false,
        };
        setCurrentNote(emptyNote);
      }
    }
  };

  const handleNoteSelect = async (note: Note, isNew: boolean = false) => {
    if (currentNote?.id && isNoteModified.current) {
      await saveCurrentNote();
    }
    setShowArchived(false);

    if (isNew) {
      await SaveNote(backend.Note.createFrom(note));
    }
    // アーカイブされたノートの場合、コンテンツを読み込む
    if (note.archived) {
      const fullNote = await LoadArchivedNote(note.id);
      if (fullNote) {
        previousContent.current = fullNote.content || '';
        setCurrentNote(fullNote);
        // ノートリストも更新
        setNotes((prev) =>
          prev.map((n) => (n.id === fullNote.id ? { ...n, content: fullNote.content } : n))
        );
      }
    } else {
      previousContent.current = note.content || '';
      setCurrentNote(note);
    }
    isNoteModified.current = false;
  };

  const handleUnarchiveNote = async (noteId: string) => {
    const note = notes.find((note) => note.id === noteId);
    if (!note) return;

    // アーカイブされたノートのコンテンツを読み込む
    const fullNote = await LoadArchivedNote(noteId);
    if (fullNote) {
      const unarchivedNote = { ...fullNote, archived: false };
      await SaveNote(backend.Note.createFrom(unarchivedNote));
      setNotes((prev) =>
        prev.map((note) => (note.id === noteId ? unarchivedNote : note))
      );
    }
  };

  const handleDeleteNote = async (noteId: string) => {
    await DeleteNote(noteId);
    setNotes((prev) => prev.filter((note) => note.id !== noteId));
    if (currentNote?.id === noteId) {
      const activeNotes = notes.filter((note) => !note.archived && note.id !== noteId);
      if (activeNotes.length > 0) {
        setCurrentNote(activeNotes[0]);
      } else {
        const emptyNote: Note = {
          id: crypto.randomUUID(),
          title: '',
          content: '',
          contentHeader: null,
          language: currentNote?.language || 'plaintext',
          modifiedTime: new Date().toISOString(),
          archived: false,
        };
        setCurrentNote(emptyNote);
      }
    }
  };

  const handleTitleChange = (newTitle: string) => {
    setCurrentNote((prev) => {
      if (!prev) return prev;
      isNoteModified.current = true;
      return {
        ...prev,
        title: newTitle,
        modifiedTime: new Date().toISOString(),
      };
    });
  };

  const handleLanguageChange = (newLanguage: string) => {
    setCurrentNote((prev) => {
      if (!prev) return prev;
      isNoteModified.current = true;
      return {
        ...prev,
        language: newLanguage,
      };
    });
  };

  const handleContentChange = (newContent: string) => {
    setCurrentNote((prev) => {
      if (!prev) return prev;

      // 前回の内容と同じ場合は変更なしとする
      if (newContent === previousContent.current) {
        return prev;
      }

      previousContent.current = newContent;
      isNoteModified.current = true;
      return {
        ...prev,
        content: newContent,
        modifiedTime: new Date().toISOString(),
      };
    });
  };

  return {
    notes,
    setNotes,
    currentNote,
    showArchived,
    setShowArchived,
    saveCurrentNote,
    handleNewNote,
    handleArchiveNote,
    handleNoteSelect,
    handleUnarchiveNote,
    handleDeleteNote,
    handleTitleChange,
    handleLanguageChange,
    handleContentChange,
  };
}; 