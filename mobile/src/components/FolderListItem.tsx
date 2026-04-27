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

/**
 * フォルダのヘッダ行。
 *
 * UI 方針:
 * - 左端の chevron だけが折り畳みトグル (タップで開閉)。
 * - ヘッダ本体 (アイコン + 名前 + 件数) はタップ無反応。**ドラッグ用領域**として
 *   親 (NoteListScreen renderItem) が `<Pressable onLongPress={drag}>` で包む想定。
 * - 右端の dots はコンテキストメニュー。
 *
 * 注: chevron は意図的に **RN 標準 `Pressable`** を使う。NoteListItem の onPress
 * と同じ構造にすることで、外側 (gh) の long-press 判定を遅延させる nested-gh の
 * 競合を避ける。RN の responder system 経由なら gesture-handler とは独立に
 * onPress が走り、外側の drag 判定はそのまま 150ms で発火できる。
 */
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
			{/* 折り畳みトグル: chevron 部分のみ。
			    注: pressed state による bg 切替は意図的に外している。tap → pressed=true →
			    pressed=false の遷移で React 再レンダリング → folder-header 全体の View が
			    再描画され、極短時間ではあるが「角 rounded → 一瞬 square → rounded」のような
			    flicker として観測されることがある (ネイティブ側で style 適用がフレーム
			    境界をまたぐため)。 */}
			<Pressable
				onPress={() => onToggle(folder.id)}
				hitSlop={8}
				style={styles.chevronButton}
				accessibilityRole="button"
				accessibilityLabel={folder.name}
				accessibilityState={{ expanded: !collapsed }}
			>
				<Icon
					source={collapsed ? 'chevron-right' : 'chevron-down'}
					size={18}
					color={theme.colors.onSurfaceVariant}
				/>
			</Pressable>
			{/* ヘッダ本体: タッチ無反応。親の Pressable がドラッグ用に包む。 */}
			<View style={styles.body}>
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
			</View>
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
	chevronButton: {
		width: 32,
		height: 36,
		alignItems: 'center',
		justifyContent: 'center',
	},
	body: {
		flex: 1,
		flexDirection: 'row',
		alignItems: 'center',
		paddingVertical: 8,
		paddingRight: 4,
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
