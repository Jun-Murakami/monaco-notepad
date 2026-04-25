import type { GestureResponderEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { IconButton, Text, useTheme } from 'react-native-paper';
import type { NoteMetadata } from '@/services/sync/types';

interface Props {
	metadata: NoteMetadata;
	onPress: (id: string) => void;
	onMorePress?: (e: GestureResponderEvent, id: string) => void;
	indented?: boolean;
}

/**
 * 表示タイトルの決定ロジック（デスクトップ版 getNoteTitle 相当）：
 *   - title あり → title（通常表示）
 *   - title なし + contentHeader あり → 本文先頭プレビュー（isFallback: italic + 薄く）
 *   - 両方なし → "無題のノート" プレースホルダ（isFallback）
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
		return { text: preview.slice(0, 60), isFallback: true };
	}
	return { text: fallbackLabel, isFallback: true };
}

export function NoteListItem({
	metadata,
	onPress,
	onMorePress,
	indented = false,
}: Props) {
	const { t } = useTranslation();
	const theme = useTheme();
	const { text, isFallback } = resolveTitle(metadata, t('noteList.emptyNote'));

	return (
		<View style={styles.row}>
			<Pressable
				onPress={() => onPress(metadata.id)}
				android_ripple={{ color: theme.colors.surfaceVariant }}
				style={({ pressed }) => [
					styles.item,
					indented && styles.indent,
					pressed && { backgroundColor: theme.colors.surfaceVariant },
				]}
			>
				<View style={styles.content}>
					<Text
						variant="bodyMedium"
						numberOfLines={1}
						style={[
							{ color: theme.colors.onSurface },
							isFallback && styles.fallback,
						]}
					>
						{text}
					</Text>
				</View>
			</Pressable>
			{onMorePress && (
				<IconButton
					icon="dots-vertical"
					size={18}
					onPress={(e) => onMorePress(e, metadata.id)}
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
		paddingHorizontal: 16,
		paddingVertical: 10,
	},
	indent: {
		paddingLeft: 40,
	},
	content: {
		flexDirection: 'row',
		alignItems: 'center',
	},
	more: {
		margin: 0,
		marginRight: 4,
	},
	fallback: {
		fontStyle: 'italic',
		opacity: 0.55,
	},
});
