import { useTranslation } from 'react-i18next';
import {
	type GestureResponderEvent,
	Pressable,
	StyleSheet,
	View,
} from 'react-native';
import { Icon, IconButton, Text, useTheme } from 'react-native-paper';
import type { Folder } from '@/services/sync/types';

interface Props {
	folder: Folder;
	noteCount: number;
	collapsed: boolean;
	onToggle: (folderId: string) => void;
	onMorePress?: (e: GestureResponderEvent, folderId: string) => void;
}

export function FolderListItem({
	folder,
	noteCount,
	collapsed,
	onToggle,
	onMorePress,
}: Props) {
	const { t } = useTranslation();
	const theme = useTheme();
	return (
		<View style={styles.row}>
			<Pressable
				onPress={() => onToggle(folder.id)}
				android_ripple={{ color: theme.colors.surfaceVariant }}
				style={({ pressed }) => [
					styles.item,
					pressed && { backgroundColor: theme.colors.surfaceVariant },
				]}
			>
				<View style={styles.chevronBox}>
					<Icon
						source={collapsed ? 'chevron-right' : 'chevron-down'}
						size={18}
						color={theme.colors.onSurfaceVariant}
					/>
				</View>
				<View style={styles.iconBox}>
					<Icon
						source={collapsed ? 'folder' : 'folder-open'}
						size={18}
						color={theme.colors.primary}
					/>
				</View>
				<Text
					variant="bodyMedium"
					numberOfLines={1}
					style={[styles.name, { color: theme.colors.onSurface }]}
				>
					{folder.name}
				</Text>
				<Text
					variant="bodySmall"
					style={{ color: theme.colors.onSurfaceVariant }}
				>
					{noteCount}
				</Text>
			</Pressable>
			{onMorePress && (
				<IconButton
					icon="dots-vertical"
					size={18}
					onPress={(e) => onMorePress(e, folder.id)}
					style={styles.more}
					accessibilityLabel={t('noteList.actions')}
				/>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	row: {
		flexDirection: 'row',
		alignItems: 'center',
	},
	item: {
		flex: 1,
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: 10,
		paddingVertical: 8,
	},
	chevronBox: {
		width: 22,
		alignItems: 'center',
	},
	iconBox: {
		width: 28,
		alignItems: 'center',
	},
	name: {
		flex: 1,
		marginLeft: 2,
	},
	more: {
		margin: 0,
		marginRight: 4,
	},
});
