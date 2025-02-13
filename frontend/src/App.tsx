import { useState, useRef } from 'react';
import { ThemeProvider, CssBaseline, Typography } from '@mui/material';
import { Editor } from './components/Editor';
import { Box, Divider, Button } from '@mui/material';
import { AppBar } from './components/AppBar';
import { NoteList } from './components/note-list/NoteList';
import { lightTheme, darkTheme } from './lib/theme';
import { SettingsDialog } from './components/SettingsDialog';
import { ArchivedNoteList } from './components/ArchivedNoteList';
import { useNotes } from './hooks/useNotes';
import { useFileNotes } from './hooks/useFileNotes';
import { useEditorSettings } from './hooks/useEditorSettings';
import { useFileOperations } from './hooks/useFileOperations';
import { MessageDialog } from './components/MessageDialog';
import { useMessageDialog } from './hooks/useMessageDialog';
import { EditorStatusBar } from './components/EditorStatusBar';
import type { editor } from 'monaco-editor';
import { useInitialize } from './hooks/useInitialize';
import { FileNote, Note } from './types';
import SimpleBar from 'simplebar-react';
import 'simplebar-react/dist/simplebar.min.css';
import { Inventory } from '@mui/icons-material';

function App() {
  const { isSettingsOpen, setIsSettingsOpen, editorSettings, setEditorSettings, handleSettingsChange } = useEditorSettings();
  const {
    isMessageDialogOpen,
    messageTitle,
    messageContent,
    showMessage,
    onResult,
    isTwoButton,
    primaryButtonText,
    secondaryButtonText,
  } = useMessageDialog();

  const {
    notes,
    setNotes,
    currentNote,
    setCurrentNote,
    showArchived,
    setShowArchived,
    handleNewNote,
    handleArchiveNote,
    handleNoteSelect,
    handleUnarchiveNote,
    handleDeleteNote,
    handleDeleteAllArchivedNotes,
    handleTitleChange,
    handleLanguageChange,
    handleNoteContentChange,
  } = useNotes();

  const {
    fileNotes,
    setFileNotes,
    currentFileNote,
    setCurrentFileNote,
    handleSaveFileNotes,
    handleFileNoteContentChange,
    handleCloseFile,
    isFileModified,
  } = useFileNotes({ showMessage });

  const handleNoteOrFileSelect = async (note: Note | FileNote) => {
    if (isFileNote(note)) {
      setCurrentFileNote(note);
      setCurrentNote(null);
    } else {
      setCurrentNote(note);
      setCurrentFileNote(null);
    }
  };

  const { handleOpenFile, handleSaveFile, handleSaveAsFile, handleConvertToNote } = useFileOperations(
    notes,
    setNotes,
    currentNote,
    currentFileNote,
    fileNotes,
    setFileNotes,
    handleNoteOrFileSelect,
    showMessage,
    handleSaveFileNotes
  );

  const { languages, platform } = useInitialize(setNotes, setFileNotes, handleNewNote, handleNoteSelect);

  const STATUS_BAR_HEIGHT = platform === 'darwin' ? 83 : 57;

  const editorInstanceRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [forceUpdate, setForceUpdate] = useState(0);

  // エディタインスタンスを更新するためのコールバック
  const handleEditorInstance = (instance: editor.IStandaloneCodeEditor | null) => {
    editorInstanceRef.current = instance;
    setForceUpdate((prev) => prev + 1);
  };

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
        {platform !== 'windows' && (
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
          currentNote={currentFileNote || currentNote}
          languages={languages}
          onTitleChange={handleTitleChange}
          onLanguageChange={handleLanguageChange}
          onSettings={() => setIsSettingsOpen(true)}
          onNew={handleNewNote}
          onOpen={handleOpenFile}
          onSave={handleSaveAsFile}
          showMessage={showMessage}
        />
        <Divider />
        <Box
          aria-label='Note List'
          sx={{
            position: 'absolute',
            top: STATUS_BAR_HEIGHT,
            left: 0,
            borderRight: 1,
            borderColor: 'divider',
            width: 242,
            height: `calc(100% - ${STATUS_BAR_HEIGHT}px)`,
            display: 'flex',
            flexDirection: 'column',
            '& .simplebar-track.simplebar-vertical .simplebar-scrollbar:before': {
              backgroundColor: 'text.secondary',
            },
          }}
        >
          <SimpleBar
            style={{
              height: 'calc(100% - 37.5px)',
            }}
          >
            {fileNotes.length > 0 && (
              <>
                <Box
                  sx={{
                    height: 26,
                    justifyContent: 'center',
                    alignItems: 'center',
                    display: 'flex',
                    backgroundColor: 'action.disabledBackground',
                  }}
                >
                  <Typography variant='body2' color='text.secondary'>
                    Local files
                  </Typography>
                </Box>
                <NoteList
                  notes={fileNotes}
                  currentNote={currentFileNote}
                  onNoteSelect={handleNoteOrFileSelect}
                  onConvertToNote={handleConvertToNote}
                  onSaveFile={handleSaveFile}
                  onReorder={async (newNotes) => {
                    setFileNotes(newNotes as FileNote[]);
                  }}
                  isFileMode={true}
                  onCloseFile={handleCloseFile}
                  isFileModified={isFileModified}
                />
              </>
            )}
            <Box
              sx={{
                height: 26,
                justifyContent: 'center',
                alignItems: 'center',
                display: 'flex',
                backgroundColor: 'action.disabledBackground',
              }}
            >
              <Typography variant='body2' color='text.secondary'>
                Notes
              </Typography>
            </Box>
            <NoteList
              notes={notes}
              currentNote={currentNote}
              onNoteSelect={handleNoteOrFileSelect}
              onArchive={handleArchiveNote}
              onReorder={async (newNotes) => {
                setNotes(newNotes as Note[]);
              }}
            />
          </SimpleBar>
          <Button
            fullWidth
            disabled={notes.filter((note) => note.archived).length === 0}
            sx={{
              mt: 'auto',
              borderRadius: 0,
              borderTop: 1,
              borderColor: 'divider',
              zIndex: 1000,
              backgroundColor: 'background.paper',
              '&:hover': {
                backgroundColor: 'action.hover',
              },
            }}
            onClick={() => setShowArchived(true)}
            startIcon={<Inventory />}
          >
            Archives {notes.filter((note) => note.archived).length ? `(${notes.filter((note) => note.archived).length})` : ''}
          </Button>
        </Box>

        <Box
          sx={{
            position: 'absolute',
            top: STATUS_BAR_HEIGHT,
            left: 242,
            width: 'calc(100% - 242px)',
            height: `calc(100% - ${STATUS_BAR_HEIGHT}px)`,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {showArchived ? (
            <ArchivedNoteList
              notes={notes}
              onUnarchive={handleUnarchiveNote}
              onDelete={handleDeleteNote}
              onDeleteAll={handleDeleteAllArchivedNotes}
              onClose={() => setShowArchived(false)}
            />
          ) : (
            <Editor
              value={currentFileNote?.content || currentNote?.content || ''}
              onChange={currentFileNote ? handleFileNoteContentChange : handleNoteContentChange}
              language={currentFileNote?.language || currentNote?.language || 'plaintext'}
              settings={editorSettings}
              currentNote={currentFileNote || currentNote}
              onEditorInstance={handleEditorInstance}
            />
          )}
          <EditorStatusBar editor={editorInstanceRef.current} currentNote={currentFileNote || currentNote} key={forceUpdate} />
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
        primaryButtonText={primaryButtonText}
        secondaryButtonText={secondaryButtonText}
        onResult={onResult}
      />
    </ThemeProvider>
  );
}

// 型ガード関数
function isFileNote(note: Note | FileNote): note is FileNote {
  return 'filePath' in note && 'fileName' in note;
}

export default App;
