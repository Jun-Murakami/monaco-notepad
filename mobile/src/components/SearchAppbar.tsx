import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput, View } from 'react-native';
import {
	ActivityIndicator,
	Appbar,
	IconButton,
	useTheme,
} from 'react-native-paper';

interface Props {
	value: string;
	onChangeText: (text: string) => void;
	onClose: () => void;
	indexing?: boolean;
}

/**
 * 検索モード時の Appbar。通常 Appbar の代わりにこれを描画する。
 *
 * - 左: 戻るボタンで検索モードを閉じる
 * - 中央: TextInput (autoFocus でキーボードが立ち上がる)
 * - 右: クリアボタン (入力がある時) または index 構築中スピナー
 */
export function SearchAppbar({
	value,
	onChangeText,
	onClose,
	indexing = false,
}: Props) {
	const { t } = useTranslation();
	const theme = useTheme();
	return (
		<Appbar.Header mode="small">
			<Appbar.BackAction onPress={onClose} />
			<View style={styles.inputWrap}>
				<TextInput
					value={value}
					onChangeText={onChangeText}
					placeholder={t('search.placeholder')}
					placeholderTextColor={theme.colors.onSurfaceVariant}
					autoFocus
					autoCorrect={false}
					autoCapitalize="none"
					returnKeyType="search"
					style={[styles.input, { color: theme.colors.onSurface }]}
					selectionColor={theme.colors.primary}
				/>
			</View>
			{indexing ? (
				<ActivityIndicator size="small" style={styles.indicator} />
			) : value.length > 0 ? (
				<IconButton icon="close" onPress={() => onChangeText('')} />
			) : null}
		</Appbar.Header>
	);
}

const styles = StyleSheet.create({
	inputWrap: {
		flex: 1,
		justifyContent: 'center',
	},
	input: {
		fontSize: 16,
		paddingVertical: 6,
	},
	indicator: {
		marginRight: 16,
	},
});
