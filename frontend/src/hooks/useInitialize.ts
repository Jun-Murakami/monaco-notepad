import { useEffect, useState } from 'react';
import { ListNotes, NotifyFrontendReady, LoadFileNotes } from '../../wailsjs/go/backend/App';
import { getSupportedLanguages, LanguageInfo } from '../lib/monaco';
import * as runtime from '../../wailsjs/runtime';
import { Note, FileNote } from '../types';

export const useInitialize = (
  setNotes: (notes: Note[]) => void,
  setFileNotes: (files: FileNote[]) => void,
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

        // 言語一覧を取得
        setLanguages(getSupportedLanguages());

        // ファイルノート一覧を取得
        const lists = await LoadFileNotes();
        if (lists) {
          const loadedFileNotes = lists.map(file => ({
            id: file.id,
            filePath: file.filePath,
            fileName: file.fileName,
            content: file.content,
            originalContent: file.content,
            language: file.language,
            modifiedTime: file.modifiedTime.toString(),
          }));
          setFileNotes(loadedFileNotes);
        }

        // ノート一覧を取得
        const notes = await ListNotes();
        if (!notes) {
          setNotes([]);
          handleNewNote();
          return;
        }
        const parsedNotes = notes.map(note => ({
          ...note,
          modifiedTime: note.modifiedTime.toString(),
        }));
        setNotes(parsedNotes);
        const activeNotes = parsedNotes.filter((note) => !note.archived);
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