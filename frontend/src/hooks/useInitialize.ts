import { useEffect } from 'react';
import * as runtime from '../../wailsjs/runtime';
import { ListNotes, NotifyFrontendReady } from '../../wailsjs/go/backend/App';
import { Note } from '../types';
import { getSupportedLanguages, LanguageInfo } from '../lib/monaco';

type InitializeProps = {
  setNotes: (notes: Note[] | ((prevNotes: Note[]) => Note[])) => void;
  handleNewNote: () => Promise<void>;
  handleNoteSelect: (note: Note, isNew?: boolean) => Promise<void>;
  setPlatform: (platform: string) => void;
  setLanguages: (languages: LanguageInfo[]) => void;
};

export const useInitialize = ({
  setNotes,
  handleNewNote,
  handleNoteSelect,
  setPlatform,
  setLanguages,
}: InitializeProps) => {
  // アプリケーションの初期化
  useEffect(() => {
    const initializeApp = async () => {
      try {
        // プラットフォームを取得
        const env = await runtime.Environment();
        setPlatform(env.platform);

        // 言語一覧を取得
        setLanguages(getSupportedLanguages());

        // ノート一覧を取得
        const notes = await ListNotes();
        if (!notes) {
          setNotes([]);
          handleNewNote();
          return;
        }
        setNotes(notes);
        const activeNotes = notes.filter((note) => !note.archived);
        if (activeNotes.length > 0) {
          handleNoteSelect(activeNotes[0]);
        } else {
          handleNewNote();
        }
      } catch (error) {
        console.error('Failed to load notes:', error);
        setNotes([]);
        handleNewNote();
      }
    };

    initializeApp();

    // バックエンドの準備完了を待ってから通知
    const unsubscribe = runtime.EventsOn('backend:ready', () => {
      NotifyFrontendReady();
    });

    return () => {
      unsubscribe();
      setLanguages([]);
    };
  }, []);

  // 外部ファイルを開くイベントリスナー
  useEffect(() => {
    const handleExternalFile = (data: { path: string; content: string }) => {
      const fileName = data.path.split(/[/\\]/).pop() || '';
      const extension = fileName.split('.').pop()?.toLowerCase() || '';
      const detectedLanguage = getSupportedLanguages().find((lang) => lang.id === extension);
      const language = typeof detectedLanguage?.id === 'string' && detectedLanguage.id !== '' ? detectedLanguage.id : 'plaintext';

      const newNote: Note = {
        id: crypto.randomUUID(),
        title: fileName.replace(/\.[^/.]+$/, ''),
        content: data.content,
        contentHeader: null,
        language,
        modifiedTime: new Date().toISOString(),
        archived: false,
      };

      setNotes((prevNotes: Note[]) => [newNote, ...prevNotes]);
      handleNoteSelect(newNote, true);
    };

    const cleanup = runtime.EventsOn('file:open-external', handleExternalFile);
    return () => cleanup();
  }, [handleNoteSelect, setNotes]);
}; 