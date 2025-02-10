import { useEffect, useState } from 'react';
import { ListNotes, NotifyFrontendReady } from '../../wailsjs/go/backend/App';
import { getSupportedLanguages, LanguageInfo } from '../lib/monaco';
import * as runtime from '../../wailsjs/runtime';
import { Note } from '../types';
import type { editor } from 'monaco-editor';

export const useInitialize = (
  setNotes: (notes: Note[]) => void,
  handleNewNote: () => void,
  handleNoteSelect: (note: Note) => void,
) => {
  const [languages, setLanguages] = useState<LanguageInfo[]>([]);
  const [platform, setPlatform] = useState<string>('');

  useEffect(() => {
    const asyncFunc = async () => {
      try {
        // プラットフォームを取得
        const env = await runtime.Environment();
        setPlatform(env.platform);

        // コンポーネントのマウント時に言語一覧を取得
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
    asyncFunc();

    // バックエンドの準備完了を待ってから通知
    const unsubscribe = runtime.EventsOn('backend:ready', () => {
      NotifyFrontendReady();
    });

    return () => {
      unsubscribe();
      setLanguages([]);
    };
  }, []);

  return {
    languages,
    platform,
  };
}; 