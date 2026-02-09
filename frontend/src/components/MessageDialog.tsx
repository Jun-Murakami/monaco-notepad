import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
} from '@mui/material';
import { Console } from '../../wailsjs/go/backend/App';

interface MessageDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  isTwoButton?: boolean;
  primaryButtonText?: string;
  secondaryButtonText?: string;
  onResult: ((result: boolean) => Promise<void>) | null;
}

export const MessageDialog = ({
  isOpen,
  title,
  message,
  isTwoButton,
  primaryButtonText,
  secondaryButtonText,
  onResult,
}: MessageDialogProps) => {
  const handleClose = async (result: boolean) => {
    try {
      await onResult?.(result);
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
      <DialogContent id="message-dialog-description">{message}</DialogContent>
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
          {isTwoButton ? primaryButtonText : 'Close'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
