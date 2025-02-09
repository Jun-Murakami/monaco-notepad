import { useEffect, useState } from 'react';
import { Chip } from '@mui/material';
import { GetAppVersion } from '../../wailsjs/go/backend/App';

const repoUrl = 'https://api.github.com/repos/Jun-Murakami/monaco-notepad/releases/latest';
const releaseUrl = 'https://jun-murakami.web.app/#monacoNotepad';

export const VersionUp = () => {
  const [version, setVersion] = useState<string>('');
  const [showChip, setShowChip] = useState<boolean>(false);

  useEffect(() => {
    const fetchVersion = async () => {
      try {
        const ver = await GetAppVersion();
        setVersion(ver);

        const response = await fetch(repoUrl);
        const data = await response.json();
        if (!data) {
          console.error('データが見つかりません');
          return;
        }

        const latestVersion = data.tag_name.replace('v', '');
        if (latestVersion > ver) {
          setShowChip(true);
        } else {
          console.log('最新バージョンです');
        }
      } catch (error) {
        console.error('バージョン取得に失敗しました', error);
      }
    };
    fetchVersion();
  }, []);

  return (
    <>
      {showChip && (
        <Chip
          label={`Update? v${version}`}
          onClick={() => window.open(releaseUrl, '_blank')}
          onDelete={() => setShowChip(false)}
          size='small'
          sx={{
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
            ml: 2,
          }}
        />
      )}
    </>
  );
};
