import { useState, useRef } from 'react';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { Editor } from './components/Editor';
import { Box, Divider } from '@mui/material';
import { AppBar } from './components/AppBar';
import { NoteList } from './components/NoteList';
import { lightTheme, darkTheme } from './lib/theme';
import { LanguageInfo } from './lib/monaco';
import { SettingsDialog } from './components/SettingsDialog';
import { ArchivedNoteList } from './components/ArchivedNoteList';
import { useNotes } from './hooks/useNotes';
import { useEditorSettings } from './hooks/useEditorSettings';
import { useFileOperations } from './hooks/useFileOperations';
import { MessageDialog } from './components/MessageDialog';
import { useMessageDialog } from './hooks/useMessageDialog';
import { useInitialize } from './hooks/useInitialize';
import { EditorStatusBar } from './components/EditorStatusBar';
import type { editor } from 'monaco-editor';

function App() {
  const [languages, setLanguages] = useState<LanguageInfo[]>([]);
  const [platform, setPlatform] = useState<string>('');
  const editorInstanceRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [forceUpdate, setForceUpdate] = useState(0);

  // アプリの設定の読み込みと初期化
  const { isSettingsOpen, setIsSettingsOpen, editorSettings, setEditorSettings, handleSettingsChange } = useEditorSettings();

  // ノートの管理と操作
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
    handleDeleteAllArchivedNotes,
    handleTitleChange,
    handleLanguageChange,
    handleContentChange,
  } = useNotes();

  // メッセージダイアログの管理
  const { isMessageDialogOpen, messageTitle, messageContent, showMessage, onResult, isTwoButton } = useMessageDialog();

  // ファイル操作の管理
  const { handleOpenFile, handleSaveFile } = useFileOperations(notes, currentNote, handleNoteSelect, setNotes, showMessage);

  // アプリケーションの初期化とイベントリスナーの設定
  useInitialize({
    setNotes,
    handleNewNote,
    handleNoteSelect,
    setPlatform,
    setLanguages,
  });

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
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Box sx={{ flexGrow: 1, minHeight: 0 }}>
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
                value={currentNote?.content || ''}
                onChange={handleContentChange}
                language={currentNote?.language || 'plaintext'}
                settings={editorSettings}
                currentNote={currentNote}
                onEditorInstance={handleEditorInstance}
              />
            )}
          </Box>
          <EditorStatusBar editor={editorInstanceRef.current} currentNote={currentNote} key={forceUpdate} />
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
