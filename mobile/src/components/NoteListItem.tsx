import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
// ★ Pressable は react-native のものではなく gesture-handler 版を使う。
// 親の ReanimatedSwipeable (Pan ジェスチャー) と協調し、スワイプが活性化した
// 瞬間に press が自動キャンセルされる。RN 版だと iOS で小さく左スワイプした
// 時に onPress が漏れて詳細ページに遷移してしまう。
import { Pressable } from 'react-native-gesture-handler';
import { Text, useTheme } from 'react-native-paper';
import type { NoteMetadata } from '@/services/sync/types';

interface Props {
	metadata: NoteMetadata;
	onPress: (id: string) => void;
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

/**
 * `modifiedTime` (ISO 文字列) をユーザーロケールに沿った
 * 「年月日 時:分:秒」表現に整形する。Date が parse 失敗した時は元文字列を返す。
 */
function formatModifiedTime(iso: string, locale: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	try {
		return date.toLocaleString(locale, {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
	} catch {
		return date.toISOString();
	}
}

function NoteListItemImpl({ metadata, onPress, indented = false }: Props) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const { text, isFallback } = resolveTitle(metadata, t('noteList.emptyNote'));
	const formattedTime = useMemo(
		() => formatModifiedTime(metadata.modifiedTime, i18n.language),
		[metadata.modifiedTime, i18n.language],
	);

	return (
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
					variant="bodyLarge"
					numberOfLines={1}
					style={[
						{ color: theme.colors.onSurface },
						isFallback && styles.fallback,
					]}
				>
					{text}
				</Text>
				<Text
					variant="bodyMedium"
					numberOfLines={1}
					style={[styles.time, { color: theme.colors.onSurfaceVariant }]}
				>
					{formattedTime}
				</Text>
			</View>
		</Pressable>
	);
}

export const NoteListItem = memo(NoteListItemImpl);

const styles = StyleSheet.create({
	item: {
		paddingHorizontal: 16,
		paddingVertical: 10,
	},
	indent: {
		paddingLeft: 40,
	},
	content: {
		// 縦に「タイトル / 日時」と並べる。
	},
	fallback: {
		fontStyle: 'italic',
	},
	time: {
		marginTop: 2,
		opacity: 0.55,
	},
});
