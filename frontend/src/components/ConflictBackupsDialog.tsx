import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Close,
  DeleteForever,
  DeleteSweep,
  RestoreFromTrash,
} from '@mui/icons-material';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  Typography,
} from '@mui/material';
import * as monaco from 'monaco-editor';
import SimpleBar from 'simplebar-react';
import 'simplebar-react/dist/simplebar.min.css';

import {
  DeleteAllCloudConflictBackups,
  DeleteCloudConflictBackup,
  ListCloudConflictBackups,
} from '../../wailsjs/go/backend/App';
import { DEFAULT_EDITOR_FONT_FAMILY, type Note } from '../types';
import dayjs from '../utils/dayjs';

import type { backend } from '../../wailsjs/go/models';

type Entry = backend.ConflictBackupEntry;

interface ConflictBackupsDialogProps {
  open: boolean;
  onClose: () => void;
  onRestore: (sourceNote: Note) => Promise<void>;
  showMessage: (
    title: string,
    message: string,
    isTwoButton?: boolean,
  ) => Promise<boolean>;
  isDarkMode: boolean;
}

export const ConflictBackupsDialog: React.FC<ConflictBackupsDialogProps> = ({
  open,
  onClose,
  onRestore,
  showMessage,
  isDarkMode,
}) => {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await ListCloudConflictBackups();
      setEntries(list);
      setSelected((prev) => {
        if (!prev) return list[0] ?? null;
        const found = list.find((e) => e.id === prev.id);
        return found ?? list[0] ?? null;
      });
    } catch (e) {
      await showMessage(
        t('conflictBackups.title'),
        t('conflictBackups.loadError', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [showMessage, t]);

  // 開いた時にロード、閉じた時に状態をリセット
  useEffect(() => {
    if (!open) {
      setEntries([]);
      setSelected(null);
      return;
    }
    void reload();
  }, [open, reload]);

  // Monaco エディタの生成。選択 / テーマ / 開閉が変わるたびに作り直す
  // (display:none の状態で create するとレイアウトを正しく取れず描画されない問題があるため、
  //  選択中のときだけマウントしてその都度生成する単純なパターンに揃える)
  useEffect(() => {
    if (!open || !selected) return;
    const container = previewContainerRef.current;
    if (!container) return;
    const editor = monaco.editor.create(container, {
      value: selected.note?.content ?? '',
      language: selected.note?.language || 'plaintext',
      readOnly: true,
      domReadOnly: true,
      fontFamily: DEFAULT_EDITOR_FONT_FAMILY,
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
  }, [open, selected, isDarkMode]);

  const formattedSelectedDate = useMemo(() => {
    if (!selected?.createdAt) return '';
    const d = dayjs(selected.createdAt);
    return d.isValid() ? d.format('L HH:mm:ss') : selected.createdAt;
  }, [selected]);

  const noteDisplayTitle = useCallback(
    (entry: Entry): string => {
      const title = entry.note?.title?.trim();
      if (title) return title;
      const header = entry.note?.contentHeader?.trim();
      if (header) {
        return header.replace(/\r\n|\n|\r/g, ' ').slice(0, 40);
      }
      return t('notes.emptyNote');
    },
    [t],
  );

  const handleDelete = async () => {
    if (!selected) return;
    const confirmed = await showMessage(
      t('conflictBackups.deleteTitle'),
      t('conflictBackups.deleteMessage'),
      true,
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await DeleteCloudConflictBackup(selected.filename);
      // 削除されたものが選択中なら次の項目を選択させる
      setSelected(null);
      await reload();
    } catch (e) {
      await showMessage(
        t('conflictBackups.deleteTitle'),
        t('conflictBackups.deleteError', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteAll = async () => {
    if (entries.length === 0) return;
    const confirmed = await showMessage(
      t('conflictBackups.deleteAllTitle'),
      t('conflictBackups.deleteAllMessage'),
      true,
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await DeleteAllCloudConflictBackups();
      setSelected(null);
      await reload();
    } catch (e) {
      await showMessage(
        t('conflictBackups.deleteAllTitle'),
        t('conflictBackups.deleteError', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    if (!selected?.note) return;
    setBusy(true);
    try {
      await onRestore(selected.note);
      onClose();
    } catch (e) {
      await showMessage(
        t('conflictBackups.title'),
        t('conflictBackups.restoreError', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      disableRestoreFocus
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6">{t('conflictBackups.title')}</Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 0.5 }}
          >
            {t('conflictBackups.description')}
          </Typography>
        </Box>
        <IconButton onClick={onClose} size="small" sx={{ mt: -0.5 }}>
          <Close />
        </IconButton>
      </DialogTitle>
      <DialogContent
        sx={{
          p: 0,
          height: '60vh',
          display: 'flex',
          borderTop: 1,
          borderColor: 'divider',
        }}
      >
        {/* 左ペイン: バックアップ一覧 */}
        <Box
          sx={{
            width: 320,
            flexShrink: 0,
            borderRight: 1,
            borderColor: 'divider',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            '& .simplebar-track.simplebar-vertical .simplebar-scrollbar:before':
              {
                backgroundColor: 'text.secondary',
              },
          }}
        >
          <SimpleBar style={{ height: '100%' }}>
            {loading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
                <CircularProgress size={28} />
              </Box>
            ) : entries.length === 0 ? (
              <Box sx={{ p: 3, textAlign: 'center' }}>
                <Typography variant="body2" color="text.secondary">
                  {t('conflictBackups.empty')}
                </Typography>
              </Box>
            ) : (
              <List disablePadding>
                {entries.map((entry) => (
                  <ListItemButton
                    key={entry.id}
                    selected={selected?.id === entry.id}
                    onClick={() => setSelected(entry)}
                    sx={{
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      py: 1,
                      borderBottom: 1,
                      borderColor: 'divider',
                    }}
                  >
                    <Typography
                      variant="body2"
                      sx={{
                        width: '100%',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontWeight: 500,
                      }}
                    >
                      {noteDisplayTitle(entry)}
                    </Typography>
                    <Box
                      sx={{
                        display: 'flex',
                        flexDirection: 'row',
                        gap: 0.5,
                        alignItems: 'center',
                        mt: 0.5,
                        flexWrap: 'wrap',
                      }}
                    >
                      <Chip
                        label={t(`conflictBackups.kind_${entry.kind}` as const)}
                        size="small"
                        color={
                          entry.kind === 'cloud_delete' ? 'warning' : 'default'
                        }
                        variant="outlined"
                        sx={{ height: 20, fontSize: 10 }}
                      />
                      <Typography variant="caption" color="text.secondary">
                        {entry.createdAt
                          ? dayjs(entry.createdAt).isValid()
                            ? dayjs(entry.createdAt).format('L HH:mm')
                            : ''
                          : ''}
                      </Typography>
                    </Box>
                  </ListItemButton>
                ))}
              </List>
            )}
          </SimpleBar>
        </Box>
        {/* 右ペイン: プレビュー */}
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {selected ? (
            <Box
              sx={{
                px: 2,
                py: 1,
                borderBottom: 1,
                borderColor: 'divider',
                display: 'flex',
                flexDirection: 'column',
                gap: 0.5,
              }}
            >
              <Typography
                variant="subtitle2"
                noWrap
                title={noteDisplayTitle(selected)}
              >
                {noteDisplayTitle(selected)}
              </Typography>
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: 'row',
                  gap: 1,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <Chip
                  label={t(`conflictBackups.kind_${selected.kind}` as const)}
                  size="small"
                  color={
                    selected.kind === 'cloud_delete' ? 'warning' : 'default'
                  }
                  variant="outlined"
                />
                <Typography variant="caption" color="text.secondary">
                  {formattedSelectedDate}
                </Typography>
                {selected.note?.language && (
                  <Typography variant="caption" color="text.secondary">
                    · {selected.note.language}
                  </Typography>
                )}
              </Box>
            </Box>
          ) : entries.length > 0 ? (
            <Box
              sx={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'text.secondary',
              }}
            >
              <Typography variant="body2">
                {t('conflictBackups.selectPrompt')}
              </Typography>
            </Box>
          ) : null}
          {selected ? (
            selected.note?.content ? (
              // エディタは選択時のみマウントして毎回再生成する
              // (display:none で create すると Monaco がレイアウトを取れない)
              <Box ref={previewContainerRef} sx={{ flex: 1, minHeight: 0 }} />
            ) : (
              <Box
                sx={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'text.secondary',
                }}
              >
                <Typography variant="body2">
                  {t('conflictBackups.noPreview')}
                </Typography>
              </Box>
            )
          ) : null}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button
          onClick={handleDeleteAll}
          color="error"
          variant="outlined"
          startIcon={<DeleteSweep />}
          disabled={busy || entries.length === 0}
        >
          {t('conflictBackups.deleteAll')}
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button
          onClick={handleDelete}
          color="error"
          variant="outlined"
          startIcon={<DeleteForever />}
          disabled={busy || !selected}
        >
          {t('conflictBackups.delete')}
        </Button>
        <Button
          onClick={handleRestore}
          color="primary"
          variant="contained"
          startIcon={<RestoreFromTrash />}
          disabled={busy || !selected}
        >
          {t('conflictBackups.restore')}
        </Button>
        <Button onClick={onClose} variant="outlined" disabled={busy}>
          {t('dialog.close')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
