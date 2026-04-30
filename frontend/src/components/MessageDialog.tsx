import { useTranslation } from 'react-i18next';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
} from '@mui/material';

import { Console } from '../../wailsjs/go/backend/App';
import { useMessageDialogStore } from '../stores/useMessageDialogStore';

// グローバルに 1 つだけ存在する確認/通知ダイアログ。
// 状態は useMessageDialogStore (Zustand) から購読し、props は受け取らない。
// 呼び出し側は `showMessage(...)` を import するだけで Promise<boolean> を得られる。
export const MessageDialog = () => {
  const { t } = useTranslation();
  const isOpen = useMessageDialogStore((s) => s.isOpen);
  const title = useMessageDialogStore((s) => s.title);
  const message = useMessageDialogStore((s) => s.message);
  const isTwoButton = useMessageDialogStore((s) => s.isTwoButton);
  const primaryButtonText = useMessageDialogStore((s) => s.primaryButtonText);
  const secondaryButtonText = useMessageDialogStore(
    (s) => s.secondaryButtonText,
  );
  const resolveResult = useMessageDialogStore((s) => s.resolveResult);

  const handleClose = async (result: boolean) => {
    try {
      resolveResult(result);
    } catch (error) {
      if (error instanceof Error) {
        await Console('Dialog close error:', [error.message]);
      } else {
        await Console('Dialog close error:', [String(error)]);
      }
    }
  };

  return (
    <Dialog
      open={isOpen}
      onClose={() => handleClose(false)}
      aria-labelledby="message-dialog-title"
      aria-describedby="message-dialog-description"
      disableRestoreFocus
    >
      <DialogTitle id="message-dialog-title">{title}</DialogTitle>
      <DialogContent
        id="message-dialog-description"
        sx={{ whiteSpace: 'pre-line' }}
      >
        {message}
      </DialogContent>
      <DialogActions>
        {isTwoButton && (
          <Button onClick={() => handleClose(false)} autoFocus={!isTwoButton}>
            {secondaryButtonText}
          </Button>
        )}
        <Button
          onClick={() => handleClose(true)}
          variant="contained"
          autoFocus={isTwoButton}
        >
          {isTwoButton ? primaryButtonText : t('dialog.close')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
