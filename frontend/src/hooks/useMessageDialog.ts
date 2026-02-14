import { useCallback, useEffect, useState } from 'react';
import * as wailsRuntime from '../../wailsjs/runtime';
import i18n from '../i18n';

export const useMessageDialog = () => {
  const [isMessageDialogOpen, setIsMessageDialogOpen] = useState(false);
  const [messageTitle, setMessageTitle] = useState('');
  const [messageContent, setMessageContent] = useState('');
  const [isTwoButton, setIsTwoButton] = useState(false);
  const [primaryButtonText, setPrimaryButtonText] = useState(
    () => i18n.t('dialog.ok'),
  );
  const [secondaryButtonText, setSecondaryButtonText] = useState(
    () => i18n.t('dialog.cancel'),
  );
  const [onResult, setOnResult] = useState<
    ((result: boolean) => Promise<void>) | null
  >(null);

  const showMessage = useCallback(
    (
      title: string,
      message: string,
      isTwoButton?: boolean,
      primaryButtonText?: string,
      secondaryButtonText?: string,
    ): Promise<boolean> => {
      return new Promise((resolve) => {
        setIsMessageDialogOpen(true);
        setMessageTitle(title);
        setMessageContent(message);
        setIsTwoButton(isTwoButton || false);
        setPrimaryButtonText(primaryButtonText || i18n.t('dialog.ok'));
        setSecondaryButtonText(secondaryButtonText || i18n.t('dialog.cancel'));
        setOnResult(() => async (result: boolean) => {
          setIsMessageDialogOpen(false);
          resolve(result);
        });
      });
    },
    [],
  );

  useEffect(() => {
    wailsRuntime.EventsOn(
      'show-message',
      (title: string, message: string, isTwoButton: boolean) => {
        showMessage(title, message, isTwoButton);
      },
    );

    return () => {
      wailsRuntime.EventsOff('show-message');
    };
  }, [showMessage]);

  return {
    isMessageDialogOpen,
    messageTitle,
    messageContent,
    isTwoButton,
    primaryButtonText,
    secondaryButtonText,
    showMessage,
    onResult,
    setOnResult,
  };
};
