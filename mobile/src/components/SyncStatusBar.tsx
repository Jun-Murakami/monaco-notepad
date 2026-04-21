import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, IconButton, Text, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { driveService } from '@/services/sync/driveService';
import { useSyncStore } from '@/stores/syncStore';
import type { SyncStatus } from '@/services/sync/types';

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

	const busy = status === 'pushing' || status === 'pulling' || status === 'merging' || status === 'resolving';

	return (
		<View style={[styles.container, { backgroundColor: theme.colors.elevation.level1 }]}>
			{busy && <ActivityIndicator size="small" style={styles.indicator} />}
			<Text variant="bodySmall" style={styles.text}>
				{t(statusKeys[status])}
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
		paddingHorizontal: 12,
		height: 32,
	},
	indicator: {
		marginRight: 8,
	},
	text: {
		flex: 1,
	},
});
