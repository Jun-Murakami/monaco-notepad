import { useState, useEffect } from 'react';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { Editor } from './components/Editor';
import { Box, Divider } from '@mui/material';
import { AppBar } from './components/AppBar';
import { NoteList } from './components/NoteList';
import { lightTheme, darkTheme } from './lib/theme';
import { getSupportedLanguages, LanguageInfo } from './lib/monaco';
import { SettingsDialog } from './components/SettingsDialog';
import { ListNotes, NotifyFrontendReady, SaveNoteList } from '../wailsjs/go/backend/App';
import { ArchivedNoteList } from './components/ArchivedNoteList';
import { useNotes } from './hooks/useNotes';
import { useEditorSettings } from './hooks/useEditorSettings';
import { useFileOperations } from './hooks/useFileOperations';
import { MessageDialog } from './components/MessageDialog';
import { useMessageDialog } from './hooks/useMessageDialog';
import * as runtime from '../wailsjs/runtime';

function App() {
  const { isSettingsOpen, setIsSettingsOpen, editorSettings, setEditorSettings, handleSettingsChange } = useEditorSettings();

  const {
    notes,
    setNotes,
    currentNote,
    showArchived,
    setShowArchived,
    handleNewNote,
    handleArchiveNote,
    handleNoteSelect,
    handleUnarchiveNote,
    handleDeleteNote,
    handleTitleChange,
    handleLanguageChange,
    handleContentChange,
  } = useNotes();

  const { handleOpenFile, handleSaveFile } = useFileOperations(notes, currentNote, handleNoteSelect, setNotes);

  const { isMessageDialogOpen, messageTitle, messageContent, showMessage, onResult, isTwoButton } = useMessageDialog();

  const [languages, setLanguages] = useState<LanguageInfo[]>([]);
  const [platform, setPlatform] = useState<string>('');

  useEffect(() => {
    // コンポーネントのマウント時に言語一覧を取得
    setLanguages(getSupportedLanguages());
    const asyncFunc = async () => {
      try {
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
      const env = await runtime.Environment();
      setPlatform(env.platform);
    };
    asyncFunc();

    // フロントエンドの準備完了をバックエンドに通知
    NotifyFrontendReady();

    return () => {
      setLanguages([]);
    };
  }, []);

  return (
    <ThemeProvider theme={editorSettings.isDarkMode ? darkTheme : lightTheme}>
      <CssBaseline />
      <Box
        sx={{
          width: '100vw',
          height: '100vh',
          position: 'relative',
          // ドロップ対象エリアとして設定
          '.wails-drop-target-active': {
            backgroundColor: (theme) => (theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)'),
          },
          '--wails-drop-target': 'drop',
        }}
        component='main'
      >
        {platform === 'darwin' && (
          <Box
            sx={{
              height: 26,
              width: '100vw',
              '--wails-draggable': 'drag',
              backgroundColor: editorSettings.isDarkMode ? 'rgba(255, 255, 255, 0.2)' : 'action.disabledBackground',
            }}
          />
        )}
        <AppBar
          currentNote={currentNote}
          languages={languages}
          onTitleChange={handleTitleChange}
          onLanguageChange={handleLanguageChange}
          onSettings={() => setIsSettingsOpen(true)}
          onNew={handleNewNote}
          onOpen={handleOpenFile}
          onSave={handleSaveFile}
          showMessage={showMessage}
          handleNoteSelect={handleNoteSelect}
          notes={notes}
          setNotes={setNotes}
        />
        <Divider />
        <Box
          aria-label='Note List'
          sx={{
            position: 'absolute',
            top: platform === 'darwin' ? 83 : 57,
            left: 0,
            borderRight: 1,
            borderColor: 'divider',
            width: 242,
            height: platform === 'darwin' ? 'calc(100% - 83px)' : 'calc(100% - 57px)',
          }}
        >
          <NoteList
            notes={notes}
            currentNote={currentNote}
            onNoteSelect={handleNoteSelect}
            onArchive={handleArchiveNote}
            onShowArchived={() => setShowArchived(true)}
            onReorder={async (newNotes) => {
              setNotes(newNotes);
              // ノートリストの変更をバックエンドに反映
              await SaveNoteList();
            }}
          />
        </Box>

        <Box
          sx={{
            position: 'absolute',
            top: platform === 'darwin' ? 83 : 57,
            left: 242,
            width: 'calc(100% - 242px)',
            height: platform === 'darwin' ? 'calc(100% - 83px)' : 'calc(100% - 57px)',
          }}
        >
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
      <MessageDialog
        isOpen={isMessageDialogOpen}
        title={messageTitle}
        message={messageContent}
        isTwoButton={isTwoButton}
        onResult={onResult}
      />
    </ThemeProvider>
  );
}

export default App;
