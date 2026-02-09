import { CreateNewFolder, Inventory } from '@mui/icons-material';
import { Box, Button, CssBaseline, Divider, IconButton, ThemeProvider, Tooltip, Typography } from '@mui/material';
import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import type { editor } from 'monaco-editor';
import { useCallback, useMemo, useRef, useState } from 'react';
import SimpleBar from 'simplebar-react';
import 'simplebar-react/dist/simplebar.min.css';
import { WindowToggleMaximise } from '../wailsjs/runtime';
import { AppBar } from './components/AppBar';
import { ArchivedNoteList } from './components/ArchivedNoteList';
import { Editor } from './components/Editor';
import { EditorStatusBar } from './components/EditorStatusBar';
import { MarkdownPreview } from './components/MarkdownPreview';
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
import { useSplitEditor } from './hooks/useSplitEditor';
import { darkTheme, lightTheme } from './lib/theme';
import type { FileNote, Note } from './types';

// 検索マッチの各出現箇所を表す型（ノート内の何番目のマッチか）
type SearchMatch = {
  note: Note | FileNote;
  matchIndexInNote: number;
};

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

  const {
    isSplit,
    isMarkdownPreview,
    toggleSplit,
    toggleMarkdownPreview,
    focusedPane,
    handleFocusPane,
    leftNote,
    leftFileNote,
    rightNote,
    setRightNote,
    rightFileNote,
    setRightFileNote,
    handleSelectNoteForPane,
    handleLeftNoteContentChange,
    handleRightNoteContentChange,
    handleLeftFileNoteContentChange,
    handleRightFileNoteContentChange,
    secondarySelectedNoteId,
    restorePaneNotes,
    saveSplitState,
  } = useSplitEditor({
    currentNote,
    currentFileNote,
    setCurrentNote,
    setCurrentFileNote,
  });

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
    restorePaneNotes,
  );

  const handleToggleSplit = useCallback(() => {
    if (!isSplit) {
      const leftId = currentNote?.id || currentFileNote?.id;
      const firstOther =
        fileNotes.find((fn) => fn.id !== leftId) ||
        (() => {
          for (const item of topLevelOrder) {
            if (item.type === 'note') {
              const n = notes.find((n) => n.id === item.id && !n.archived && n.id !== leftId);
              if (n) return n;
            } else if (item.type === 'folder') {
              const n = notes.find((n) => n.folderId === item.id && !n.archived && n.id !== leftId);
              if (n) return n;
            }
          }
          return undefined;
        })();
      toggleSplit(firstOther ?? undefined);
    } else {
      toggleSplit();
    }
  }, [isSplit, currentNote, currentFileNote, fileNotes, notes, topLevelOrder, toggleSplit]);

  const STATUS_BAR_HEIGHT = platform === 'darwin' ? 83 : 57;

  const leftEditorInstanceRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const rightEditorInstanceRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const editorInstanceRef = leftEditorInstanceRef;

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

  // サイドバーの表示順に一致する検索マッチリスト（各ノート内の出現箇所ごとに展開）
  const { globalMatches, totalSearchMatches } = useMemo(() => {
    if (!noteSearch) return { globalMatches: [] as SearchMatch[], totalSearchMatches: 0 };

    const q = noteSearch.toLowerCase();
    const countOccurrences = (text: string | null): number => {
      if (!text) return 0;
      const lower = text.toLowerCase();
      let count = 0;
      let pos = lower.indexOf(q);
      while (pos !== -1) {
        count++;
        pos = lower.indexOf(q, pos + q.length);
      }
      return count;
    };

    const activeFiltered = filteredNotes.filter((n) => !n.archived);
    const filteredNoteSet = new Set(activeFiltered.map((n) => n.id));
    const filteredNoteMap = new Map(activeFiltered.map((n) => [n.id, n]));
    const orderedNotes: (Note | FileNote)[] = [...filteredFileNotes];
    for (const item of topLevelOrder) {
      if (item.type === 'note') {
        if (filteredNoteSet.has(item.id)) {
          const note = filteredNoteMap.get(item.id);
          if (note) orderedNotes.push(note);
        }
      } else if (item.type === 'folder') {
        const folderNotes = activeFiltered.filter((n) => n.folderId === item.id);
        orderedNotes.push(...folderNotes);
      }
    }

    const matches: SearchMatch[] = [];
    for (const note of orderedNotes) {
      const content = 'filePath' in note ? note.content : note.content;
      const matchCount = countOccurrences(content);
      for (let i = 0; i < matchCount; i++) {
        matches.push({ note, matchIndexInNote: i });
      }
    }

    return { globalMatches: matches, totalSearchMatches: matches.length };
  }, [noteSearch, filteredNotes, filteredFileNotes, topLevelOrder]);

  const handleSearchChange = useCallback((value: string) => {
    setNoteSearch(value);
    setSearchMatchIndex(value ? 1 : 0);
  }, []);

  const handleSearchNavigate = useCallback(
    (direction: 'next' | 'prev') => {
      if (totalSearchMatches === 0) return;
      let newIndex = searchMatchIndex;
      if (direction === 'next') {
        newIndex = searchMatchIndex >= totalSearchMatches ? 1 : searchMatchIndex + 1;
      } else {
        newIndex = searchMatchIndex <= 1 ? totalSearchMatches : searchMatchIndex - 1;
      }
      setSearchMatchIndex(newIndex);
      const match = globalMatches[newIndex - 1];
      if (match) {
        if (isSplit) {
          handleSelectNoteForPane(match.note);
        } else {
          handleSelecAnyNote(match.note);
        }
      }
    },
    [totalSearchMatches, searchMatchIndex, globalMatches, handleSelecAnyNote, isSplit, handleSelectNoteForPane],
  );

  const searchMatchIndexInNote = useMemo(() => {
    if (totalSearchMatches === 0 || searchMatchIndex === 0) return 0;
    const match = globalMatches[searchMatchIndex - 1];
    return match ? match.matchIndexInNote : 0;
  }, [globalMatches, searchMatchIndex, totalSearchMatches]);

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
          currentNote={isSplit ? leftFileNote || leftNote : currentFileNote || currentNote}
          languages={languages}
          platform={platform}
          onTitleChange={handleTitleChange}
          onLanguageChange={handleLanguageChange}
          onSettings={() => setIsSettingsOpen(true)}
          onNew={handleNewNote}
          onOpen={handleOpenFile}
          onSave={handleSaveAsFile}
          onFocusEditor={() => {
            if (isSplit) {
              (focusedPane === 'left' ? leftEditorInstanceRef : rightEditorInstanceRef).current?.focus();
            } else {
              editorInstanceRef.current?.focus();
            }
          }}
          showMessage={showMessage}
          isSplit={isSplit}
          isMarkdownPreview={isMarkdownPreview}
          onToggleSplit={handleToggleSplit}
          onToggleMarkdownPreview={toggleMarkdownPreview}
          rightNote={rightFileNote || rightNote}
          onRightTitleChange={(title) => {
            if (rightNote) {
              setRightNote({ ...rightNote, title, modifiedTime: new Date().toISOString() });
            }
          }}
          onRightLanguageChange={(language) => {
            if (rightNote) {
              setRightNote({ ...rightNote, language, modifiedTime: new Date().toISOString() });
            } else if (rightFileNote) {
              setRightFileNote({ ...rightFileNote, language });
            }
          }}
          focusedPane={focusedPane}
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
                    currentNote={isSplit ? leftFileNote : currentFileNote}
                    onNoteSelect={isSplit ? handleSelectNoteForPane : handleSelecAnyNote}
                    onConvertToNote={handleConvertToNote}
                    onSaveFile={handleSaveFile}
                    onReorder={async (newNotes) => {
                      setFileNotes(newNotes as FileNote[]);
                    }}
                    isFileMode={true}
                    onCloseFile={handleCloseFile}
                    isFileModified={isFileModified}
                    platform={platform}
                    secondarySelectedNoteId={secondarySelectedNoteId}
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
                    sx={{
                      position: 'absolute',
                      right: 4,
                    }}
                    onClick={async () => {
                      const folder = await handleCreateFolder('New Folder');
                      setEditingFolderId(folder.id);
                    }}
                  >
                    <CreateNewFolder sx={{ fontSize: 18 }} />
                  </IconButton>
                </Tooltip>
              </Box>
              <NoteList
                notes={noteSearch ? filteredNotes : notes}
                currentNote={isSplit ? leftNote : currentNote}
                onNoteSelect={isSplit ? handleSelectNoteForPane : handleSelecAnyNote}
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
                secondarySelectedNoteId={secondarySelectedNoteId}
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
            <Allotment>
              <Allotment.Pane minSize={200}>
                <Editor
                  editorInstanceRef={leftEditorInstanceRef}
                  value={
                    isSplit
                      ? leftNote?.content || leftFileNote?.content || ''
                      : currentNote?.content || currentFileNote?.content || ''
                  }
                  onChange={
                    isSplit
                      ? leftNote
                        ? handleLeftNoteContentChange
                        : handleLeftFileNoteContentChange
                      : currentNote
                        ? handleNoteContentChange
                        : handleFileNoteContentChange
                  }
                  language={
                    isSplit
                      ? leftNote?.language || leftFileNote?.language || 'plaintext'
                      : currentNote?.language || currentFileNote?.language || 'plaintext'
                  }
                  settings={editorSettings}
                  platform={platform}
                  currentNote={isSplit ? leftNote || leftFileNote : currentNote || currentFileNote}
                  searchKeyword={!isSplit || focusedPane === 'left' ? noteSearch : undefined}
                  searchMatchIndexInNote={!isSplit || focusedPane === 'left' ? searchMatchIndexInNote : 0}
                  onFocus={() => handleFocusPane('left')}
                  onNew={handleNewNote}
                  onOpen={handleOpenFile}
                  onSave={async () => {
                    if (isSplit) {
                      if (leftFileNote && isFileModified(leftFileNote.id)) {
                        await handleSaveFile(leftFileNote);
                      }
                    } else {
                      if (currentFileNote && isFileModified(currentFileNote.id)) {
                        await handleSaveFile(currentFileNote);
                      }
                    }
                  }}
                  onClose={async () => {
                    if (isSplit) {
                      if (leftFileNote) {
                        await handleCloseFile(leftFileNote);
                      } else if (leftNote) {
                        await handleArchiveNote(leftNote.id);
                      }
                    } else {
                      if (currentFileNote) {
                        await handleCloseFile(currentFileNote);
                      } else if (currentNote) {
                        await handleArchiveNote(currentNote.id);
                      }
                    }
                  }}
                  onSelectNext={handleSelectNextAnyNote}
                  onSelectPrevious={handleSelectPreviousAnyNote}
                />
              </Allotment.Pane>
              {isSplit && (
                <Allotment.Pane minSize={200}>
                  <Editor
                    editorInstanceRef={rightEditorInstanceRef}
                    value={rightNote?.content || rightFileNote?.content || ''}
                    onChange={rightNote ? handleRightNoteContentChange : handleRightFileNoteContentChange}
                    language={rightNote?.language || rightFileNote?.language || 'plaintext'}
                    settings={editorSettings}
                    platform={platform}
                    currentNote={rightNote || rightFileNote}
                    searchKeyword={focusedPane === 'right' ? noteSearch : undefined}
                    searchMatchIndexInNote={focusedPane === 'right' ? searchMatchIndexInNote : 0}
                    onFocus={() => handleFocusPane('right')}
                    onNew={handleNewNote}
                    onOpen={handleOpenFile}
                    onSave={async () => {
                      if (rightFileNote && isFileModified(rightFileNote.id)) {
                        await handleSaveFile(rightFileNote);
                      }
                    }}
                    onClose={async () => {
                      if (rightFileNote) {
                        await handleCloseFile(rightFileNote);
                      } else if (rightNote) {
                        await handleArchiveNote(rightNote.id);
                      }
                    }}
                    onSelectNext={handleSelectNextAnyNote}
                    onSelectPrevious={handleSelectPreviousAnyNote}
                  />
                </Allotment.Pane>
              )}
              {isMarkdownPreview && (
                <Allotment.Pane minSize={200}>
                  <MarkdownPreview content={currentNote?.content || currentFileNote?.content || ''} />
                </Allotment.Pane>
              )}
            </Allotment>
          )}
          <EditorStatusBar
            currentNote={
              isSplit
                ? focusedPane === 'left'
                  ? leftFileNote || leftNote
                  : rightFileNote || rightNote
                : currentFileNote || currentNote
            }
            editorInstanceRef={
              isSplit ? (focusedPane === 'left' ? leftEditorInstanceRef : rightEditorInstanceRef) : editorInstanceRef
            }
          />
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
