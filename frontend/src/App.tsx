import { CreateNewFolder, Inventory } from '@mui/icons-material';
import type { SelectProps, Theme } from '@mui/material';
import {
  Box,
  Button,
  CssBaseline,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  ThemeProvider,
  Tooltip,
  Typography,
} from '@mui/material';
import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import type { editor } from 'monaco-editor';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import SimpleBar from 'simplebar-react';
import 'simplebar-react/dist/simplebar.min.css';
import { SaveNote, UpdateNoteOrder } from '../wailsjs/go/backend/App';
import { backend } from '../wailsjs/go/models';
import { WindowToggleMaximise } from '../wailsjs/runtime';
import { AppBar } from './components/AppBar';
import { ArchivedNoteList } from './components/ArchivedNoteList';
import { Editor } from './components/Editor';
import { EditorStatusBar } from './components/EditorStatusBar';
import { MarkdownPreview } from './components/MarkdownPreview';
import { MessageDialog } from './components/MessageDialog';
import {
  insertTopLevelNote,
  type FileDropInsertionTarget,
  NoteList,
} from './components/NoteList';
import { NoteSearchBox } from './components/NoteSearchBox';
import { SettingsDialog } from './components/SettingsDialog';
import { useEditorSettings } from './hooks/useEditorSettings';
import { useFileNotes } from './hooks/useFileNotes';
import { useFileOperations } from './hooks/useFileOperations';
import { useInitialize } from './hooks/useInitialize';
import { useMessageDialog } from './hooks/useMessageDialog';
import { useNoteSelecter } from './hooks/useNoteSelecter';
import { useNotes } from './hooks/useNotes';
import { usePaneSizes } from './hooks/usePaneSizes';
import { useSplitEditor } from './hooks/useSplitEditor';
import type { LanguageInfo } from './lib/monaco';
import { darkTheme, lightTheme } from './lib/theme';
import type { FileNote, Note, TopLevelItem } from './types';

const scrollbarSx = (theme: Theme) => ({
  '&::-webkit-scrollbar': { width: 7 },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
  '&::-webkit-scrollbar-thumb': {
    backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)',
    borderRadius: 7,
    '&:hover': {
      backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)',
    },
  },
});

const languageMenuProps: SelectProps['MenuProps'] = {
  slotProps: {
    paper: {
      sx: (theme: Theme) => ({
        height: '80%',
        maxHeight: 800,
        ...scrollbarSx(theme),
        '& ul': scrollbarSx(theme),
      }),
    },
  },
};

const isFileNote = (note: Note | FileNote | null): note is FileNote => note !== null && 'filePath' in note;
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const PaneHeader: React.FC<{
  note: Note | FileNote | null;
  languages: LanguageInfo[];
  onTitleChange: (title: string) => void;
  onLanguageChange: (language: string) => void;
  onActivatePane?: () => void;
  onFocusEditor?: () => void;
  isSplit: boolean;
  paneColor?: 'primary' | 'secondary';
  paneLabel?: string;
  dimmed?: boolean;
}> = ({
  note,
  languages,
  onTitleChange,
  onLanguageChange,
  onActivatePane,
  onFocusEditor,
  isSplit,
  paneColor,
  paneLabel,
  dimmed,
}) => {
  const { t } = useTranslation();

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1,
        py: 0.5,
        minHeight: 48,
        opacity: dimmed ? 0.5 : 1,
        transition: 'opacity 0.2s',
      }}
    >
    {paneLabel &&
      (!dimmed ? (
        <Box
          sx={{
            flexShrink: 0,
            width: 24,
            height: 24,
            borderRadius: '50%',
            border: (theme) => `2px solid ${theme.palette[paneColor || 'primary'].main}`,
            backgroundColor: (theme) => `${theme.palette[paneColor || 'primary'].main}20`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Typography
            variant='body2'
            sx={{
              fontWeight: 'bold',
              color: `${paneColor}.main`,
              lineHeight: 1,
            }}
          >
            {paneLabel}
          </Typography>
        </Box>
      ) : (
        <Typography
          variant='body2'
          sx={{
            flexShrink: 0,
            fontWeight: 'bold',
            color: `${paneColor}.main`,
            width: 24,
            textAlign: 'center',
          }}
        >
          {paneLabel}
        </Typography>
      ))}
        <TextField
          sx={{
            width: '100%',
            '& .MuiOutlinedInput-root': {
              height: 32,
              ...(isSplit &&
                paneColor && {
                  '& fieldset': { borderColor: `${paneColor}.main` },
                  '&:hover fieldset': { borderColor: `${paneColor}.main` },
                }),
            },
            '& .MuiInputLabel-root:not(.MuiInputLabel-shrink)': { top: -4 },
            ...(isSplit &&
              paneColor && {
                '& .MuiInputLabel-root': { color: `${paneColor}.main` },
              }),
          }}
          label={isFileNote(note) ? t('app.paneFilePath') : t('app.paneTitle')}
          variant='outlined'
          size='small'
          value={isFileNote(note) ? note.filePath : (note as Note | null)?.title || ''}
          onChange={(e) => {
            onActivatePane?.();
            onTitleChange(e.target.value);
          }}
          disabled={isFileNote(note)}
          onFocus={() => onActivatePane?.()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
              onFocusEditor?.();
            }
          }}
        />
        <FormControl
          sx={{
            minWidth: 180,
            flexShrink: 0,
            '& .MuiOutlinedInput-root': {
              height: 32,
              ...(isSplit &&
                paneColor && {
                  '& fieldset': { borderColor: `${paneColor}.main` },
                  '&:hover fieldset': { borderColor: `${paneColor}.main` },
                }),
            },
            '& .MuiInputLabel-root:not(.MuiInputLabel-shrink)': { top: -4 },
            ...(isSplit &&
              paneColor && {
                '& .MuiInputLabel-root': { color: `${paneColor}.main` },
              }),
          }}
          size='small'
        >
          <InputLabel size='small'>{t('app.language')}</InputLabel>
          <Select
            size='small'
            autoWidth
            value={languages.some((lang) => lang.id === note?.language) ? note?.language : ''}
            onOpen={() => onActivatePane?.()}
            onFocus={() => onActivatePane?.()}
            onChange={(e) => {
              onActivatePane?.();
              onLanguageChange(e.target.value);
            }}
            label={t('app.language')}
            MenuProps={languageMenuProps}
          >
            {languages.map((lang) => (
              <MenuItem key={lang.id} value={lang.id}>
                {lang.aliases?.[0] ?? lang.id}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
    </Box>
  );
};

// 検索マッチの各出現箇所を表す型（ノート内の何番目のマッチか）
type SearchMatch = {
  note: Note | FileNote;
  matchIndexInNote: number;
};

function App() {
  const { t } = useTranslation();

  // エディタ設定
  const { isSettingsOpen, setIsSettingsOpen, editorSettings, setEditorSettings, handleSettingsChange } = useEditorSettings();

  // ペインサイズ管理
  const {
    sidebarWidth,
    splitPaneSize,
    markdownPreviewPaneSize,
    handleSidebarWidthChange,
    handleSplitPaneSizeChange,
    handleMarkdownPreviewPaneSizeChange,
    scheduleSave: schedulePaneSizeSave,
    getAllotmentSizes,
  } = usePaneSizes(editorSettings);

  // ペインサイズを設定に保存するハンドラ
  const savePaneSizes = useCallback(
    (sizes: { sidebarWidth: number; splitPaneSize: number; markdownPreviewPaneSize: number }) => {
      setEditorSettings({
        ...editorSettings,
        sidebarWidth: sizes.sidebarWidth,
        splitPaneSize: sizes.splitPaneSize,
        markdownPreviewPaneSize: sizes.markdownPreviewPaneSize,
      });
    },
    [setEditorSettings, editorSettings]
  );

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

  const onNotesReloadedRef = useRef<
    ((notes: Note[], topLevelOrder?: TopLevelItem[]) => void) | null
  >(null);
  const isSplitRef = useRef<boolean>(false);
  const focusedPaneRef = useRef<'left' | 'right'>('left');
  const openNoteInPaneRef = useRef<((note: Note | FileNote, pane: 'left' | 'right') => void) | null>(null);

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
    setArchivedTopLevelOrder,
    handleArchiveFolder,
    handleUnarchiveFolder,
    handleDeleteArchivedFolder,
    handleUpdateArchivedTopLevelOrder,
  } = useNotes({
    onNotesReloaded: onNotesReloadedRef,
    isSplit: isSplitRef.current,
    focusedPane: focusedPaneRef.current,
    openNoteInSplitPane: openNoteInPaneRef.current ?? undefined,
  });

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
  const { handleOpenFile, handleSaveFile, handleSaveAsFile } = useFileOperations(
    notes,
    setNotes,
    currentNote,
    currentFileNote,
    fileNotes,
    setFileNotes,
    handleSelecAnyNote,
    showMessage,
    handleSaveFileNotes,
    isSplitRef,
    openNoteInPaneRef,
  );

  const {
    isSplit,
    isMarkdownPreview,
    toggleSplit,
    toggleMarkdownPreview,
    focusedPane,
    handleFocusPane,
    leftNote,
    setLeftNote,
    leftFileNote,
    setLeftFileNote,
    rightNote,
    setRightNote,
    rightFileNote,
    setRightFileNote,
    handleSelectNoteForPane,
    openNoteInPane,
    handleLeftNoteContentChange,
    handleRightNoteContentChange,
    handleLeftNoteTitleChange,
    handleRightNoteTitleChange,
    handleLeftNoteLanguageChange,
    handleRightNoteLanguageChange,
    handleLeftFileNoteContentChange,
    handleRightFileNoteContentChange,
    secondarySelectedNoteId,
    restorePaneNotes,
    saveSplitState,
    syncPaneNotes,
  } = useSplitEditor({
    currentNote,
    currentFileNote,
    setCurrentNote,
    setCurrentFileNote,
    setNotes,
  });

  onNotesReloadedRef.current = syncPaneNotes;
  isSplitRef.current = isSplit;
  focusedPaneRef.current = focusedPane;
  openNoteInPaneRef.current = openNoteInPane;

  const archiveNoteRef = useRef(handleArchiveNote);
  const closeFileRef = useRef(handleCloseFile);

  // 初期化
  const { languages, platform } = useInitialize(
    setNotes,
    setFileNotes,
    setFolders,
    setTopLevelOrder,
    setArchivedTopLevelOrder,
    handleNewNote,
    handleSelecAnyNote,
    currentFileNote,
    setCurrentFileNote,
    handleSaveFile,
    handleOpenFile,
    useCallback((file: FileNote) => closeFileRef.current(file), []),
    isFileModified,
    currentNote,
    useCallback((noteId: string) => archiveNoteRef.current(noteId), []),
    handleSaveAsFile,
    handleSelectNextAnyNote,
    handleSelectPreviousAnyNote,
    showMessage,
    restorePaneNotes,
  );

  const totalAvailableItems = fileNotes.length + notes.filter((n) => !n.archived).length;
  const canSplit = isSplit || totalAvailableItems >= 2;

  const handleToggleSplit = useCallback(() => {
    if (!isSplit) {
      if (!canSplit) return;
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
  }, [isSplit, canSplit, currentNote, currentFileNote, fileNotes, notes, topLevelOrder, toggleSplit]);

  const findFirstOtherNote = useCallback(
    (...excludeIds: string[]): Note | FileNote | undefined => {
      const excluded = new Set(excludeIds);
      const found = fileNotes.find((fn) => !excluded.has(fn.id));
      if (found) return found;
      for (const item of topLevelOrder) {
        if (item.type === 'note') {
          const n = notes.find((n) => n.id === item.id && !n.archived && !excluded.has(n.id));
          if (n) return n;
        } else if (item.type === 'folder') {
          const n = notes.find((n) => n.folderId === item.id && !n.archived && !excluded.has(n.id));
          if (n) return n;
        }
      }
      return undefined;
    },
    [fileNotes, notes, topLevelOrder],
  );

  const handleOpenNoteInPane = useCallback(
    (note: Note | FileNote, pane: 'left' | 'right') => {
      if (!canSplit && !isSplit) return;
      const fallback = findFirstOtherNote(note.id);
      openNoteInPane(note, pane, fallback);
    },
    [openNoteInPane, findFirstOtherNote, canSplit, isSplit],
  );

  const replacePaneAfterClose = useCallback(
    (closedId: string) => {
      if (!isSplit) return;
      const leftId = leftNote?.id ?? leftFileNote?.id;
      const rightId = rightNote?.id ?? rightFileNote?.id;
      const inLeft = leftId === closedId;
      const inRight = rightId === closedId;

      if (!inLeft && !inRight) return;
      if (inLeft && inRight) return;

      const setPaneNote = (pane: 'left' | 'right', note: Note | FileNote) => {
        const isFile = 'filePath' in note;
        if (pane === 'left') {
          setLeftNote(isFile ? null : (note as Note));
          setLeftFileNote(isFile ? (note as FileNote) : null);
        } else {
          setRightNote(isFile ? null : (note as Note));
          setRightFileNote(isFile ? (note as FileNote) : null);
        }
        if (focusedPane === pane) {
          setCurrentNote(isFile ? null : (note as Note));
          setCurrentFileNote(isFile ? (note as FileNote) : null);
        }
      };

      if (inLeft) {
        const replacement = findFirstOtherNote(closedId, rightId ?? '');
        if (replacement) {
          setPaneNote('left', replacement);
        } else {
          toggleSplit();
        }
      } else if (inRight) {
        const replacement = findFirstOtherNote(closedId, leftId ?? '');
        if (replacement) {
          setPaneNote('right', replacement);
        } else {
          toggleSplit();
        }
      }
      saveSplitState();
    },
    [
      isSplit,
      leftNote,
      leftFileNote,
      rightNote,
      rightFileNote,
      focusedPane,
      findFirstOtherNote,
      setLeftNote,
      setLeftFileNote,
      setRightNote,
      setRightFileNote,
      setCurrentNote,
      setCurrentFileNote,
      toggleSplit,
      saveSplitState,
    ],
  );

  const handleArchiveNoteWithSplit = useCallback(
    async (noteId: string) => {
      await handleArchiveNote(noteId);
      replacePaneAfterClose(noteId);
    },
    [handleArchiveNote, replacePaneAfterClose],
  );

  const handleCloseFileWithSplit = useCallback(
    async (fileNote: FileNote) => {
      await handleCloseFile(fileNote);
      if (!isSplit) {
        // Override the wrong selection made by handleCloseFile
        // (which picks array-first instead of topLevelOrder-first)
        const replacement = findFirstOtherNote(fileNote.id);
        if (replacement) {
          const isFile = 'filePath' in replacement;
          setCurrentNote(isFile ? null : (replacement as Note));
          setCurrentFileNote(isFile ? (replacement as FileNote) : null);
        }
        return;
      }
      replacePaneAfterClose(fileNote.id);
    },
    [handleCloseFile, replacePaneAfterClose, isSplit, findFirstOtherNote, setCurrentNote, setCurrentFileNote],
  );

  const handleDropFileNoteToNotes = useCallback(
    async (fileNoteId: string, target: FileDropInsertionTarget) => {
      const fileNote = fileNotes.find((value) => value.id === fileNoteId);
      if (!fileNote) return;
      const wasCurrentFile = currentFileNote?.id === fileNoteId;
      const wasLeftFile = leftFileNote?.id === fileNoteId;
      const wasRightFile = rightFileNote?.id === fileNoteId;

      const newNote: Note = {
        id: crypto.randomUUID(),
        title: fileNote.fileName.replace(/\.[^/.]+$/, ''),
        content: fileNote.content,
        contentHeader: null,
        language: fileNote.language,
        modifiedTime: new Date().toISOString(),
        archived: false,
        ...(target.kind === 'folder' ? { folderId: target.folderId } : {}),
      };

      const remainingFileNotes = fileNotes.filter((value) => value.id !== fileNoteId);
      const activeNotes = notes.filter((note) => !note.archived);
      const archivedNotes = notes.filter((note) => note.archived);

      let insertedActiveNotes = [...activeNotes];
      let destinationIndex = activeNotes.length;
      if (target.kind === 'flat' || target.kind === 'folder') {
        destinationIndex = clamp(target.destinationIndex, 0, activeNotes.length);
        insertedActiveNotes = [
          ...activeNotes.slice(0, destinationIndex),
          newNote,
          ...activeNotes.slice(destinationIndex),
        ];
      } else {
        insertedActiveNotes = [...activeNotes, newNote];
      }

      setFileNotes(remainingFileNotes);
      setNotes([...insertedActiveNotes, ...archivedNotes]);

      await handleSaveFileNotes(remainingFileNotes);
      await SaveNote(backend.Note.createFrom(newNote), 'create');

      if (target.kind === 'top-level') {
        const nextOrder = insertTopLevelNote(
          topLevelOrder,
          newNote.id,
          target.topLevelInsertIndex,
        );
        await handleUpdateTopLevelOrder(nextOrder);
      } else {
        try {
          await UpdateNoteOrder(newNote.id, destinationIndex);
        } catch (error) {
          console.error('Failed to update converted note order:', error);
        }
      }

      let replacedPane = false;
      if (isSplit) {
        if (wasLeftFile) {
          setLeftFileNote(null);
          setLeftNote(newNote);
          replacedPane = true;
        }
        if (wasRightFile) {
          setRightFileNote(null);
          setRightNote(newNote);
          replacedPane = true;
        }
        if (wasCurrentFile) {
          setCurrentFileNote(null);
          setCurrentNote(newNote);
        }
        if (replacedPane) {
          saveSplitState();
        }
      }

      if (!isSplit || !replacedPane) {
        await handleSelecAnyNote(newNote);
      }
    },
    [
      currentFileNote,
      fileNotes,
      handleSaveFileNotes,
      handleSelecAnyNote,
      handleUpdateTopLevelOrder,
      isSplit,
      leftFileNote,
      rightFileNote,
      notes,
      saveSplitState,
      setFileNotes,
      setLeftFileNote,
      setLeftNote,
      setRightFileNote,
      setRightNote,
      setCurrentFileNote,
      setCurrentNote,
      setNotes,
      topLevelOrder,
    ],
  );

  const handleConvertToNoteWithPlacement = useCallback(
    async (fileNote: FileNote) => {
      const hasActiveFolders = folders.some((folder) => !folder.archived);
      if (hasActiveFolders) {
        await handleDropFileNoteToNotes(fileNote.id, {
          kind: 'top-level',
          topLevelInsertIndex: 0,
        });
        return;
      }
      await handleDropFileNoteToNotes(fileNote.id, {
        kind: 'flat',
        destinationIndex: 0,
      });
    },
    [folders, handleDropFileNoteToNotes],
  );

  archiveNoteRef.current = handleArchiveNoteWithSplit;
  closeFileRef.current = handleCloseFileWithSplit;

  const TITLE_BAR_HEIGHT = platform === 'darwin' ? 26 : 0;

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

  const handleSidebarSelectAnyNote = useCallback(
    async (note: Note | FileNote) => {
      if (showArchived) {
        setShowArchived(false);
      }
      if (isSplit) {
        await handleSelectNoteForPane(note);
      } else {
        await handleSelecAnyNote(note);
      }
    },
    [showArchived, setShowArchived, isSplit, handleSelectNoteForPane, handleSelecAnyNote],
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
        }}
        component='main'
      >
        {/* macOS タイトルバー */}
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
              {t('app.titleBar')}
            </Typography>
          </Box>
        )}

        {/* メインレイアウト: サイドバー + エディタ領域 */}
        <Box
          sx={{
            position: 'absolute',
            top: TITLE_BAR_HEIGHT,
            left: 0,
            right: 0,
            bottom: 0,
          }}
        >
          <Allotment
            onChange={(sizes) => {
              if (sizes[0]) {
                handleSidebarWidthChange(sizes[0]);
                schedulePaneSizeSave(savePaneSizes);
              }
            }}
          >
            {/* サイドバー */}
            <Allotment.Pane preferredSize={sidebarWidth} minSize={242} maxSize={500}>
              <Box
                aria-label={t('app.noteListAriaLabel')}
                sx={{
                  width: '100%',
                  height: '100%',
                  borderRight: 1,
                  borderColor: 'divider',
                  display: 'flex',
                  flexDirection: 'column',
                  '& .simplebar-track.simplebar-vertical .simplebar-scrollbar:before': {
                    backgroundColor: 'text.secondary',
                  },
                }}
              >
            <AppBar platform={platform} onNew={handleNewNote} onOpen={handleOpenFile} onSave={handleSaveAsFile} />
            <Divider />
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
                        {t('app.localFiles')}{' '}
                        <Typography component='span' variant='caption' sx={{ fontWeight: 'normal', display: 'inline-block', ml: 1 }}>
                          {noteSearch ? filteredFileNotes.length : fileNotes.length}
                        </Typography>
                      </Typography>
                    </Box>
                    <NoteList
                      notes={noteSearch ? filteredFileNotes : fileNotes}
                      currentNote={isSplit ? leftFileNote : currentFileNote}
                      onNoteSelect={handleSidebarSelectAnyNote}
                      allowReselect={showArchived}
                      onConvertToNote={handleConvertToNoteWithPlacement}
                      onSaveFile={handleSaveFile}
                      onReorder={async (newNotes) => {
                        setFileNotes(newNotes as FileNote[]);
                      }}
                      isFileMode={true}
                      onCloseFile={handleCloseFileWithSplit}
                      isFileModified={isFileModified}
                      platform={platform}
                      secondarySelectedNoteId={secondarySelectedNoteId}
                      onOpenInPane={handleOpenNoteInPane}
                      canSplit={canSplit}
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
                    {t('app.notes')}{' '}
                    <Typography component='span' variant='caption' sx={{ fontWeight: 'normal', display: 'inline-block', ml: 1 }}>
                      {noteSearch ? filteredNotes.length : notes.filter((note) => !note.archived).length}
                    </Typography>
                  </Typography>
                  <Tooltip title={t('app.newFolder')} arrow placement='bottom'>
                    <IconButton
                      sx={{
                        position: 'absolute',
                        right: 4,
                      }}
                      onClick={async () => {
                        const folder = await handleCreateFolder(t('app.newFolder'));
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
                  onNoteSelect={handleSidebarSelectAnyNote}
                  allowReselect={showArchived}
                  onArchive={handleArchiveNoteWithSplit}
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
                  onOpenInPane={handleOpenNoteInPane}
                  canSplit={canSplit}
                  onDropFileNoteToNotes={handleDropFileNoteToNotes}
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
              onClick={() => setShowArchived((prev) => !prev)}
              startIcon={<Inventory />}
            >
              {t('app.archives')}{' '}
              {notes.filter((note) => note.archived).length ? `(${notes.filter((note) => note.archived).length})` : ''}
            </Button>
              </Box>
            </Allotment.Pane>

            {/* エディタ領域 */}
            <Allotment.Pane>
              <Box
                sx={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  minWidth: 0,
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
                    t('archived.deleteAllDialogTitle'),
                    t('archived.deleteAllDialogMessage'),
                    true,
                    t('dialog.delete'),
                    t('dialog.cancel'),
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
              <Allotment
                defaultSizes={getAllotmentSizes(isSplit, isMarkdownPreview, editorSettings.markdownPreviewOnLeft)}
                onChange={(sizes) => {
                  if (isSplit && sizes.length >= 2) {
                    const total = sizes[0] + sizes[1];
                    if (total > 0) {
                      handleSplitPaneSizeChange(sizes[0] / total);
                      schedulePaneSizeSave(savePaneSizes);
                    }
                  } else if (isMarkdownPreview && sizes.length >= 2) {
                    const total = sizes[0] + sizes[1];
                    if (total > 0) {
                      const isPreviewOnLeft = editorSettings.markdownPreviewOnLeft;
                      const previewSize = isPreviewOnLeft ? sizes[0] : sizes[1];
                      handleMarkdownPreviewPaneSizeChange(previewSize / total);
                      schedulePaneSizeSave(savePaneSizes);
                    }
                  }
                }}
              >
                {isMarkdownPreview && editorSettings.markdownPreviewOnLeft && (
                  <Allotment.Pane minSize={200}>
                    <MarkdownPreview editorInstanceRef={leftEditorInstanceRef} />
                  </Allotment.Pane>
                )}
                <Allotment.Pane minSize={200}>
                  <Box
                    data-pane='left'
                    sx={{
                      height: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                      position: 'relative',
                      '--wails-drop-target': 'drop',
                      '&.wails-drop-target-active::after': {
                        content: '""',
                        position: 'absolute',
                        inset: 0,
                        backgroundColor: (theme) =>
                          theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)',
                        pointerEvents: 'none',
                        zIndex: 5,
                      },
                    }}
                  >
                    <PaneHeader
                      note={isSplit ? leftFileNote || leftNote : currentFileNote || currentNote}
                      languages={languages}
                      onActivatePane={isSplit ? () => handleFocusPane('left') : undefined}
                      onTitleChange={
                        isSplit
                          ? (title) => {
                              if (leftNote) {
                                handleLeftNoteTitleChange(title);
                              }
                            }
                          : handleTitleChange
                      }
                      onLanguageChange={
                        isSplit
                          ? (language) => {
                              if (leftNote) {
                                handleLeftNoteLanguageChange(language);
                              } else if (leftFileNote) {
                                // 非同期更新の取りこぼしを避けるため、関数型更新で現在値に対して適用する。
                                setLeftFileNote((prev) => (prev ? { ...prev, language } : prev));
                              }
                            }
                          : handleLanguageChange
                      }
                      onFocusEditor={() => leftEditorInstanceRef.current?.focus()}
                      isSplit={isSplit}
                      paneColor='primary'
                      paneLabel={isSplit ? '1' : undefined}
                      dimmed={isSplit && focusedPane !== 'left'}
                    />
                    <Box sx={{ flex: 1, minHeight: 0 }}>
                      <Editor
                        editorInstanceRef={leftEditorInstanceRef}
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
                              await handleCloseFileWithSplit(leftFileNote);
                            } else if (leftNote) {
                              await handleArchiveNoteWithSplit(leftNote.id);
                            }
                          } else {
                            if (currentFileNote) {
                              await handleCloseFileWithSplit(currentFileNote);
                            } else if (currentNote) {
                              await handleArchiveNoteWithSplit(currentNote.id);
                            }
                          }
                        }}
                        onSelectNext={handleSelectNextAnyNote}
                        onSelectPrevious={handleSelectPreviousAnyNote}
                      />
                    </Box>
                  </Box>
                </Allotment.Pane>
                {isSplit && (
                  <Allotment.Pane minSize={200}>
                    <Box
                      data-pane='right'
                      sx={{
                        height: '100%',
                        display: 'flex',
                        flexDirection: 'column',
                        position: 'relative',
                        '--wails-drop-target': 'drop',
                        '&.wails-drop-target-active::after': {
                          content: '""',
                          position: 'absolute',
                          inset: 0,
                          backgroundColor: (theme) =>
                            theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)',
                          pointerEvents: 'none',
                          zIndex: 5,
                        },
                      }}
                    >
                      <PaneHeader
                        note={rightFileNote || rightNote}
                        languages={languages}
                        onActivatePane={() => handleFocusPane('right')}
                        onTitleChange={(title) => {
                          if (rightNote) {
                            handleRightNoteTitleChange(title);
                          }
                        }}
                        onLanguageChange={(language) => {
                          if (rightNote) {
                            handleRightNoteLanguageChange(language);
                          } else if (rightFileNote) {
                            // 非同期更新の取りこぼしを避けるため、関数型更新で現在値に対して適用する。
                            setRightFileNote((prev) => (prev ? { ...prev, language } : prev));
                          }
                        }}
                        onFocusEditor={() => rightEditorInstanceRef.current?.focus()}
                        isSplit={isSplit}
                        paneColor='secondary'
                        paneLabel='2'
                        dimmed={focusedPane !== 'right'}
                      />
                      <Box sx={{ flex: 1, minHeight: 0 }}>
                        <Editor
                          editorInstanceRef={rightEditorInstanceRef}
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
                              await handleCloseFileWithSplit(rightFileNote);
                            } else if (rightNote) {
                              await handleArchiveNoteWithSplit(rightNote.id);
                            }
                          }}
                          onSelectNext={handleSelectNextAnyNote}
                          onSelectPrevious={handleSelectPreviousAnyNote}
                        />
                      </Box>
                    </Box>
                  </Allotment.Pane>
                )}
                {isMarkdownPreview && !editorSettings.markdownPreviewOnLeft && (
                  <Allotment.Pane minSize={200}>
                    <MarkdownPreview editorInstanceRef={leftEditorInstanceRef} />
                  </Allotment.Pane>
                )}
              </Allotment>
            )}
            <EditorStatusBar
              editorInstanceRef={
                isSplit ? (focusedPane === 'left' ? leftEditorInstanceRef : rightEditorInstanceRef) : editorInstanceRef
              }
              isSplit={isSplit}
              isMarkdownPreview={isMarkdownPreview}
              canSplit={canSplit}
              onToggleSplit={handleToggleSplit}
              onToggleMarkdownPreview={toggleMarkdownPreview}
              onSettings={() => setIsSettingsOpen(true)}
              showMessage={showMessage}
            />
          </Box>
            </Allotment.Pane>
          </Allotment>
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
