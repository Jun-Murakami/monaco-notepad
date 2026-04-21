import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
	Appbar,
	Divider,
	List,
	RadioButton,
	Switch,
	Text,
} from 'react-native-paper';
import { setLanguage } from '@/i18n';
import {
	appSettings,
	type LanguagePref,
} from '@/services/settings/appSettings';
import { driveService } from '@/services/sync/driveService';
import { useAuthStore } from '@/stores/authStore';

export default function SettingsScreen() {
	const { t } = useTranslation();
	const router = useRouter();
	const signedIn = useAuthStore((s) => s.signedIn);
	const [languagePref, setLanguagePref] = useState<LanguagePref>(
		() => appSettings.snapshot().language,
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
			setSyncOnCellular(s.syncOnCellular);
			setConflictBackup(s.conflictBackup);
		});
	}, []);

	const onLanguageChange = async (value: string) => {
		await setLanguage(value as LanguagePref);
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
				<List.Section>
					<List.Subheader>{t('auth.signedInAs')}</List.Subheader>
					<List.Item
						title={signedIn ? t('auth.signedInAs') : t('auth.notSignedIn')}
						left={(props) => (
							<List.Icon
								{...props}
								icon={signedIn ? 'cloud-check' : 'cloud-off-outline'}
							/>
						)}
						right={() => (
							<Text
								style={styles.action}
								onPress={() =>
									signedIn ? driveService.signOut() : router.push('/signin')
								}
							>
								{signedIn ? t('auth.signOut') : t('auth.signIn')}
							</Text>
						)}
					/>
				</List.Section>
				<Divider />
				<List.Section>
					<List.Subheader>{t('settings.language')}</List.Subheader>
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
				</List.Section>
				<Divider />
				<List.Section>
					<List.Subheader>{t('sync.status_idle')}</List.Subheader>
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
				</List.Section>
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	action: { alignSelf: 'center', paddingHorizontal: 16 },
});
