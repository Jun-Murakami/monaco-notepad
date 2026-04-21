import { StyleSheet } from 'react-native';
import { List } from 'react-native-paper';
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
	return (
		<List.Item
			title={folder.name}
			description={`${noteCount}`}
			titleNumberOfLines={1}
			onPress={() => onToggle(folder.id)}
			left={(props) => (
				<List.Icon {...props} icon={collapsed ? 'folder' : 'folder-open'} />
			)}
			right={(props) => (
				<List.Icon
					{...props}
					icon={collapsed ? 'chevron-down' : 'chevron-up'}
				/>
			)}
			style={styles.item}
		/>
	);
}

const styles = StyleSheet.create({
	item: {
		paddingHorizontal: 16,
	},
});
