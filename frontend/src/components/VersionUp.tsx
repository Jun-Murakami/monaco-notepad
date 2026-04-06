import { Chip } from '@mui/material';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Console, GetAppVersion } from '../../wailsjs/go/backend/App';
import { UpdateDialog } from './UpdateDialog';

const repoUrl =
  'https://api.github.com/repos/Jun-Murakami/monaco-notepad/releases/latest';

const compareVersions = (a: string, b: string): number => {
  const normalize = (version: string) =>
    version
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((part) => {
        const num = Number.parseInt(part, 10);
        return Number.isNaN(num) ? 0 : num;
      });

  const aParts = normalize(a);
  const bParts = normalize(b);
  const maxLen = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < maxLen; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
};

export const VersionUp = () => {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string>('');
  const [showChip, setShowChip] = useState<boolean>(false);
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    const fetchVersion = async () => {
      try {
        const ver = await GetAppVersion();

        const response = await fetch(repoUrl);
        const data = await response.json();
        if (cancelled) return;
        if (!data) {
          await Console('App version data not found', []);
          return;
        }

        const latestVersion = data.tag_name.replace('v', '');
        if (cancelled) return;
        setVersion(latestVersion);
        if (compareVersions(latestVersion, ver) > 0) {
          setShowChip(true);
        } else {
          await Console(`Latest version: ${latestVersion} (current: ${ver})`, []);
        }
      } catch (error) {
        if (!cancelled) {
          await Console('Failed to get version', [error]);
        }
      }
    };
    fetchVersion();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleClick = () => {
    setDialogOpen(true);
  };

  return (
    <>
      {showChip && (
        <Chip
          label={t('version.updateAvailable', { version })}
          onClick={handleClick}
          onDelete={() => setShowChip(false)}
          size="small"
          sx={{
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
            ml: 2,
          }}
        />
      )}
      <UpdateDialog
        open={dialogOpen}
        version={version}
        onClose={() => setDialogOpen(false)}
      />
    </>
  );
};
