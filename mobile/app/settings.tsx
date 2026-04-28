import { useRouter } from 'expo-router';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	ScrollView,
	StyleSheet,
	useWindowDimensions,
	View,
} from 'react-native';
import {
	Appbar,
	Button,
	List,
	RadioButton,
	SegmentedButtons,
	Switch,
	useTheme,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { setLanguage } from '@/i18n';
import {
	appSettings,
	EDITOR_FONT_SIZES,
	type EditorFontSize,
	type LanguagePref,
	type ThemePref,
} from '@/services/settings/appSettings';
import { driveService } from '@/services/sync/driveService';
import { useAuthStore } from '@/stores/authStore';

/** 背景色付きの帯でセクションを区切るためのラッパ。 */
function SectionBar({ children }: { children: ReactNode }) {
	const theme = useTheme();
	return (
		<List.Subheader
			style={[
				styles.subheader,
				{ backgroundColor: theme.colors.surfaceVariant },
			]}
		>
			{children}
		</List.Subheader>
	);
}

// 設定画面の左右 padding (fontSizeRow と同じ値)。
const SECTION_HORIZONTAL_PADDING = 16;

export default function SettingsScreen() {
	const { t } = useTranslation();
	const router = useRouter();
	const insets = useSafeAreaInsets();
	const { width: windowWidth } = useWindowDimensions();
	const signedIn = useAuthStore((s) => s.signedIn);
	// SegmentedButtons は内部 minWidth が効いて 5 個並ぶと画面幅を超えがち。
	// 1 ボタンあたりの width を画面幅から逆算して当て、均等分割にする。
	const fontSizeButtonWidth =
		(windowWidth - SECTION_HORIZONTAL_PADDING * 2) / EDITOR_FONT_SIZES.length;
	const [languagePref, setLanguagePref] = useState<LanguagePref>(
		() => appSettings.snapshot().language,
	);
	const [themePref, setThemePref] = useState<ThemePref>(
		() => appSettings.snapshot().theme,
	);
	const [syncOnCellular, setSyncOnCellular] = useState(
		() => appSettings.snapshot().syncOnCellular,
	);
	const [conflictBackup, setConflictBackup] = useState(
		() => appSettings.snapshot().conflictBackup,
	);
	const [editorFontSize, setEditorFontSize] = useState<EditorFontSize>(
		() => appSettings.snapshot().editorFontSize,
	);

	useEffect(() => {
		return appSettings.subscribe((s) => {
			setLanguagePref(s.language);
			setThemePref(s.theme);
			setSyncOnCellular(s.syncOnCellular);
			setConflictBackup(s.conflictBackup);
			setEditorFontSize(s.editorFontSize);
		});
	}, []);

	const onLanguageChange = async (value: string) => {
		await setLanguage(value as LanguagePref);
	};
	const onThemeChange = async (value: string) => {
		await appSettings.update({ theme: value as ThemePref });
	};
	const onSyncOnCellularChange = async (value: boolean) => {
		await appSettings.update({ syncOnCellular: value });
	};
	const onConflictBackupChange = async (value: boolean) => {
		await appSettings.update({ conflictBackup: value });
	};
	const onEditorFontSizeChange = async (value: string) => {
		const num = Number(value);
		if (!EDITOR_FONT_SIZES.includes(num as EditorFontSize)) return;
		await appSettings.update({ editorFontSize: num as EditorFontSize });
	};

	return (
		<View style={styles.container}>
			<Appbar.Header>
				<Appbar.BackAction onPress={() => router.back()} />
				<Appbar.Content title={t('settings.title')} />
			</Appbar.Header>
			<ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
				<SectionBar>{t('settings.account')}</SectionBar>
				<List.Item
					title={signedIn ? t('auth.signedInAs') : t('auth.notSignedIn')}
					left={(props) => (
						<List.Icon
							{...props}
							icon={signedIn ? 'cloud-check' : 'cloud-off-outline'}
						/>
					)}
					right={() => (
						<Button
							mode="outlined"
							compact
							onPress={() =>
								signedIn ? driveService.signOut() : router.push('/signin')
							}
							style={styles.action}
						>
							{signedIn ? t('auth.signOut') : t('auth.signIn')}
						</Button>
					)}
				/>

				<SectionBar>{t('settings.language')}</SectionBar>
				<RadioButton.Group
					onValueChange={onLanguageChange}
					value={languagePref}
				>
					<RadioButton.Item
						label={t('settings.language_system')}
						value="auto"
					/>
					<RadioButton.Item label={t('settings.language_ja')} value="ja" />
					<RadioButton.Item label={t('settings.language_en')} value="en" />
				</RadioButton.Group>

				<SectionBar>{t('settings.theme')}</SectionBar>
				<RadioButton.Group onValueChange={onThemeChange} value={themePref}>
					<RadioButton.Item label={t('settings.theme_system')} value="auto" />
					<RadioButton.Item label={t('settings.theme_light')} value="light" />
					<RadioButton.Item label={t('settings.theme_dark')} value="dark" />
				</RadioButton.Group>

				<SectionBar>{t('settings.sync')}</SectionBar>
				<List.Item
					title={t('settings.syncOnCellular')}
					left={(props) => <List.Icon {...props} icon="signal" />}
					right={() => (
						<Switch
							value={syncOnCellular}
							onValueChange={onSyncOnCellularChange}
						/>
					)}
				/>
				<List.Item
					title={t('settings.conflictBackup')}
					left={(props) => <List.Icon {...props} icon="backup-restore" />}
					right={() => (
						<Switch
							value={conflictBackup}
							onValueChange={onConflictBackupChange}
						/>
					)}
				/>

				<SectionBar>{t('settings.editor')}</SectionBar>
				<List.Item
					title={t('settings.editorFontSize')}
					left={(props) => <List.Icon {...props} icon="format-size" />}
				/>
				<View style={styles.fontSizeRow}>
					<SegmentedButtons
						value={String(editorFontSize)}
						onValueChange={onEditorFontSizeChange}
						density="small"
						buttons={EDITOR_FONT_SIZES.map((size) => ({
							value: String(size),
							label: String(size),
							style: { minWidth: 0, width: fontSizeButtonWidth },
						}))}
					/>
				</View>
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	action: { alignSelf: 'center', marginRight: 8 },
	subheader: {
		paddingHorizontal: 16,
		paddingVertical: 6,
		lineHeight: 20,
	},
	fontSizeRow: {
		paddingHorizontal: SECTION_HORIZONTAL_PADDING,
		paddingBottom: 12,
	},
});
