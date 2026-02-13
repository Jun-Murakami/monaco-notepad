import { FileOpen, NoteAdd, Save } from '@mui/icons-material';
import { Box, Button, Tooltip } from '@mui/material';

export const AppBar: React.FC<{
  platform: string;
  onNew: () => Promise<void>;
  onOpen: () => Promise<void>;
  onSave: () => Promise<void>;
}> = ({ platform, onNew, onOpen, onSave }) => {
  const commandKey = platform === 'darwin' ? 'Command' : 'Ctrl';

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
      <Tooltip title={`New (${commandKey} + N)`} arrow placement="bottom" style={{ flex: 1 }}>
        <Button
          sx={{ fontSize: 12, height: 32, width: '100%' }}
          startIcon={<NoteAdd sx={{ mr: -0.75 }} />}
          variant="contained"
          onClick={onNew}
        >
          New
        </Button>
      </Tooltip>
      <Tooltip title={`Open (${commandKey} + O)`} arrow placement="bottom" style={{ flex: 1 }}>
        <Button
          sx={{ fontSize: 12, height: 32, width: '100%' }}
          startIcon={<FileOpen sx={{ mr: -0.75 }} />}
          variant="contained"
          onClick={onOpen}
        >
          Open
        </Button>
      </Tooltip>
      <Tooltip title={`Save as (${commandKey} + S)`} arrow placement="bottom" style={{ flex: 1 }}>
        <Button
          sx={{ fontSize: 12, height: 32, width: '100%', whiteSpace: 'nowrap' }}
          startIcon={<Save sx={{ mr: -1 }} />}
          variant="contained"
          onClick={onSave}
        >
          Save as
        </Button>
      </Tooltip>
    </Box>
  );
};
