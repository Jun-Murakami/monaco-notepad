import { FileOpen, NoteAdd, Save } from '@mui/icons-material';
import { Box, Button, Typography, Tooltip } from '@mui/material';
import { useTranslation } from 'react-i18next';

export const AppBar: React.FC<{
  platform: string;
  onNew: () => Promise<void>;
  onOpen: () => Promise<void>;
  onSave: () => Promise<void>;
}> = ({ platform, onNew, onOpen, onSave }) => {
  const commandKey = platform === 'darwin' ? 'Command' : 'Ctrl';
  const { t, i18n } = useTranslation();
  const isJapanese = i18n.resolvedLanguage?.startsWith('ja') ?? false;
  const buttonSx = {
    height: 32,
    width: '100%',
    minWidth: 0,
    px: isJapanese ? 0.375 : undefined,
    whiteSpace: 'nowrap',
    '& .MuiButton-startIcon': {
      marginLeft: 0,
      marginRight: isJapanese ? 0.5 : 0.2,
    },
    '& .MuiSvgIcon-root': {
      fontSize: isJapanese ? 18 : 16,
    },
  } as const;
  const labelSx = {
    whiteSpace: 'nowrap',
    display: 'block',
    lineHeight: 1,
    fontSize: isJapanese ? 14 : 12,
  } as const;

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'flex-start',
        alignItems: 'center',
        gap: 1,
        p: 1,
      }}
    >
      <Tooltip title={t('toolbar.newShortcut', { shortcut: commandKey })} arrow placement='bottom' style={{ flex: 1 }}>
        <Button sx={buttonSx} startIcon={<NoteAdd />} variant='contained' onClick={onNew}>
          <Typography component='span' sx={labelSx}>
            {t('toolbar.new')}
          </Typography>
        </Button>
      </Tooltip>
      <Tooltip title={t('toolbar.openShortcut', { shortcut: commandKey })} arrow placement='bottom' style={{ flex: 1 }}>
        <Button sx={buttonSx} startIcon={<FileOpen />} variant='contained' onClick={onOpen}>
          <Typography component='span' sx={labelSx}>
            {t('toolbar.open')}
          </Typography>
        </Button>
      </Tooltip>
      <Tooltip title={t('toolbar.saveAsShortcut', { shortcut: commandKey })} arrow placement='bottom' style={{ flex: 1 }}>
        <Button sx={buttonSx} startIcon={<Save />} variant='contained' onClick={onSave}>
          <Typography component='span' sx={labelSx}>
            {t('toolbar.saveAs')}
          </Typography>
        </Button>
      </Tooltip>
    </Box>
  );
};
