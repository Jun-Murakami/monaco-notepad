import { StyleSheet } from 'react-native';
import { List } from 'react-native-paper';
import type { NoteMetadata } from '@/services/sync/types';

interface Props {
	metadata: NoteMetadata;
	onPress: (id: string) => void;
}

export function NoteListItem({ metadata, onPress }: Props) {
	const title = metadata.title || '(untitled)';
	const preview = metadata.contentHeader || '';
	return (
		<List.Item
			title={title}
			description={preview}
			titleNumberOfLines={1}
			descriptionNumberOfLines={2}
			onPress={() => onPress(metadata.id)}
			right={(props) => <List.Icon {...props} icon="chevron-right" />}
			style={styles.item}
		/>
	);
}

const styles = StyleSheet.create({
	item: {
		paddingHorizontal: 16,
	},
});
