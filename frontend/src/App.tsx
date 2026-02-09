import { CreateNewFolder, Inventory } from '@mui/icons-material';
import { Box, Button, CssBaseline, Divider, IconButton, ThemeProvider, Tooltip, Typography } from '@mui/material';
import type { editor } from 'monaco-editor';
import { useCallback, useMemo, useRef, useState } from 'react';
import SimpleBar from 'simplebar-react';
import 'simplebar-react/dist/simplebar.min.css';
import { WindowToggleMaximise } from '../wailsjs/runtime';
import { AppBar } from './components/AppBar';
import { ArchivedNoteList } from './components/ArchivedNoteList';
import { Editor } from './components/Editor';
import { EditorStatusBar } from './components/EditorStatusBar';
import { MessageDialog } from './components/MessageDialog';
import { NoteList } from './components/NoteList';
import { NoteSearchBox } from './components/NoteSearchBox';
import { SettingsDialog } from './components/SettingsDialog';
import { useEditorSettings } from './hooks/useEditorSettings';
import { useFileNotes } from './hooks/useFileNotes';
import { useFileOperations } from './hooks/useFileOperations';
import { useInitialize } from './hooks/useInitialize';
import { useMessageDialog } from './hooks/useMessageDialog';
import { useNoteSelecter } from './hooks/useNoteSelecter';
import { useNotes } from './hooks/useNotes';
import { darkTheme, lightTheme } from './lib/theme';
import type { FileNote, Note } from './types';

function App() {
  // エディタ設定
  const { isSettingsOpen, setIsSettingsOpen, editorSettings, setEditorSettings, handleSettingsChange } = useEditorSettings();

  // メッセージダイアログ
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

  // ノート
  const {
    notes,
    setNotes,
    currentNote,
    setCurrentNote,
    showArchived,
    setShowArchived,
    handleNewNote,
    handleArchiveNote,
    handleSelectNote,
    handleUnarchiveNote,
    handleDeleteNote,
    handleDeleteAllArchivedNotes,
    handleTitleChange,
    handleLanguageChange,
    handleNoteContentChange,
    folders,
    setFolders,
    collapsedFolders,
    handleCreateFolder,
    handleRenameFolder,
    handleDeleteFolder,
    handleMoveNoteToFolder,
    handleUpdateTopLevelOrder,
    topLevelOrder,
    setTopLevelOrder,
    toggleFolderCollapse,
    archivedTopLevelOrder,
    handleArchiveFolder,
    handleUnarchiveFolder,
    handleDeleteArchivedFolder,
    handleUpdateArchivedTopLevelOrder,
  } = useNotes();

  // ファイルノート
  const {
    fileNotes,
    setFileNotes,
    currentFileNote,
    setCurrentFileNote,
    handleSelectFileNote,
    handleSaveFileNotes,
    handleFileNoteContentChange,
    handleCloseFile,
    isFileModified,
  } = useFileNotes({
    notes,
    setCurrentNote,
    handleNewNote,
    handleSelectNote,
    showMessage,
  });

  // ノート選択専用フック
  const { handleSelecAnyNote, handleSelectNextAnyNote, handleSelectPreviousAnyNote } = useNoteSelecter({
    handleSelectNote,
    handleSelectFileNote,
    notes,
    fileNotes,
    currentNote,
    currentFileNote,
    setCurrentNote,
    setCurrentFileNote,
  });

  // ファイル操作
  const { handleOpenFile, handleSaveFile, handleSaveAsFile, handleConvertToNote } = useFileOperations(
    notes,
    setNotes,
    currentNote,
    currentFileNote,
    fileNotes,
    setFileNotes,
    handleSelecAnyNote,
    showMessage,
    handleSaveFileNotes,
  );

  // 初期化
  const { languages, platform } = useInitialize(
    setNotes,
    setFileNotes,
    setFolders,
    setTopLevelOrder,
    handleNewNote,
    handleSelecAnyNote,
    currentFileNote,
    setCurrentFileNote,
    handleSaveFile,
    handleOpenFile,
    handleCloseFile,
    isFileModified,
    currentNote,
    handleArchiveNote,
    handleSaveAsFile,
    handleSelectNextAnyNote,
    handleSelectPreviousAnyNote,
  );

  const STATUS_BAR_HEIGHT = platform === 'darwin' ? 83 : 57;

  const editorInstanceRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const [noteSearch, setNoteSearch] = useState('');
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);

  const filteredNotes = useMemo(() => {
    if (!noteSearch) return notes;
    const q = noteSearch.toLowerCase();
    return notes.filter((note) => {
      if (note.archived) return false;
      return note.title.toLowerCase().includes(q) || (note.content?.toLowerCase().includes(q) ?? false);
    });
  }, [notes, noteSearch]);

  const filteredFileNotes = useMemo(() => {
    if (!noteSearch) return fileNotes;
    const q = noteSearch.toLowerCase();
    return fileNotes.filter((note) => note.fileName.toLowerCase().includes(q) || note.content.toLowerCase().includes(q));
  }, [fileNotes, noteSearch]);

  const totalSearchMatches = filteredNotes.filter((n) => !n.archived).length + filteredFileNotes.length;

  const handleSearchChange = useCallback((value: string) => {
    setNoteSearch(value);
    setSearchMatchIndex(value ? 1 : 0);
  }, []);

  const handleSearchNavigate = useCallback(
    (direction: 'next' | 'prev') => {
      if (totalSearchMatches === 0) return;
      const allMatched = [...filteredFileNotes, ...filteredNotes.filter((n) => !n.archived)];
      let newIndex = searchMatchIndex;
      if (direction === 'next') {
        newIndex = searchMatchIndex >= totalSearchMatches ? 1 : searchMatchIndex + 1;
      } else {
        newIndex = searchMatchIndex <= 1 ? totalSearchMatches : searchMatchIndex - 1;
      }
      setSearchMatchIndex(newIndex);
      const target = allMatched[newIndex - 1];
      if (target) handleSelecAnyNote(target);
    },
    [totalSearchMatches, searchMatchIndex, filteredFileNotes, filteredNotes, handleSelecAnyNote],
  );

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
              backgroundColor: editorSettings.isDarkMode ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onDoubleClick={() => {
              WindowToggleMaximise();
            }}
          >
            <Typography
              variant='body2'
              color='text.secondary'
              fontWeight='bold'
              sx={{ userSelect: 'none', pointerEvents: 'none' }}
            >
              Monaco Notepad
            </Typography>
          </Box>
        )}
        <AppBar
          currentNote={currentFileNote || currentNote}
          languages={languages}
          platform={platform}
          onTitleChange={handleTitleChange}
          onLanguageChange={handleLanguageChange}
          onSettings={() => setIsSettingsOpen(true)}
          onNew={handleNewNote}
          onOpen={handleOpenFile}
          onSave={handleSaveAsFile}
          onFocusEditor={() => editorInstanceRef.current?.focus()}
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
          <NoteSearchBox
            value={noteSearch}
            onChange={handleSearchChange}
            onNext={() => handleSearchNavigate('next')}
            onPrevious={() => handleSearchNavigate('prev')}
            matchIndex={searchMatchIndex}
            matchCount={totalSearchMatches}
          />
          <Box sx={{ flex: '1 1 0', minHeight: 0, overflow: 'hidden' }}>
            <SimpleBar style={{ height: '100%' }}>
              {filteredFileNotes.length > 0 && (
                <>
                  <Box
                    sx={{
                      height: 32,
                      justifyContent: 'center',
                      alignItems: 'center',
                      display: 'flex',
                      backgroundColor: 'action.disabledBackground',
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 1,
                      m: 1,
                      mb: 0,
                    }}
                  >
                    <Typography variant='body2' color='text.secondary'>
                      Local files
                    </Typography>
                  </Box>
                  <NoteList
                    notes={noteSearch ? filteredFileNotes : fileNotes}
                    currentNote={currentFileNote}
                    onNoteSelect={handleSelecAnyNote}
                    onConvertToNote={handleConvertToNote}
                    onSaveFile={handleSaveFile}
                    onReorder={async (newNotes) => {
                      setFileNotes(newNotes as FileNote[]);
                    }}
                    isFileMode={true}
                    onCloseFile={handleCloseFile}
                    isFileModified={isFileModified}
                    platform={platform}
                  />
                  <Divider />
                </>
              )}
              <Box
                sx={{
                  height: 32,
                  justifyContent: 'center',
                  alignItems: 'center',
                  display: 'flex',
                  backgroundColor: 'action.disabledBackground',
                  position: 'relative',
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                  m: 1,
                  mb: 0,
                }}
              >
                <Typography variant='body2' color='text.secondary'>
                  Notes
                </Typography>
                <Tooltip title='New Folder' arrow placement='bottom'>
                  <IconButton
                    size='small'
                    sx={{
                      position: 'absolute',
                      right: 4,
                      width: 20,
                      height: 20,
                    }}
                    onClick={async () => {
                      const folder = await handleCreateFolder('New Folder');
                      setEditingFolderId(folder.id);
                    }}
                  >
                    <CreateNewFolder sx={{ width: 14, height: 14 }} />
                  </IconButton>
                </Tooltip>
              </Box>
              <NoteList
                notes={noteSearch ? filteredNotes : notes}
                currentNote={currentNote}
                onNoteSelect={handleSelecAnyNote}
                onArchive={handleArchiveNote}
                onReorder={async (newNotes) => {
                  setNotes(newNotes as Note[]);
                }}
                platform={platform}
                folders={folders}
                collapsedFolders={collapsedFolders}
                onToggleFolderCollapse={toggleFolderCollapse}
                onMoveNoteToFolder={handleMoveNoteToFolder}
                onRenameFolder={handleRenameFolder}
                onDeleteFolder={handleDeleteFolder}
                onArchiveFolder={handleArchiveFolder}
                editingFolderId={editingFolderId}
                onEditingFolderDone={() => setEditingFolderId(null)}
                topLevelOrder={topLevelOrder}
                onUpdateTopLevelOrder={handleUpdateTopLevelOrder}
              />
            </SimpleBar>
          </Box>
          <Button
            fullWidth
            disabled={notes.filter((note) => note.archived).length === 0 && folders.filter((f) => f.archived).length === 0}
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
              folders={folders}
              archivedTopLevelOrder={archivedTopLevelOrder}
              onUnarchive={handleUnarchiveNote}
              onDelete={handleDeleteNote}
              onDeleteAll={async () => {
                const confirmed = await showMessage(
                  'Delete all',
                  'Delete all archived notes? This cannot be undone.',
                  true,
                  'Delete',
                  'Cancel',
                );
                if (confirmed) handleDeleteAllArchivedNotes();
              }}
              onClose={() => setShowArchived(false)}
              onUnarchiveFolder={handleUnarchiveFolder}
              onDeleteFolder={handleDeleteArchivedFolder}
              onUpdateArchivedTopLevelOrder={handleUpdateArchivedTopLevelOrder}
              onMoveNoteToFolder={handleMoveNoteToFolder}
              isDarkMode={editorSettings.isDarkMode}
            />
          ) : (
            <Editor
              editorInstanceRef={editorInstanceRef}
              value={currentNote?.content || currentFileNote?.content || ''}
              onChange={currentNote ? handleNoteContentChange : handleFileNoteContentChange}
              language={currentNote?.language || currentFileNote?.language || 'plaintext'}
              settings={editorSettings}
              platform={platform}
              currentNote={currentNote || currentFileNote}
              onNew={handleNewNote}
              onOpen={handleOpenFile}
              onSave={async () => {
                if (currentFileNote && isFileModified(currentFileNote.id)) {
                  await handleSaveFile(currentFileNote);
                }
              }}
              onClose={async () => {
                if (currentFileNote) {
                  await handleCloseFile(currentFileNote);
                } else if (currentNote) {
                  await handleArchiveNote(currentNote.id);
                }
              }}
              onSelectNext={handleSelectNextAnyNote}
              onSelectPrevious={handleSelectPreviousAnyNote}
            />
          )}
          <EditorStatusBar currentNote={currentFileNote || currentNote} editorInstanceRef={editorInstanceRef} />
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

export default App;
