import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, Portal, Text } from 'react-native-paper';
import { type DriveReauthReason, syncEvents } from '@/services/sync/events';

/**
 * 「Drive 接続が切れたまま気付かない」事故を防ぐためのダイアログ。
 *
 * デスクトップ版 ReauthRequiredDialog と同じセマンティクスで、syncEvents の
 * `drive:reauth-required` を購読して reason に応じた文言を表示する。
 *
 * 重複表示は authService.notifyReauthRequired() 内部で抑止済み (接続復帰で
 * フラグがリセットされ、次のオフライン時に再度通知できる)。
 *
 * 「サインイン」を押すと signin 画面へ遷移、「後で」を押すと閉じるだけ。
 */
export const ReauthRequiredDialog = () => {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [reason, setReason] = useState<DriveReauthReason>('startup_failed');

	useEffect(() => {
		return syncEvents.on('drive:reauth-required', (payload) => {
			setReason(payload.reason);
			setOpen(true);
		});
	}, []);

	const close = () => setOpen(false);

	const handleSignIn = () => {
		close();
		router.push('/signin');
	};

	const messageKey = (() => {
		switch (reason) {
			case 'invalid_grant':
				return 'auth.reauthRequired.messageInvalidGrant';
			case 'polling_failed':
				return 'auth.reauthRequired.messagePollingFailed';
			default:
				return 'auth.reauthRequired.messageStartupFailed';
		}
	})();

	return (
		<Portal>
			<Dialog visible={open} onDismiss={close}>
				<Dialog.Title>{t('auth.reauthRequired.title')}</Dialog.Title>
				<Dialog.Content>
					<Text variant="bodyMedium">{t(messageKey)}</Text>
				</Dialog.Content>
				<Dialog.Actions>
					<Button onPress={close}>{t('auth.reauthRequired.later')}</Button>
					<Button mode="contained" onPress={handleSignIn}>
						{t('auth.reauthRequired.reLogin')}
					</Button>
				</Dialog.Actions>
			</Dialog>
		</Portal>
	);
};
