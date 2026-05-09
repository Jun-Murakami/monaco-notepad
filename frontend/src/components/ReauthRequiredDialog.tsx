import { useTranslation } from 'react-i18next';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';

import { AuthorizeDrive } from '../../wailsjs/go/backend/App';
import { useDialogsStore } from '../stores/useDialogsStore';

// 「Drive 接続が切れたまま気付かない」事故を防ぐためのダイアログ。
// バックエンドが drive:reauth-required を emit するときだけ開き、
// reason に応じて文言を出し分ける:
//   - invalid_grant   : サインインの有効期限切れ → 再ログイン必須
//   - startup_failed  : 起動時の保存トークンでの接続失敗 (auth/network 含む)
//   - polling_failed  : ポーリング中の連続再接続失敗
//
// 重複表示はバックエンド側 DriveSync.MarkReauthNotified で抑止されている
// (再接続成功でフラグがリセットされる)。
export const ReauthRequiredDialog: React.FC = () => {
  const open = useDialogsStore((s) => s.isReauthRequiredOpen);
  const reason = useDialogsStore((s) => s.reauthReason);
  const close = useDialogsStore((s) => s.closeReauthRequired);
  const { t } = useTranslation();

  const messageKey = (() => {
    switch (reason) {
      case 'invalid_grant':
        return 'driveUI.reauthRequired.messageInvalidGrant';
      case 'polling_failed':
        return 'driveUI.reauthRequired.messagePollingFailed';
      default:
        return 'driveUI.reauthRequired.messageStartupFailed';
    }
  })();

  const handleReLogin = async () => {
    close();
    try {
      await AuthorizeDrive();
    } catch (err) {
      console.error('Re-authorize failed:', err);
    }
  };

  return (
    <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle>{t('driveUI.reauthRequired.title')}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ whiteSpace: 'pre-line' }}>
          {t(messageKey)}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>{t('driveUI.reauthRequired.later')}</Button>
        <Button onClick={handleReLogin} variant="contained" autoFocus>
          {t('driveUI.reauthRequired.reLogin')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
