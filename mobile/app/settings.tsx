import { ScrollView, StyleSheet, View } from 'react-native';
import { Appbar, Divider, List, Switch, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { driveService } from '@/services/sync/driveService';
import { useAuthStore } from '@/stores/authStore';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import i18n from '@/i18n';

export default function SettingsScreen() {
	const { t } = useTranslation();
	const router = useRouter();
	const signedIn = useAuthStore((s) => s.signedIn);
	const [syncOnCellular, setSyncOnCellular] = useState(true);
	const [conflictBackup, setConflictBackup] = useState(true);

	const cycleLanguage = () => {
		const next = i18n.language === 'ja' ? 'en' : 'ja';
		i18n.changeLanguage(next);
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
						left={(props) => <List.Icon {...props} icon={signedIn ? 'cloud-check' : 'cloud-off-outline'} />}
						right={() => (
							<Text style={styles.action} onPress={() => (signedIn ? driveService.signOut() : router.push('/signin'))}>
								{signedIn ? t('auth.signOut') : t('auth.signIn')}
							</Text>
						)}
					/>
				</List.Section>
				<Divider />
				<List.Section>
					<List.Subheader>{t('settings.language')}</List.Subheader>
					<List.Item
						title={i18n.language === 'ja' ? t('settings.language_ja') : t('settings.language_en')}
						onPress={cycleLanguage}
						left={(props) => <List.Icon {...props} icon="translate" />}
					/>
				</List.Section>
				<Divider />
				<List.Section>
					<List.Subheader>{t('sync.status_idle')}</List.Subheader>
					<List.Item
						title={t('settings.syncOnCellular')}
						left={(props) => <List.Icon {...props} icon="signal" />}
						right={() => <Switch value={syncOnCellular} onValueChange={setSyncOnCellular} />}
					/>
					<List.Item
						title={t('settings.conflictBackup')}
						left={(props) => <List.Icon {...props} icon="backup-restore" />}
						right={() => <Switch value={conflictBackup} onValueChange={setConflictBackup} />}
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
