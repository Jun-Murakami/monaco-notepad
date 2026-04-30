import { CssBaseline, ThemeProvider } from '@mui/material';

import { darkTheme, lightTheme } from '../lib/theme';
import { useEditorSettingsStore } from '../stores/useEditorSettingsStore';
import { DialogHost } from './DialogHost';
import { MessageDialog } from './MessageDialog';

import type { ReactNode } from 'react';

interface ProvidersProps {
  children: ReactNode;
}

// アプリのトップレベル provider 群。App.tsx は本来「機能 = ノート編集」の
// orchestrator に専念すべきで、Theme / CssBaseline / グローバルダイアログ群は
// ここに切り出して App の reactive surface から外す。
//
// ThemeProvider は editorSettings ストアを直接購読することで、テーマ切替時に
// App 配下の再描画を誘発しなくなる。
export const Providers = ({ children }: ProvidersProps) => {
  const isDarkMode = useEditorSettingsStore((s) => s.settings.isDarkMode);
  return (
    <ThemeProvider theme={isDarkMode ? darkTheme : lightTheme}>
      <CssBaseline />
      {children}
      <MessageDialog />
      <DialogHost />
    </ThemeProvider>
  );
};
