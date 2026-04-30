import React, { Suspense } from 'react';

import { useDialogsStore } from '../stores/useDialogsStore';

const SettingsDialog = React.lazy(() =>
  import('./SettingsDialog').then((m) => ({ default: m.SettingsDialog })),
);
const LicenseDialog = React.lazy(() =>
  import('./LicenseDialog').then((m) => ({ default: m.LicenseDialog })),
);
const ConflictBackupsDialog = React.lazy(() =>
  import('./ConflictBackupsDialog').then((m) => ({
    default: m.ConflictBackupsDialog,
  })),
);

// アプリ全体のセカンダリダイアログをまとめてホストする。
// App.tsx から切り出すことで、ダイアログ開閉や中身のロジックが App の
// reactive surface に乗らなくなる（Profiler で App を選んでも巨大化しない）。
//
// SettingsDialog は再オープン時に内部 state（localSettings 等）を初期化したいので、
// settingsKey を key prop に渡して remount させる。
export const DialogHost: React.FC = () => {
  const settingsKey = useDialogsStore((s) => s.settingsKey);
  return (
    <>
      <Suspense fallback={null}>
        <SettingsDialog key={settingsKey} />
      </Suspense>
      <Suspense fallback={null}>
        <LicenseDialog />
      </Suspense>
      <Suspense fallback={null}>
        <ConflictBackupsDialog />
      </Suspense>
    </>
  );
};
