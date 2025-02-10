import React from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button } from '@mui/material';
import { Console } from '../../wailsjs/go/backend/App';

interface MessageDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  isTwoButton?: boolean;
  onResult: ((result: boolean) => Promise<void>) | null;
}

export const MessageDialog: React.FC<MessageDialogProps> = ({ isOpen, title, message, isTwoButton, onResult }) => {
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
      aria-labelledby='message-dialog-title'
      aria-describedby='message-dialog-description'
      disableRestoreFocus
    >
      <DialogTitle id='message-dialog-title'>{title}</DialogTitle>
      <DialogContent id='message-dialog-description'>{message}</DialogContent>
      <DialogActions>
        {isTwoButton && (
          <Button onClick={() => handleClose(false)} autoFocus={!isTwoButton}>
            Cancel
          </Button>
        )}
        <Button onClick={() => handleClose(true)} variant='contained' autoFocus={isTwoButton}>
          {isTwoButton ? 'OK' : 'Close'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
