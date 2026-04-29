import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Keyboard, Pressable, StyleSheet, View } from 'react-native';
import {
	Appbar,
	Icon,
	Modal,
	Portal,
	Searchbar,
	Text,
	useTheme,
} from 'react-native-paper';

interface Props {
	visible: boolean;
	current: string;
	languages: readonly string[];
	onSelect: (lang: string) => void;
	onDismiss: () => void;
}

/**
 * 80 以上の言語を扱うため、Menu ではなく Modal + 検索 + FlatList に分離。
 * Paper の Menu は全 Item を一度に描画するので 80+ 個だと開閉が重くなる。
 * FlatList なら virtualize されて滑らかに。
 */
export function LanguagePicker({
	visible,
	current,
	languages,
	onSelect,
	onDismiss,
}: Props) {
	const { t } = useTranslation();
	const theme = useTheme();
	const [query, setQuery] = useState('');

	// 開く度に検索をリセット
	useEffect(() => {
		if (visible) setQuery('');
	}, [visible]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return languages;
		return languages.filter((l) => l.toLowerCase().includes(q));
	}, [languages, query]);

	return (
		<Portal>
			<Modal
				visible={visible}
				onDismiss={onDismiss}
				contentContainerStyle={[
					styles.modal,
					{ backgroundColor: theme.colors.background },
				]}
			>
				<Appbar.Header mode="small" elevated={false} style={styles.header}>
					<Appbar.Content
						title={t('editor.selectLanguage')}
						titleStyle={styles.headerTitle}
					/>
					<Appbar.Action icon="close" onPress={onDismiss} />
				</Appbar.Header>
				<Searchbar
					placeholder={t('editor.searchLanguage')}
					value={query}
					onChangeText={setQuery}
					style={styles.search}
					autoCapitalize="none"
					autoCorrect={false}
				/>
				<FlatList
					data={filtered}
					keyExtractor={(item) => item}
					keyboardShouldPersistTaps="handled"
					renderItem={({ item }) => {
						const selected = item === current;
						return (
							<Pressable
								onPress={() => {
									Keyboard.dismiss();
									onSelect(item);
								}}
								android_ripple={{ color: theme.colors.surfaceVariant }}
								style={({ pressed }) => [
									styles.row,
									pressed && { backgroundColor: theme.colors.surfaceVariant },
								]}
							>
								<Text
									variant="bodyMedium"
									style={{
										color: theme.colors.onSurface,
										fontWeight: selected ? '700' : '400',
									}}
								>
									{item}
								</Text>
								{selected && (
									<Icon source="check" size={18} color={theme.colors.primary} />
								)}
							</Pressable>
						);
					}}
					ItemSeparatorComponent={() => (
						<View
							style={{
								height: StyleSheet.hairlineWidth,
								backgroundColor: theme.colors.outlineVariant,
							}}
						/>
					)}
					ListEmptyComponent={() => (
						<View style={styles.empty}>
							<Text
								variant="bodyMedium"
								style={{ color: theme.colors.onSurfaceVariant }}
							>
								{t('editor.noLanguageMatches')}
							</Text>
						</View>
					)}
				/>
			</Modal>
		</Portal>
	);
}

const styles = StyleSheet.create({
	modal: {
		marginHorizontal: 16,
		marginVertical: 32,
		borderRadius: 12,
		overflow: 'hidden',
		flex: 1,
	},
	header: {
		paddingHorizontal: 4,
	},
	headerTitle: {
		// 多言語化で長くなりがち ("シンタックスハイライト言語を選択" / "Select
		// syntax highlighting language") なので、AppBar の既定 (20-22) より控えめ。
		fontSize: 15,
	},
	search: {
		marginHorizontal: 12,
		marginBottom: 8,
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		paddingHorizontal: 20,
		paddingVertical: 14,
	},
	empty: {
		padding: 24,
		alignItems: 'center',
	},
});
