import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';
import { List } from 'react-native-paper';
import type { NoteMetadata } from '@/services/sync/types';

interface Props {
	metadata: NoteMetadata;
	onPress: (id: string) => void;
}

/**
 * ノート一覧の表示タイトルを決定する。
 *
 * デスクトップ版 frontend/src/components/NoteList.tsx の getNoteTitle と同じ方針：
 *   - title がある → title（通常表示）
 *   - title なし + contentHeader あり → 本文先頭を short preview（isFallback）
 *   - 両方なし → "無題のノート" プレースホルダ（isFallback）
 * isFallback の場合は italic + opacity 0.6 で視覚的にプレースホルダであることを示す。
 */
function resolveTitle(
	metadata: NoteMetadata,
	fallbackLabel: string,
): { text: string; isFallback: boolean } {
	if (metadata.title.trim()) {
		return { text: metadata.title, isFallback: false };
	}
	const preview = metadata.contentHeader.replace(/\r\n|\n|\r/g, ' ').trim();
	if (preview) {
		return { text: preview.slice(0, 50), isFallback: true };
	}
	return { text: fallbackLabel, isFallback: true };
}

export function NoteListItem({ metadata, onPress }: Props) {
	const { t } = useTranslation();
	const { text, isFallback } = resolveTitle(metadata, t('noteList.emptyNote'));

	// title があるときだけ description（本文プレビュー）を別途表示する。
	// title が空の場合はタイトル行自体が本文プレビューなので重複させない。
	const description = metadata.title.trim()
		? metadata.contentHeader
		: undefined;

	return (
		<List.Item
			title={text}
			titleStyle={isFallback ? styles.fallbackTitle : undefined}
			description={description}
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
	fallbackTitle: {
		fontStyle: 'italic',
		opacity: 0.6,
	},
});
