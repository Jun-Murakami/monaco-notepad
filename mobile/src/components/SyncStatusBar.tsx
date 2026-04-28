import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { IconButton, Text, useTheme } from 'react-native-paper';
import { driveService } from '@/services/sync/driveService';
import type { SyncStatus } from '@/services/sync/types';
import { useSyncStore } from '@/stores/syncStore';

const statusKeys: Record<SyncStatus, string> = {
	idle: 'sync.status_idle',
	pushing: 'sync.status_pushing',
	pulling: 'sync.status_pulling',
	merging: 'sync.status_merging',
	resolving: 'sync.status_resolving',
	offline: 'sync.status_offline',
	error: 'sync.status_error',
};

export function SyncStatusBar() {
	const { t } = useTranslation();
	const theme = useTheme();
	const status = useSyncStore((s) => s.status);
	const connected = useSyncStore((s) => s.connected);
	const progress = useSyncStore((s) => s.progress);

	const label = progress
		? `${t(statusKeys[status])}  ${progress.current}/${progress.total}`
		: t(statusKeys[status]);

	return (
		<View
			style={[
				styles.container,
				{ backgroundColor: theme.colors.elevation.level1 },
			]}
		>
			<Text variant="bodySmall" numberOfLines={1} style={styles.text}>
				{label}
			</Text>
			{connected && (
				<IconButton
					icon="sync"
					size={16}
					onPress={() => driveService.kickSync()}
					accessibilityLabel={t('sync.syncNow')}
				/>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flexDirection: 'row',
		alignItems: 'center',
		// メッセージを右寄せにして同期ボタンの左隣に並べる。
		justifyContent: 'flex-end',
		paddingHorizontal: 12,
		height: 32,
	},
	text: {
		// 主張を弱める。
		opacity: 0.6,
	},
});
