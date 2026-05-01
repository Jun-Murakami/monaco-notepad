import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  Close,
  KeyboardArrowDown,
  KeyboardArrowUp,
} from '@mui/icons-material';
import {
  Box,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';

import { useTitleFocusToken } from '../stores/useCurrentNoteStore';

import type { SelectProps, Theme } from '@mui/material';
import type { LanguageInfo } from '../lib/monaco';
import type { FileNote, Note } from '../types';

const scrollbarSx = (theme: Theme) => ({
  '&::-webkit-scrollbar': { width: 7 },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
  '&::-webkit-scrollbar-thumb': {
    backgroundColor:
      theme.palette.mode === 'dark'
        ? 'rgba(255,255,255,0.3)'
        : 'rgba(0,0,0,0.3)',
    borderRadius: 7,
    '&:hover': {
      backgroundColor:
        theme.palette.mode === 'dark'
          ? 'rgba(255,255,255,0.5)'
          : 'rgba(0,0,0,0.5)',
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

const isFileNote = (note: Note | FileNote | null): note is FileNote =>
  note !== null && 'filePath' in note;

interface PaneHeaderProps {
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
  onSelectPrevious?: () => void;
  onSelectNext?: () => void;
  canSelectAdjacent?: boolean;
  onClose?: () => void;
  platform?: string;
}

export const PaneHeader = ({
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
  onSelectPrevious,
  onSelectNext,
  canSelectAdjacent,
  onClose,
  platform,
}: PaneHeaderProps) => {
  const { t } = useTranslation();
  const commandKey = platform === 'darwin' ? 'Command' : 'Ctrl';
  const isFile = isFileNote(note);
  const closeShortcutLabel = isFile
    ? t('notes.closeShortcut', { shortcut: commandKey })
    : t('notes.archiveShortcut', { shortcut: commandKey });

  // 新規ノート作成等で外部からタイトル欄にフォーカスを要求されたとき、
  // フォーカスされている (dimmed=false) ペインの本ヘッダーがそれを受け取って
  // input にフォーカス + 全選択する。FileNote のときは disabled なのでスキップ。
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleFocusToken = useTitleFocusToken();
  useEffect(() => {
    if (titleFocusToken === 0) return; // 初期値は無視
    if (dimmed) return;
    if (isFile) return;
    requestAnimationFrame(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    });
  }, [titleFocusToken, dimmed, isFile]);

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
              border: (theme) =>
                `2px solid ${theme.palette[paneColor || 'primary'].main}`,
              backgroundColor: (theme) =>
                `${theme.palette[paneColor || 'primary'].main}20`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Typography
              variant="body2"
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
            variant="body2"
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
        inputRef={titleInputRef}
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
        variant="outlined"
        size="small"
        value={
          isFileNote(note) ? note.filePath : (note as Note | null)?.title || ''
        }
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
          minWidth: 100,
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
        size="small"
      >
        <InputLabel size="small">{t('app.language')}</InputLabel>
        <Select
          size="small"
          autoWidth
          value={
            languages.some((lang) => lang.id === note?.language)
              ? note?.language
              : ''
          }
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
      {(onSelectPrevious || onSelectNext) && (
        <Box sx={{ display: 'flex', flexShrink: 0 }}>
          <Tooltip
            arrow
            title={t('app.selectPreviousNote', { shortcut: commandKey })}
          >
            <span>
              <IconButton
                size="small"
                onClick={() => {
                  onActivatePane?.();
                  onSelectPrevious?.();
                }}
                disabled={!canSelectAdjacent || !onSelectPrevious}
                sx={{
                  p: 0.25,
                  ...(isSplit &&
                    paneColor && {
                      color: `${paneColor}.main`,
                    }),
                }}
              >
                <KeyboardArrowUp sx={{ fontSize: 20 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip
            arrow
            title={t('app.selectNextNote', { shortcut: commandKey })}
          >
            <span>
              <IconButton
                size="small"
                onClick={() => {
                  onActivatePane?.();
                  onSelectNext?.();
                }}
                disabled={!canSelectAdjacent || !onSelectNext}
                sx={{
                  p: 0.25,
                  ...(isSplit &&
                    paneColor && {
                      color: `${paneColor}.main`,
                    }),
                }}
              >
                <KeyboardArrowDown sx={{ fontSize: 20 }} />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      )}
      {onClose && note && (
        <Tooltip arrow title={closeShortcutLabel}>
          <span>
            <IconButton
              size="small"
              onClick={() => {
                onActivatePane?.();
                onClose();
              }}
              sx={{
                flexShrink: 0,
                p: 0.5,
                ...(isSplit &&
                  paneColor && {
                    color: `${paneColor}.main`,
                  }),
              }}
            >
              {isFile ? (
                <Close sx={{ fontSize: 18 }} />
              ) : (
                <Archive sx={{ fontSize: 18 }} />
              )}
            </IconButton>
          </span>
        </Tooltip>
      )}
    </Box>
  );
};
