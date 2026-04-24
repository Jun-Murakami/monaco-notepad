import { useRouter } from 'expo-router';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
	Appbar,
	Button,
	List,
	RadioButton,
	Switch,
	useTheme,
} from 'react-native-paper';
import { setLanguage } from '@/i18n';
import {
	appSettings,
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

export default function SettingsScreen() {
	const { t } = useTranslation();
	const router = useRouter();
	const signedIn = useAuthStore((s) => s.signedIn);
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

	useEffect(() => {
		return appSettings.subscribe((s) => {
			setLanguagePref(s.language);
			setThemePref(s.theme);
			setSyncOnCellular(s.syncOnCellular);
			setConflictBackup(s.conflictBackup);
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

	return (
		<View style={styles.container}>
			<Appbar.Header>
				<Appbar.BackAction onPress={() => router.back()} />
				<Appbar.Content title={t('settings.title')} />
			</Appbar.Header>
			<ScrollView>
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
});
