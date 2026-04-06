import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Link,
  Typography,
  useTheme,
} from '@mui/material';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import {
  Console,
  GetReleaseInfo,
  OpenURL,
  PerformUpdate,
} from '../../wailsjs/go/backend/App';
import * as wailsRuntime from '../../wailsjs/runtime';
import { DEFAULT_UI_FONT_FAMILY } from '../types';

// リンクをシステムブラウザで開くコンポーネント
const MarkdownLink: React.FC<React.AnchorHTMLAttributes<HTMLAnchorElement>> = ({
  href,
  children,
  ...props
}) => {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (href) {
        OpenURL(href);
      }
    },
    [href],
  );

  return (
    <Link
      href={href}
      onClick={handleClick}
      sx={{ cursor: 'pointer' }}
      {...props}
    >
      {children}
    </Link>
  );
};

interface UpdateDialogProps {
  open: boolean;
  version: string;
  onClose: () => void;
}

export const UpdateDialog = ({ open, version, onClose }: UpdateDialogProps) => {
  const { t } = useTranslation();
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  const [releaseBody, setReleaseBody] = useState<string>('');
  const [downloadUrl, setDownloadUrl] = useState<string>('');
  const [assetName, setAssetName] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoading(true);
    setError('');
    setReleaseBody('');

    GetReleaseInfo()
      .then((info) => {
        if (cancelled) return;
        setReleaseBody(info.body);
        setDownloadUrl(info.downloadUrl);
        setAssetName(info.assetName);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const offProgress = wailsRuntime.EventsOn(
      'update:download-progress',
      (percent: number) => {
        setProgress(percent);
      },
    );

    const offStatus = wailsRuntime.EventsOn(
      'update:progress',
      (state: string) => {
        setStatus(state);
      },
    );

    return () => {
      offProgress();
      offStatus();
    };
  }, [open]);

  const handleUpdate = async () => {
    if (!downloadUrl) return;
    setUpdating(true);
    setProgress(0);
    setStatus('downloading');
    try {
      await PerformUpdate(downloadUrl, assetName);
    } catch (err) {
      await Console('Update failed', [err]);
      setError(String(err));
      setUpdating(false);
    }
  };

  const renderContent = () => {
    if (loading) {
      return (
        <Box sx={{ py: 4, textAlign: 'center' }}>
          <LinearProgress />
          <Typography sx={{ mt: 2 }}>{t('common.loading')}</Typography>
        </Box>
      );
    }

    if (error) {
      return (
        <Typography color="error" sx={{ py: 2 }}>
          {error}
        </Typography>
      );
    }

    if (updating) {
      return (
        <Box sx={{ py: 4 }}>
          <Typography sx={{ mb: 2 }}>
            {status === 'installing'
              ? t('update.installing')
              : t('update.downloading')}
          </Typography>
          <LinearProgress
            variant={
              status === 'installing' || progress === 0
                ? 'indeterminate'
                : 'determinate'
            }
            value={progress}
          />
          {progress > 0 && status !== 'installing' && (
            <Typography variant="body2" sx={{ mt: 1, textAlign: 'right' }}>
              {progress}%
            </Typography>
          )}
        </Box>
      );
    }

    return (
      <Box
        sx={{
          fontFamily: DEFAULT_UI_FONT_FAMILY,
          fontSize: 14,
          lineHeight: 1.7,
          color: 'text.primary',
          '& h1': {
            fontSize: '1.5em',
            fontWeight: 700,
            borderBottom: '1px solid',
            borderColor: 'divider',
            pb: 0.5,
            mb: 2,
            mt: 2,
          },
          '& h2': {
            fontSize: '1.3em',
            fontWeight: 600,
            borderBottom: '1px solid',
            borderColor: 'divider',
            pb: 0.5,
            mb: 1.5,
            mt: 2,
          },
          '& h3': { fontSize: '1.15em', fontWeight: 600, mb: 1, mt: 2 },
          '& p': { mb: 1.5 },
          '& a': {
            color: 'primary.main',
            textDecoration: 'none',
            '&:hover': { textDecoration: 'underline' },
          },
          '& ul, & ol': { pl: 3, mb: 1.5 },
          '& li': { mb: 0.5 },
          '& blockquote': {
            borderLeft: '4px solid',
            borderColor: 'divider',
            pl: 2,
            ml: 0,
            color: 'text.secondary',
            fontStyle: 'italic',
          },
          '& code': {
            fontSize: '0.9em',
            backgroundColor: isDark
              ? 'rgba(255,255,255,0.08)'
              : 'rgba(0,0,0,0.06)',
            borderRadius: '4px',
            px: 0.75,
            py: 0.25,
          },
          '& pre': {
            backgroundColor: isDark
              ? 'rgba(255,255,255,0.06)'
              : 'rgba(0,0,0,0.04)',
            borderRadius: '6px',
            p: 2,
            mb: 1.5,
            overflow: 'auto',
            '& code': {
              backgroundColor: 'transparent',
              p: 0,
              borderRadius: 0,
            },
          },
          '& img': { maxWidth: '100%' },
        }}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          components={{ a: MarkdownLink }}
        >
          {releaseBody}
        </ReactMarkdown>
      </Box>
    );
  };

  return (
    <Dialog
      open={open}
      onClose={updating ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      disableRestoreFocus
    >
      <DialogTitle>{t('update.title', { version })}</DialogTitle>
      <DialogContent dividers>{renderContent()}</DialogContent>
      {!updating && (
        <DialogActions>
          <Button onClick={onClose}>{t('dialog.cancel')}</Button>
          <Button
            onClick={handleUpdate}
            variant="contained"
            disabled={loading || !!error || !downloadUrl}
          >
            {t('update.startUpdate')}
          </Button>
        </DialogActions>
      )}
    </Dialog>
  );
};
