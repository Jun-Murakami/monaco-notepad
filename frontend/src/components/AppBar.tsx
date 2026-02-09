import { FileOpen, Flip, Logout, NoteAdd, Save, Settings } from '@mui/icons-material';
import CloudDoneIcon from '@mui/icons-material/CloudDone';
import CloudSyncIcon from '@mui/icons-material/CloudSync';
import {
  Box,
  Button,
  CircularProgress,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import type { SelectProps } from '@mui/material';
import { keyframes } from '@mui/system';
import { useDriveSync } from '../hooks/useDriveSync';
import type { LanguageInfo } from '../lib/monaco';
import type { EditorPane, FileNote, Note } from '../types';
import { GoogleDriveIcon, MarkdownIcon } from './Icons';

const scrollbarSx = (theme: import('@mui/material').Theme) => ({
  '&::-webkit-scrollbar': {
    width: 7,
  },
  '&::-webkit-scrollbar-track': {
    background: 'transparent',
  },
  '&::-webkit-scrollbar-thumb': {
    backgroundColor: theme.palette.mode === 'dark'
      ? 'rgba(255,255,255,0.3)'
      : 'rgba(0,0,0,0.3)',
    borderRadius: 7,
    '&:hover': {
      backgroundColor: theme.palette.mode === 'dark'
        ? 'rgba(255,255,255,0.5)'
        : 'rgba(0,0,0,0.5)',
    },
  },
});

const languageMenuProps: SelectProps['MenuProps'] = {
  slotProps: {
    paper: {
      sx: (theme) => ({
        maxHeight: 300,
        ...scrollbarSx(theme),
        '& ul': scrollbarSx(theme),
      }),
    },
  },
};

const fadeAnimation = keyframes`
  0% { opacity: 1; }
  50% { opacity: 0.4; }
  100% { opacity: 1; }
`;

export const AppBar: React.FC<{
  currentNote: Note | FileNote | null;
  languages: LanguageInfo[];
  platform: string;
  onTitleChange: (title: string) => void;
  onLanguageChange: (language: string) => void;
  onSettings: () => void;
  onNew: () => Promise<void>;
  onOpen: () => Promise<void>;
  onSave: () => Promise<void>;
  onFocusEditor?: () => void;
  showMessage: (
    title: string,
    message: string,
    isTwoButton?: boolean,
  ) => Promise<boolean>;
  isSplit?: boolean;
  isMarkdownPreview?: boolean;
  onToggleSplit?: () => void;
  onToggleMarkdownPreview?: () => void;
  rightNote?: Note | FileNote | null;
  onRightTitleChange?: (title: string) => void;
  onRightLanguageChange?: (language: string) => void;
  focusedPane?: EditorPane;
}> = ({
  currentNote,
  languages,
  platform,
  onTitleChange,
  onLanguageChange,
  onSettings,
  onNew,
  onOpen,
  onSave,
  onFocusEditor,
  showMessage,
  isSplit = false,
  isMarkdownPreview = false,
  onToggleSplit,
  onToggleMarkdownPreview,
  rightNote = null,
  onRightTitleChange,
  onRightLanguageChange,
  focusedPane = 'left',
}) => {
  const {
    syncStatus,
    isHoveringSync,
    setIsHoveringSync,
    isHoverLocked,
    handleGoogleAuth,
    handleLogout,
    handleSyncNow,
  } = useDriveSync(showMessage);

  const isFileNote = (note: Note | FileNote | null): note is FileNote => {
    return note !== null && 'filePath' in note;
  };

  const commandKey = platform === 'darwin' ? 'Command' : 'Ctrl';

  return (
    <Box
      sx={{
        height: 56,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
      }}
    >
      <Box
        sx={{
          height: 40,
          p: 1,
          display: 'flex',
          justifyContent: 'flex-start',
          alignItems: 'center',
          gap: 1,
        }}
      >
        <Tooltip title={`New (${commandKey} + N)`} arrow placement="bottom">
          <Button
            sx={{ fontSize: 12, width: 70, height: 32 }}
            startIcon={<NoteAdd sx={{ mr: -0.75 }} />}
            variant="contained"
            onClick={onNew}
          >
            New
          </Button>
        </Tooltip>
        <Tooltip title={`Open (${commandKey} + O)`} arrow placement="bottom">
          <Button
            sx={{ fontSize: 12, width: 70, height: 32 }}
            startIcon={<FileOpen sx={{ mr: -0.75 }} />}
            variant="contained"
            onClick={onOpen}
          >
            Open
          </Button>
        </Tooltip>
        <Tooltip title={`Save as (${commandKey} + S)`} arrow placement="bottom">
          <Button
            sx={{ fontSize: 12, width: 70, height: 32, whiteSpace: 'nowrap' }}
            startIcon={<Save sx={{ mr: -1 }} />}
            variant="contained"
            onClick={onSave}
          >
            Save as
          </Button>
        </Tooltip>
      </Box>
      <Box
        sx={{
          width: '100%',
          height: 70,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          opacity: isSplit && focusedPane !== 'left' ? 0.5 : 1,
          transition: 'opacity 0.2s',
          mr: isSplit ? 2 : 0,
        }}
      >
        {isSplit && <Typography variant="body2" sx={{ flexShrink: 0, fontWeight: 'bold', color: 'primary.main' }}>1</Typography>}
        <TextField
          sx={{
            width: '100%',
            ...(isSplit && {
              '& .MuiOutlinedInput-root': {
                '& fieldset': { borderColor: 'primary.main' },
                '&:hover fieldset': { borderColor: 'primary.main' },
              },
              '& .MuiInputLabel-root': { color: 'primary.main' },
            }),
          }}
          label={isFileNote(currentNote) ? 'File Path' : 'Title'}
          variant="outlined"
          size="small"
          value={
            isFileNote(currentNote)
              ? currentNote.filePath
              : currentNote?.title || ''
          }
          onChange={(e) => onTitleChange(e.target.value)}
          disabled={isFileNote(currentNote)}
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
            width: isSplit ? 140 : 200,
            flexShrink: 0,
            ...(isSplit && {
              '& .MuiOutlinedInput-root': {
                '& fieldset': { borderColor: 'primary.main' },
                '&:hover fieldset': { borderColor: 'primary.main' },
              },
              '& .MuiInputLabel-root': { color: 'primary.main' },
            }),
          }}
          size="small"
        >
          <InputLabel size="small">Language</InputLabel>
          <Select
            size="small"
            autoWidth
            value={
              languages.some((lang) => lang.id === currentNote?.language)
                ? currentNote?.language
                : ''
            }
            onChange={(e) => onLanguageChange(e.target.value)}
            label="Language"
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
      {isSplit && (
        <Box
          sx={{
          height: 70,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          width: '100%',
          opacity: focusedPane !== 'right' ? 0.5 : 1,
          transition: 'opacity 0.2s',
          }}
        >
          <Typography variant="body2" sx={{ flexShrink: 0, fontWeight: 'bold', color: 'secondary.main' }}>2</Typography>
          <TextField
            sx={{
              width: '100%',
              '& .MuiOutlinedInput-root': {
                '& fieldset': { borderColor: 'secondary.main' },
                '&:hover fieldset': { borderColor: 'secondary.main' },
              },
              '& .MuiInputLabel-root': { color: 'secondary.main' },
            }}
            label={isFileNote(rightNote) ? 'File Path' : 'Title'}
            variant="outlined"
            size="small"
            value={
              isFileNote(rightNote)
                ? rightNote.filePath
                : (rightNote as Note | null)?.title || ''
            }
            onChange={(e) => onRightTitleChange?.(e.target.value)}
            disabled={isFileNote(rightNote)}
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
              width: 140,
              flexShrink: 0,
              '& .MuiOutlinedInput-root': {
                '& fieldset': { borderColor: 'secondary.main' },
                '&:hover fieldset': { borderColor: 'secondary.main' },
              },
              '& .MuiInputLabel-root': { color: 'secondary.main' },
            }}
            size="small"
          >
            <InputLabel size="small">Language</InputLabel>
            <Select
              size="small"
              autoWidth
              value={
                languages.some((lang) => lang.id === rightNote?.language)
                  ? rightNote?.language
                  : ''
              }
              onChange={(e) => onRightLanguageChange?.(e.target.value)}
              label="Language"
              MenuProps={languageMenuProps}
            >
              {languages.map((lang) => (
                <MenuItem key={`right-${lang.id}`} value={lang.id}>
                  {lang.aliases?.[0] ?? lang.id}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
      )}
      <Box
        sx={{
          height: 40,
          p: 1,
          gap: 1,
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
        }}
      >
        <Tooltip title={isSplit ? 'Close Split' : 'Split Editor'} arrow>
          <IconButton
            sx={{ fontSize: 16, width: 32, height: 32 }}
            onClick={onToggleSplit}
            color={isSplit ? 'primary' : 'default'}
          >
            <Flip />
          </IconButton>
        </Tooltip>
        <Tooltip title={isMarkdownPreview ? 'Close Preview' : 'Markdown Preview'} arrow>
          <IconButton
            sx={{ fontSize: 16, width: 32, height: 32 }}
            onClick={onToggleMarkdownPreview}
            color={isMarkdownPreview ? 'primary' : 'default'}
          >
            <MarkdownIcon />
          </IconButton>
        </Tooltip>

        <Box sx={{ ml: 0.5, display: 'flex', alignItems: 'center' }}>
          {syncStatus === 'synced' ? (
            <Tooltip title="Sync now!" arrow>
              <IconButton
                onClick={handleSyncNow}
                size="small"
                onMouseEnter={() => !isHoverLocked && setIsHoveringSync(true)}
                onMouseLeave={() => setIsHoveringSync(false)}
              >
                {isHoveringSync ? (
                  <CloudSyncIcon
                    color="primary"
                    sx={{ fontSize: 27, ml: -0.4 }}
                  />
                ) : (
                  <CloudDoneIcon color="primary" sx={{ fontSize: 24 }} />
                )}
              </IconButton>
            </Tooltip>
          ) : syncStatus === 'syncing' ? (
            <Tooltip title="Syncing..." arrow>
              <Box
                sx={{
                  animation: `${fadeAnimation} 1.5s ease-in-out infinite`,
                  mt: 1,
                  mx: 0.625,
                }}
              >
                <CircularProgress size={24} />
              </Box>
            </Tooltip>
          ) : (
            syncStatus === 'logging in' && <CircularProgress size={24} />
          )}
        </Box>
        {syncStatus === 'offline' ? (
          <Tooltip title="Connect to Google Drive" arrow>
            <IconButton
              sx={{ fontSize: 16, width: 32, height: 32, ml: -1 }}
              onClick={handleGoogleAuth}
            >
              <GoogleDriveIcon sx={{ fontSize: 20 }} />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip
            title={syncStatus === 'logging in' ? 'Cancel' : 'Logout'}
            arrow
          >
            <span>
              <IconButton
                disabled={syncStatus === 'syncing'}
                onClick={handleLogout}
                sx={{ fontSize: 16, ml: 0.5, width: 32, height: 32 }}
              >
                <Logout />
              </IconButton>
            </span>
          </Tooltip>
        )}

        <Tooltip title="Settings" arrow>
          <IconButton
            sx={{ fontSize: 16, width: 32, height: 32 }}
            onClick={onSettings}
          >
            <Settings />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
};
