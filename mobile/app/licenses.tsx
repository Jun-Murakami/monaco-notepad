import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { memo, useCallback, useDeferredValue, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	FlatList,
	type ListRenderItem,
	Platform,
	Pressable,
	StyleSheet,
	View,
} from 'react-native';
import { Appbar, Searchbar, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import licensesData from '@/data/licenses.json';

interface LicenseEntry {
	name: string;
	version: string;
	license: string;
	repository: string;
}

const ALL_LICENSES = (licensesData as LicenseEntry[]) ?? [];

// FlatList の getItemLayout 用に行高を固定する。Pressable + 2 行テキスト + 余白で約 64px。
const ROW_HEIGHT = 64;

interface RowColors {
	border: string;
	muted: string;
	primary: string;
	tagBg: string;
	tagFg: string;
}

/**
 * 行は memo + 構造を最小化し、re-render コストを抑える。
 *
 * 重い `Chip` / `TouchableRipple` / `useTheme()` を行内で呼ばないことが要点。
 * 色は親で 1 度算出した RowColors を props で受ける。
 */
const LicenseRow = memo(function LicenseRow({
	entry,
	colors,
	onPress,
}: {
	entry: LicenseEntry;
	colors: RowColors;
	onPress: (url: string) => void;
}) {
	const hasRepo = !!entry.repository;
	const handlePress = useCallback(() => {
		if (hasRepo) onPress(entry.repository);
	}, [hasRepo, entry.repository, onPress]);

	return (
		<Pressable
			onPress={hasRepo ? handlePress : undefined}
			style={[styles.row, { borderBottomColor: colors.border }]}
			android_ripple={hasRepo ? { color: colors.border } : undefined}
		>
			<View style={styles.rowTop}>
				<Text numberOfLines={1} style={styles.name}>
					{entry.name}
					{entry.version ? (
						<Text style={{ color: colors.muted, fontWeight: '400' }}>
							{`  v${entry.version}`}
						</Text>
					) : null}
				</Text>
				<View
					style={[
						styles.licenseTag,
						{ backgroundColor: colors.tagBg, borderColor: colors.muted },
					]}
				>
					<Text
						numberOfLines={1}
						style={[styles.licenseTagText, { color: colors.tagFg }]}
					>
						{entry.license}
					</Text>
				</View>
			</View>
			<Text
				numberOfLines={1}
				style={[
					styles.repo,
					{ color: hasRepo ? colors.primary : colors.muted },
				]}
			>
				{hasRepo ? entry.repository : ' '}
			</Text>
		</Pressable>
	);
});

export default function LicensesScreen() {
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const insets = useSafeAreaInsets();
	const [query, setQuery] = useState('');
	// 1 文字ごとに 700+ 件を再フィルタすると入力が引っかかるので deferred で間引く。
	const deferredQuery = useDeferredValue(query);

	const filtered = useMemo(() => {
		const q = deferredQuery.trim().toLowerCase();
		if (!q) return ALL_LICENSES;
		return ALL_LICENSES.filter(
			(e) =>
				e.name.toLowerCase().includes(q) || e.license.toLowerCase().includes(q),
		);
	}, [deferredQuery]);

	const rowColors = useMemo<RowColors>(
		() => ({
			border: theme.colors.surfaceVariant,
			muted: theme.colors.onSurfaceVariant,
			primary: theme.colors.primary,
			tagBg: theme.colors.surfaceVariant,
			tagFg: theme.colors.onSurfaceVariant,
		}),
		[theme],
	);

	const onOpenRepo = useCallback(async (url: string) => {
		try {
			await WebBrowser.openBrowserAsync(url);
		} catch {
			// 無効 URL や Web 未対応ブラウザはサイレント。
		}
	}, []);

	const renderItem = useCallback<ListRenderItem<LicenseEntry>>(
		({ item }) => (
			<LicenseRow entry={item} colors={rowColors} onPress={onOpenRepo} />
		),
		[rowColors, onOpenRepo],
	);

	const keyExtractor = useCallback(
		(item: LicenseEntry, idx: number) => `${item.name}@${item.version}#${idx}`,
		[],
	);

	const getItemLayout = useCallback(
		(_: unknown, index: number) => ({
			length: ROW_HEIGHT,
			offset: ROW_HEIGHT * index,
			index,
		}),
		[],
	);

	return (
		<View style={styles.container}>
			<Appbar.Header mode="small">
				<Appbar.BackAction onPress={() => router.back()} />
				<Appbar.Content title={t('licenses.title')} />
			</Appbar.Header>
			<Searchbar
				value={query}
				onChangeText={setQuery}
				placeholder={t('licenses.searchPlaceholder')}
				style={styles.searchbar}
			/>
			<Text
				variant="bodySmall"
				style={[styles.countLabel, { color: theme.colors.onSurfaceVariant }]}
			>
				{t('licenses.count', {
					count: filtered.length,
					total: ALL_LICENSES.length,
				})}
			</Text>
			{filtered.length === 0 ? (
				<View style={styles.empty}>
					<Text style={{ color: theme.colors.onSurfaceVariant }}>
						{t('licenses.noMatches')}
					</Text>
				</View>
			) : (
				<FlatList
					data={filtered}
					keyExtractor={keyExtractor}
					renderItem={renderItem}
					getItemLayout={getItemLayout}
					initialNumToRender={12}
					maxToRenderPerBatch={10}
					updateCellsBatchingPeriod={50}
					windowSize={7}
					removeClippedSubviews={Platform.OS === 'android'}
					contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
				/>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	searchbar: {
		marginHorizontal: 16,
		marginTop: 8,
	},
	countLabel: {
		paddingHorizontal: 16,
		paddingVertical: 6,
	},
	row: {
		height: ROW_HEIGHT,
		paddingHorizontal: 16,
		paddingVertical: 10,
		borderBottomWidth: StyleSheet.hairlineWidth,
		justifyContent: 'center',
	},
	rowTop: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
	},
	name: {
		flex: 1,
		fontSize: 14,
		fontWeight: '600',
	},
	licenseTag: {
		paddingHorizontal: 8,
		paddingVertical: 2,
		borderRadius: 4,
		borderWidth: StyleSheet.hairlineWidth,
		maxWidth: 140,
	},
	licenseTagText: {
		fontSize: 11,
	},
	repo: {
		marginTop: 4,
		fontSize: 12,
	},
	empty: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		padding: 24,
	},
});
