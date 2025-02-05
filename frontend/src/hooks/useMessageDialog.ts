import { useState, useEffect } from 'react';
import * as wailsRuntime from '../../wailsjs/runtime';

export const useMessageDialog = () => {
  const [isMessageDialogOpen, setIsMessageDialogOpen] = useState(false);
  const [messageTitle, setMessageTitle] = useState('');
  const [messageContent, setMessageContent] = useState('');
  const [isTwoButton, setIsTwoButton] = useState(false);
  const [onResult, setOnResult] = useState<((result: boolean) => Promise<void>) | null>(null);

  const showMessage = (title: string, message: string, isTwoButton?: boolean): Promise<boolean> => {
    return new Promise((resolve) => {
      setIsMessageDialogOpen(true);
      setMessageTitle(title);
      setMessageContent(message);
      setIsTwoButton(isTwoButton || false);
      setOnResult(() => async (result: boolean) => {
        setIsMessageDialogOpen(false);
        resolve(result);
      });
    });
  };

  useEffect(() => {
    wailsRuntime.EventsOn("show-message", (title: string, message: string, isTwoButton: boolean) => {
      showMessage(title, message, isTwoButton);
    });

    return () => {
      wailsRuntime.EventsOff("show-message");
    };
  }, [showMessage]);

  return { isMessageDialogOpen, messageTitle, messageContent, isTwoButton, showMessage, onResult, setOnResult };
};