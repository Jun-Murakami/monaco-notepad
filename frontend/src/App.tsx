import { useState, useEffect } from 'react';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { Editor } from './components/Editor';
import { Box, Divider } from '@mui/material';
import { AppBar } from './components/AppBar';
import { NoteList } from './components/NoteList';
import { lightTheme, darkTheme } from './lib/theme';
import { getSupportedLanguages, LanguageInfo } from './lib/monaco';
import { SettingsDialog } from './components/SettingsDialog';
import { EditorSettings } from './types';
import { LoadSettings, ListNotes } from '../wailsjs/go/main/App';
import { ArchivedNoteList } from './components/ArchivedNoteList';
import { useNotes } from './hooks/useNotes';
import { useEditorSettings } from './hooks/useEditorSettings';
import { useFileOperations } from './hooks/useFileOperations';
import { EventsOn } from '../wailsjs/runtime/runtime';

function App() {
  const { isSettingsOpen, setIsSettingsOpen, editorSettings, setEditorSettings, handleSettingsChange } = useEditorSettings();

  const {
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
  } = useNotes();

  const { handleOpenFile, handleSaveFile } = useFileOperations(notes, currentNote, handleNoteSelect, setNotes, saveCurrentNote);

  const [languages, setLanguages] = useState<LanguageInfo[]>([]);

  useEffect(() => {
    // コンポーネントのマウント時に言語一覧を取得
    setLanguages(getSupportedLanguages());
    const asyncFunc = async () => {
      // ノート一覧を取得
      const notes = await ListNotes();
      setNotes(notes);
      const activeNotes = notes.filter((note) => !note.archived);
      if (activeNotes.length > 0) {
        handleNoteSelect(activeNotes[0]);
      } else {
        handleNewNote();
      }
    };
    asyncFunc();

    return () => {
      setLanguages([]);
    };
  }, []);

  // アプリのバックグラウンド化と終了時のイベントリスナーを設定
  useEffect(() => {
    // ウィンドウがバックグラウンドになったときの処理
    const unsubscribeBlur = EventsOn('wails:window:blur', () => {
      if (currentNote) {
        saveCurrentNote();
      }
    });

    // アプリケーションが終了する前の処理
    const unsubscribeClose = EventsOn('wails:window:close', () => {
      if (currentNote) {
        saveCurrentNote();
      }
    });

    return () => {
      // クリーンアップ関数
      unsubscribeBlur();
      unsubscribeClose();
    };
  }, [currentNote, saveCurrentNote]);

  return (
    <ThemeProvider theme={editorSettings.isDarkMode ? darkTheme : lightTheme}>
      <CssBaseline />
      <Box sx={{ width: '100vw', height: '100vh', position: 'relative' }} component='main'>
        <AppBar
          currentNote={currentNote}
          languages={languages}
          onTitleChange={handleTitleChange}
          onLanguageChange={handleLanguageChange}
          onSettings={() => setIsSettingsOpen(true)}
          onNew={handleNewNote}
          onOpen={handleOpenFile}
          onSave={handleSaveFile}
        />
        <Divider />
        <Box
          aria-label='Note List'
          sx={{
            position: 'absolute',
            top: 57,
            left: 0,
            borderRight: 1,
            borderColor: 'divider',
            width: 242,
            height: 'calc(100% - 57px)',
          }}
        >
          <NoteList
            notes={notes}
            currentNote={currentNote}
            onNoteSelect={handleNoteSelect}
            onArchive={handleArchiveNote}
            onShowArchived={() => setShowArchived(true)}
            onReorder={setNotes}
          />
        </Box>
        <Box sx={{ position: 'absolute', top: 57, left: 242, width: 'calc(100% - 242px)', height: 'calc(100% - 57px)' }}>
          {showArchived ? (
            <ArchivedNoteList
              notes={notes}
              onUnarchive={handleUnarchiveNote}
              onDelete={handleDeleteNote}
              onClose={() => setShowArchived(false)}
            />
          ) : (
            <Editor
              value={currentNote?.content || ''}
              onChange={handleContentChange}
              language={currentNote?.language || 'plaintext'}
              settings={editorSettings}
              currentNote={currentNote}
            />
          )}
        </Box>
      </Box>

      <SettingsDialog
        open={isSettingsOpen}
        settings={editorSettings}
        onClose={() => setIsSettingsOpen(false)}
        onChange={setEditorSettings}
        onSave={handleSettingsChange}
      />
    </ThemeProvider>
  );
}

export default App;
