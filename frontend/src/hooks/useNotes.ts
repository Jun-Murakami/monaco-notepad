import { useState, useEffect } from 'react';
import { Note } from '../types';
import { SaveNote, ListNotes, LoadArchivedNote, DeleteNote, DestroyApp } from '../../wailsjs/go/main/App';
import * as runtime from '../../wailsjs/runtime';
import { main } from '../../wailsjs/go/models';

export const useNotes = () => {
  const [notes, setNotes] = useState<Note[]>([]);
  const [currentNote, setCurrentNote] = useState<Note | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // 初期ロードとイベントリスナーの設定
  useEffect(() => {
    const loadNotes = async () => {
      const notes = await ListNotes();
      setNotes(notes);
    };

    loadNotes();
  }, []); // 依存配列を空にして、マウント時にのみ実行

  // 自動保存の処理
  useEffect(() => {
    if (!currentNote) return;

    let isClosing = false;

    // アプリケーション終了時の保存処理
    const handleBeforeClose = async () => {
      if (isClosing) return;
      isClosing = true;

      try {
        if (currentNote?.id) {
          console.log('Saving current note:', currentNote.id);
          await SaveNote(main.Note.createFrom(currentNote));
          console.log('Note saved successfully:', currentNote.id);
        }
      } catch (error) {
        console.error('Failed to save note:', error);
      }
    };

    // BeforeCloseイベントのリスナー
    runtime.EventsOn('app:beforeclose', async () => {
      await handleBeforeClose();
      DestroyApp();
    });


    const debounce = setTimeout(() => {
      saveCurrentNote();
    }, 10000);

    return () => {
      clearTimeout(debounce);
      runtime.EventsOff('app:beforeclose');
    };
  }, [currentNote]);

  const saveCurrentNote = async () => {
    if (!currentNote?.id) return;
    try {
      setNotes((prev) => prev.map((note) => (note.id === currentNote.id ? currentNote : note)));
      await SaveNote(main.Note.createFrom(currentNote));
    } catch (error) {
      console.error('Failed to save note:', error);
    }
  };

  const handleNewNote = async () => {
    if (currentNote) await saveCurrentNote();
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

    await SaveNote(main.Note.createFrom(archivedNote));

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

  const handleNoteSelect = async (note: Note) => {
    await saveCurrentNote();
    setShowArchived(false);

    // アーカイブされたノートの場合、コンテンツを読み込む
    if (note.archived) {
      const fullNote = await LoadArchivedNote(note.id);
      if (fullNote) {
        setCurrentNote(fullNote);
        // ノートリストも更新
        setNotes((prev) =>
          prev.map((n) => (n.id === fullNote.id ? { ...n, content: fullNote.content } : n))
        );
      }
    } else {
      setCurrentNote(note);
    }
  };

  const handleUnarchiveNote = async (noteId: string) => {
    const note = notes.find((note) => note.id === noteId);
    if (!note) return;

    // アーカイブされたノートのコンテンツを読み込む
    const fullNote = await LoadArchivedNote(noteId);
    if (fullNote) {
      const unarchivedNote = { ...fullNote, archived: false };
      await SaveNote(main.Note.createFrom(unarchivedNote));
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
      return {
        ...prev,
        language: newLanguage,
        modifiedTime: new Date().toISOString(),
      };
    });
  };

  const handleContentChange = (newContent: string) => {
    setCurrentNote((prev) => {
      if (!prev) return prev;
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