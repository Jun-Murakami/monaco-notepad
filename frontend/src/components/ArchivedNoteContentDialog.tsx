import {
  ArrowBack,
  ArrowForward,
  Close,
  DeleteForever,
  Unarchive,
} from '@mui/icons-material';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Typography,
} from '@mui/material';
import * as monaco from 'monaco-editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LoadArchivedNote } from '../../wailsjs/go/backend/App';
import type { Note } from '../types';
import dayjs from '../utils/dayjs';

interface ArchivedNoteContentDialogProps {
  open: boolean;
  note: Note | null;
  onClose: () => void;
  onRestore: (noteId: string) => void;
  onDelete: (noteId: string) => void;
  isDarkMode: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  hasPrevious?: boolean;
  hasNext?: boolean;
}

export const ArchivedNoteContentDialog: React.FC<
  ArchivedNoteContentDialogProps
> = ({
  open,
  note,
  onClose,
  onRestore,
  onDelete,
  isDarkMode,
  onPrevious,
  onNext,
  hasPrevious = false,
  hasNext = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState('');

  const getNoteTitle = useCallback(
    (n: Note): { text: string; isFallback: boolean } => {
      if (n.title.trim()) return { text: n.title, isFallback: false };
      if (n.contentHeader) {
        return {
          text: n.contentHeader.replace(/\r\n|\n|\r/g, ' ').slice(0, 30),
          isFallback: true,
        };
      }
      return { text: 'Empty Note', isFallback: true };
    },
    [],
  );

  useEffect(() => {
    if (!open || !note) {
      setContent('');
      return;
    }
    setLoading(true);
    LoadArchivedNote(note.id)
      .then((loaded) => {
        setContent(loaded?.content || '');
      })
      .catch(() => setContent(''))
      .finally(() => setLoading(false));
  }, [open, note]);

  useEffect(() => {
    if (!open || loading || !containerRef.current) return;

    const editor = monaco.editor.create(containerRef.current, {
      value: content,
      language: note?.language || 'plaintext',
      readOnly: true,
      domReadOnly: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      theme: isDarkMode ? 'vs-dark' : 'vs',
      automaticLayout: true,
      lineNumbers: 'on',
      folding: true,
      wordWrap: 'on',
    });
    editorRef.current = editor;

    return () => {
      editor.dispose();
      editorRef.current = null;
    };
  }, [open, loading, content, note?.language, isDarkMode]);

  const handleRestore = () => {
    if (note) {
      onRestore(note.id);
    }
  };

  const handleDelete = () => {
    if (note) {
      onDelete(note.id);
    }
  };

  if (!note) return null;

  const titleInfo = getNoteTitle(note);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      disableRestoreFocus
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="h6"
            noWrap
            sx={{
              fontStyle: titleInfo.isFallback ? 'italic' : 'normal',
              opacity: titleInfo.isFallback ? 0.6 : 1,
            }}
          >
            {titleInfo.text}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {dayjs(note.modifiedTime).format('L HH:mm:ss')}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 0.5, ml: 'auto' }}>
          <IconButton onClick={onPrevious} disabled={!hasPrevious} size="small">
            <ArrowBack />
          </IconButton>
          <IconButton onClick={onNext} disabled={!hasNext} size="small">
            <ArrowForward />
          </IconButton>
        </Box>
        <IconButton onClick={onClose}>
          <Close />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ p: 0 }}>
        {loading ? (
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              height: '60vh',
            }}
          >
            <CircularProgress />
          </Box>
        ) : (
          <Box ref={containerRef} sx={{ height: '60vh', width: '100%' }} />
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button
          onClick={handleRestore}
          color="primary"
          variant="contained"
          startIcon={<Unarchive />}
        >
          Restore
        </Button>
        <Button
          onClick={handleDelete}
          color="error"
          variant="outlined"
          startIcon={<DeleteForever />}
        >
          Delete
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose} variant="outlined">
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
};
