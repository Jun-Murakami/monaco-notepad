import { getLanguageByExtension, getExtensionByLanguage } from '../lib/monaco';
import { SelectFile, OpenFile, SaveFile, SelectSaveFileUri } from '../../wailsjs/go/backend/App';
import { Note } from '../types';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import { useEffect } from 'react';

export const useFileOperations = (
  notes: Note[],
  currentNote: Note | null,
  handleNoteSelect: (note: Note, isNew: boolean) => Promise<void>,
  setNotes: (notes: Note[]) => void,
) => {
  const handleOpenFile = async () => {
    try {
      const filePath = await SelectFile();
      if (!filePath || Array.isArray(filePath)) return;

      const content = await OpenFile(filePath);
      if (typeof content !== 'string') return;

      const extension = filePath.split('.').pop()?.toLowerCase() || '';
      const detectedLanguage = getLanguageByExtension('.' + extension);
      const language = typeof detectedLanguage?.id === 'string' && detectedLanguage.id !== '' ? detectedLanguage.id : 'plaintext';
      const fileName = filePath.split(/[/\\]/).pop() || '';

      const newNote: Note = {
        id: crypto.randomUUID(),
        title: fileName.replace(/\.[^/.]+$/, ''),
        content,
        contentHeader: null,
        language,
        modifiedTime: new Date().toISOString(),
        archived: false,
      };

      setNotes([newNote, ...notes]);
      await handleNoteSelect(newNote, true);
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  const handleSaveFile = async () => {
    try {
      if (!currentNote || !currentNote.content || currentNote.content === '') return;
      const extension = getExtensionByLanguage(currentNote.language) || 'txt';
      const filePath = await SelectSaveFileUri(currentNote.title, extension);
      if (!filePath || Array.isArray(filePath)) return;

      await SaveFile(filePath, currentNote.content);
    } catch (error) {
      console.error('Failed to save file:', error);
    }
  };

  useEffect(() => {
    const cleanup = EventsOn('file:open-external', (data: { path: string, content: string }) => {
      const fileName = data.path.split(/[/\\]/).pop() || '';
      const extension = fileName.split('.').pop()?.toLowerCase() || '';
      const detectedLanguage = getLanguageByExtension('.' + extension);
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

      setNotes([newNote, ...notes]);
      handleNoteSelect(newNote, true);
    });

    return () => cleanup();
  }, [notes, handleNoteSelect, setNotes]);

  return {
    handleOpenFile,
    handleSaveFile,
  };
}; 