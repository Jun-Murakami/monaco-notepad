import {
  Close,
  KeyboardArrowDown,
  KeyboardArrowUp,
  Search,
} from '@mui/icons-material';
import { Box, IconButton, InputAdornment, InputBase } from '@mui/material';
import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface NoteSearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  matchIndex: number;
  matchCount: number;
}

export const NoteSearchBox = ({
  value,
  onChange,
  onNext,
  onPrevious,
  matchIndex,
  matchCount,
}: NoteSearchBoxProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  const handleClear = useCallback(() => {
    onChange('');
    inputRef.current?.focus();
  }, [onChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.shiftKey ? onPrevious() : onNext();
      }
      if (e.key === 'Escape') {
        handleClear();
      }
    },
    [onNext, onPrevious, handleClear],
  );

  const hasQuery = value.length > 0;

  return (
    <Box
      sx={{
        borderBottom: 1,
        borderColor: 'divider',
        px: 1,
        py: 0.5,
        display: 'flex',
        alignItems: 'center',
        backgroundColor: 'background.paper',
      }}
    >
      <InputBase
        inputRef={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('search.placeholder')}
        size="small"
        sx={{
          width: '100%',
          fontSize: '0.8rem',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          '& .MuiInputBase-input': {
            py: 0.5,
            px: 0.5,
          },
        }}
        startAdornment={
          <InputAdornment position="start" sx={{ ml: 0.5, mr: 0 }}>
            <Search sx={{ fontSize: 16, color: 'text.secondary' }} />
          </InputAdornment>
        }
        endAdornment={
          hasQuery ? (
            <InputAdornment position="end" sx={{ mr: 0.25 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                <Box
                  component="span"
                  sx={{
                    fontSize: '0.7rem',
                    color: 'text.secondary',
                    whiteSpace: 'nowrap',
                    minWidth: 28,
                    textAlign: 'center',
                  }}
                >
                  {matchCount > 0 ? `${matchIndex}/${matchCount}` : '0/0'}
                </Box>
                <IconButton
                  size="small"
                  onClick={onPrevious}
                  disabled={matchCount === 0}
                  sx={{ p: 0.25 }}
                >
                  <KeyboardArrowUp sx={{ fontSize: 16 }} />
                </IconButton>
                <IconButton
                  size="small"
                  onClick={onNext}
                  disabled={matchCount === 0}
                  sx={{ p: 0.25 }}
                >
                  <KeyboardArrowDown sx={{ fontSize: 16 }} />
                </IconButton>
                <IconButton size="small" onClick={handleClear} sx={{ p: 0.25 }}>
                  <Close sx={{ fontSize: 14 }} />
                </IconButton>
              </Box>
            </InputAdornment>
          ) : null
        }
      />
    </Box>
  );
};
