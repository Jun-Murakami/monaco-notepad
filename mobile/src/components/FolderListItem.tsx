import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';
import type { Folder } from '@/services/sync/types';

interface Props {
	folder: Folder;
	noteCount: number;
	collapsed: boolean;
	onToggle: (folderId: string) => void;
}

export function FolderListItem({
	folder,
	noteCount,
	collapsed,
	onToggle,
}: Props) {
	const theme = useTheme();
	return (
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
	);
}

const styles = StyleSheet.create({
	item: {
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
});
