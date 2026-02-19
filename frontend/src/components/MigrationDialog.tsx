import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { RespondToMigration } from '../../wailsjs/go/backend/App';

interface MigrationDialogProps {
  open: boolean;
  onClose: () => void;
}

export const MigrationDialog = ({ open, onClose }: MigrationDialogProps) => {
  const { t } = useTranslation();

  const handleChoice = async (choice: string) => {
    onClose();
    await RespondToMigration(choice);
  };

  return (
    <Dialog
      open={open}
      onClose={() => handleChoice('skip')}
      aria-labelledby="migration-dialog-title"
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle id="migration-dialog-title">
        {t('migration.title')}
      </DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ whiteSpace: 'pre-line' }}>
          {t('migration.announcement')}
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ flexDirection: 'column', gap: 1, px: 3, pb: 2 }}>
        <Button
          fullWidth
          variant="contained"
          onClick={() => handleChoice('migrate_delete')}
        >
          {t('migration.migrateDelete')}
        </Button>
        <Button
          fullWidth
          variant="outlined"
          onClick={() => handleChoice('migrate_keep')}
        >
          {t('migration.migrateKeep')}
        </Button>
        <Button fullWidth onClick={() => handleChoice('skip')}>
          {t('migration.skip')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
