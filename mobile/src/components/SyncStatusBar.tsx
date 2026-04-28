import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { IconButton, Text, useTheme } from 'react-native-paper';
import { driveService } from '@/services/sync/driveService';
import type { SyncStatus } from '@/services/sync/types';
import { useAuthStore } from '@/stores/authStore';
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
	const phase = useSyncStore((s) => s.phase);
	const signedIn = useAuthStore((s) => s.signedIn);

	// phase があるなら phase 名を優先表示 (「ノートリストを取得中...」等)。
	// 進捗付きの個別ノート転送中なら phase 名 + カウント。
	// phase が無いときは従来通り status 名を表示。
	const baseLabel = phase ? t(`sync.phase_${phase}`) : t(statusKeys[status]);
	const label = progress
		? `${baseLabel}  ${progress.current}/${progress.total}`
		: baseLabel;

	// `signedIn` だが Drive 未接続 (`!connected` or status=offline) の場合は
	// 起動時 connect 失敗からの手動リトライとして reconnect() を叩く。
	// 接続済みなら通常の kick として扱う。
	const offline = !connected || status === 'offline';
	const onPress = () => {
		if (offline) {
			driveService.reconnect().catch(() => {});
		} else {
			driveService.kickSync();
		}
	};

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
			{signedIn && (
				<IconButton
					// オフライン時は斜線入りのアイコンに切り替えて
					// 「今は同期できない」ことを視覚的に示す。タップで reconnect。
					icon={offline ? 'sync-off' : 'sync'}
					size={16}
					onPress={onPress}
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
		// 主張を弱める (薄め)。
		opacity: 0.45,
	},
});
