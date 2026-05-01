import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material';

import { useDialogsStore } from '../stores/useDialogsStore';

// 設定ダイアログから開かれる、スマートフォン版アプリ案内モーダル。
// 設定ダイアログの上に重ねて開く（isSettingsOpen は閉じない）。
// 上にロゴ、下にロケールに応じた iOS の QR と Android の QR を並べる。
export const MobileAppDialog: React.FC = () => {
  const open = useDialogsStore((s) => s.isMobileAppOpen);
  const onClose = useDialogsStore((s) => s.closeMobileApp);
  const { t, i18n } = useTranslation();

  // 言語コードの先頭が ja なら日本語版 App Store の QR、それ以外は英語版を出す
  const iosQrSrc = i18n.language?.toLowerCase().startsWith('ja')
    ? '/images/qr_ios_jp.svg'
    : '/images/qr_ios_us.svg';

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{t('mobileApp.title')}</DialogTitle>
      <DialogContent>
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 3,
            mt: 1,
          }}
        >
          <Box
            component="img"
            src="/images/logo.png"
            alt={t('mobileApp.logoAlt')}
            sx={{
              maxWidth: '80%',
              height: 'auto',
              userSelect: 'none',
            }}
            draggable={false}
          />

          <Typography variant="body2" color="textSecondary" align="center">
            {t('mobileApp.description')}
          </Typography>

          <Box
            sx={{
              display: 'flex',
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'flex-start',
              gap: 4,
              width: '100%',
            }}
          >
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 1,
              }}
            >
              <Box
                component="img"
                src={iosQrSrc}
                alt={t('mobileApp.iosCaption')}
                sx={{ width: 140, height: 140, userSelect: 'none' }}
                draggable={false}
              />
              <Typography variant="subtitle2">
                {t('mobileApp.iosCaption')}
              </Typography>
            </Box>

            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 1,
              }}
            >
              <Box
                component="img"
                src="/images/qr_android.svg"
                alt={t('mobileApp.androidCaption')}
                sx={{ width: 140, height: 140, userSelect: 'none' }}
                draggable={false}
              />
              <Typography variant="subtitle2">
                {t('mobileApp.androidCaption')}
              </Typography>
            </Box>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} variant="contained">
          {t('mobileApp.close')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
