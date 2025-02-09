import { getLanguageByExtension, getExtensionByLanguage } from '../lib/monaco';
import { SelectFile, OpenFile, SaveFile, SelectSaveFileUri } from '../../wailsjs/go/backend/App';
import { Note } from '../types';
import { isBinaryFile } from '../utils/fileUtils';

// ファイル操作に関する純粋な関数を提供するフック
export const useFileOperations = (
  notes: Note[],
  currentNote: Note | null,
  handleNoteSelect: (note: Note, isNew: boolean) => Promise<void>,
  setNotes: (notes: Note[]) => void,
  showMessage: (title: string, message: string, isTwoButton?: boolean) => Promise<boolean>,
) => {
  // 新しいノートを作成する共通関数
  const createNewNote = (content: string, filePath: string) => {
    const extension = filePath.split('.').pop()?.toLowerCase() || '';
    const detectedLanguage = getLanguageByExtension('.' + extension);
    const language = typeof detectedLanguage?.id === 'string' && detectedLanguage.id !== '' ? detectedLanguage.id : 'plaintext';
    const fileName = filePath.split(/[/\\]/).pop() || '';

    return {
      id: crypto.randomUUID(),
      title: fileName.replace(/\.[^/.]+$/, ''),
      content,
      contentHeader: null,
      language,
      modifiedTime: new Date().toISOString(),
      archived: false,
    };
  };

  // ファイルを開く
  const handleOpenFile = async () => {
    try {
      const filePath = await SelectFile();
      if (!filePath || Array.isArray(filePath)) return;

      const content = await OpenFile(filePath);
      if (typeof content !== 'string') return;

      if (isBinaryFile(content)) {
        showMessage('Error', 'Failed to open the file. Please check the file format.');
        return;
      }

      const newNote = createNewNote(content, filePath);
      setNotes([newNote, ...notes]);
      await handleNoteSelect(newNote, true);
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  // ファイルを保存する
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

  // ファイルをドラッグアンドドロップする
  const handleFileDrop = async (_x: number, _y: number, paths: string[]) => {
    if (paths.length > 0) {
      try {
        const filePath = paths[0];
        const content = await OpenFile(filePath);
        if (typeof content !== 'string') return;

        if (isBinaryFile(content)) {
          showMessage('Error', 'Failed to open the dropped file. Please check the file format.');
          return;
        }

        const newNote = createNewNote(content, filePath);
        setNotes([newNote, ...notes]);
        await handleNoteSelect(newNote, true);
      } catch (error) {
        console.error('File drop error:', error);
        showMessage('Error', 'ファイルのオープンに失敗しました');
      }
    }
  };

  return {
    handleOpenFile,
    handleSaveFile,
    handleFileDrop,
  };
}; 