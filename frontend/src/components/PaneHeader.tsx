import type { SelectProps, Theme } from '@mui/material';
import {
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
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
}: PaneHeaderProps) => {
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
    </Box>
  );
};
