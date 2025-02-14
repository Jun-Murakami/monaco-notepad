import { useEffect, useState } from 'react';
import { NotifyFrontendReady } from '../../wailsjs/go/backend/App';
import { getSupportedLanguages, LanguageInfo } from '../lib/monaco';
import * as runtime from '../../wailsjs/runtime';

export const useInitialize = () => {
  const [languages, setLanguages] = useState<LanguageInfo[]>([]);
  const [platform, setPlatform] = useState<string>('');

  useEffect(() => {
    const initialize = async () => {
      try {
        // プラットフォームを取得
        const env = await runtime.Environment();
        setPlatform(env.platform);

        // 言語一覧を取得
        setLanguages(getSupportedLanguages());
      } catch (error) {
        console.error('Failed to initialize:', error);
      }
    };
    initialize();

    // バックエンドの準備完了を待ってから通知
    const unsubscribe = runtime.EventsOn('backend:ready', () => {
      NotifyFrontendReady();
    });

    return () => {
      unsubscribe();
      setLanguages([]);
    };
  }, []);

  return {
    languages,
    platform,
  };
}; 