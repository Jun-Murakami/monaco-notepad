import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Text, useTheme } from 'react-native-paper';
import { runOnJS } from 'react-native-reanimated';
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

// 「タップ」とみなす最大移動距離 (px) と最大押下時間 (ms)。
// - TAP_MAX_DISTANCE_PX: これを超えて指が動いた瞬間に Tap が失敗する。
//   親の ReanimatedSwipeable (横スワイプ) や DraggableRow (長押し→Pan) と
//   競合した時に、ゆっくりスワイプ → 静止 → 離す という操作で onPress が
//   漏れるのを防ぐ。値はネイティブの「タップ vs ドラッグ」目安と同等。
// - TAP_MAX_DURATION_MS: 親の長押しドラッグ閾値 (DRAG_LONG_PRESS_MS=500ms)
//   より早く諦めるため 450ms。これ以上押しっぱなしの場合は意図がタップでは
//   ないと判断し、押しっぱなしから離した時に詳細ページが開かないようにする。
const TAP_MAX_DISTANCE_PX = 10;
const TAP_MAX_DURATION_MS = 450;

function NoteListItemImpl({ metadata, onPress, indented = false }: Props) {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const { text, isFallback } = resolveTitle(metadata, t('noteList.emptyNote'));
	const formattedTime = useMemo(
		() => formatModifiedTime(metadata.modifiedTime, i18n.language),
		[metadata.modifiedTime, i18n.language],
	);
	const [pressed, setPressed] = useState(false);

	// react-native の Pressable では親 Pan の活性化と onPress のキャンセルが
	// iOS で確実に同期しないため、距離 / 時間制約付きの Gesture.Tap で実装する。
	// distance / duration を超えた瞬間に Tap が FAIL → onEnd の success=false で
	// onPress は呼ばれない。
	const tap = useMemo(
		() =>
			Gesture.Tap()
				.maxDistance(TAP_MAX_DISTANCE_PX)
				.maxDuration(TAP_MAX_DURATION_MS)
				.onTouchesDown(() => {
					runOnJS(setPressed)(true);
				})
				.onFinalize((_e, success) => {
					runOnJS(setPressed)(false);
					if (success) {
						runOnJS(onPress)(metadata.id);
					}
				}),
		[metadata.id, onPress],
	);

	return (
		<GestureDetector gesture={tap}>
			<View
				accessibilityRole="button"
				style={[
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
			</View>
		</GestureDetector>
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
