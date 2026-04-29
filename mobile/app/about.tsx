import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
	Appbar,
	Divider,
	List,
	Text,
	TouchableRipple,
	useTheme,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import buildInfo from '../build-number.json';

const WEBSITE_URL = 'https://jun-murakami.web.app/';
const REPOSITORY_URL = 'https://github.com/Jun-Murakami/monaco-notepad';
const PRIVACY_POLICY_URL =
	'https://jun-murakami.web.app/privacy-policy-monaco-notepad';

export default function AboutScreen() {
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const insets = useSafeAreaInsets();

	const version = Constants.expoConfig?.version ?? '';
	const buildNumber = buildInfo.buildNumber;

	const openUrl = async (url: string) => {
		try {
			await WebBrowser.openBrowserAsync(url);
		} catch {
			// 失敗時はサイレント。ユーザーが端末で対応していないケース（Web 等）。
		}
	};

	return (
		<View style={styles.container}>
			<Appbar.Header>
				<Appbar.BackAction onPress={() => router.back()} />
				<Appbar.Content title={t('about.title')} />
			</Appbar.Header>
			<ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
				<View style={styles.hero}>
					<Text variant="headlineSmall" style={styles.appName}>
						{t('app.title')}
					</Text>
					<Text
						variant="bodyMedium"
						style={{ color: theme.colors.onSurfaceVariant }}
					>
						{t('about.version', { version, build: buildNumber })}
					</Text>
				</View>

				<Divider />

				<List.Subheader
					style={[
						styles.subheader,
						{ backgroundColor: theme.colors.surfaceVariant },
					]}
				>
					{t('about.privacySection')}
				</List.Subheader>
				<TouchableRipple onPress={() => openUrl(PRIVACY_POLICY_URL)}>
					<List.Item
						title={t('about.privacyPolicy')}
						left={(props) => (
							<List.Icon {...props} icon="shield-lock-outline" />
						)}
						right={(props) => <List.Icon {...props} icon="open-in-new" />}
					/>
				</TouchableRipple>

				<List.Subheader
					style={[
						styles.subheader,
						{ backgroundColor: theme.colors.surfaceVariant },
					]}
				>
					{t('about.creditSection')}
				</List.Subheader>
				<List.Item
					title={t('about.developer')}
					left={(props) => (
						<List.Icon {...props} icon="account-circle-outline" />
					)}
				/>
				<TouchableRipple onPress={() => openUrl(WEBSITE_URL)}>
					<List.Item
						title={t('about.website')}
						description={WEBSITE_URL}
						left={(props) => <List.Icon {...props} icon="web" />}
						right={(props) => <List.Icon {...props} icon="open-in-new" />}
					/>
				</TouchableRipple>
				<TouchableRipple onPress={() => openUrl(REPOSITORY_URL)}>
					<List.Item
						title={t('about.repository')}
						description={REPOSITORY_URL}
						left={(props) => <List.Icon {...props} icon="github" />}
						right={(props) => <List.Icon {...props} icon="open-in-new" />}
					/>
				</TouchableRipple>

				<List.Subheader
					style={[
						styles.subheader,
						{ backgroundColor: theme.colors.surfaceVariant },
					]}
				>
					{t('about.licenseSection')}
				</List.Subheader>
				<List.Item
					title={t('about.appLicense')}
					description={t('about.appLicenseDescription')}
					left={(props) => (
						<List.Icon {...props} icon="file-document-outline" />
					)}
				/>
				<TouchableRipple onPress={() => router.push('/licenses')}>
					<List.Item
						title={t('about.openSourceLicenses')}
						description={t('about.openSourceLicensesDescription')}
						left={(props) => (
							<List.Icon {...props} icon="format-list-bulleted" />
						)}
						right={(props) => <List.Icon {...props} icon="chevron-right" />}
					/>
				</TouchableRipple>
				<View style={styles.copyrightBlock}>
					<Text
						variant="bodySmall"
						style={{ color: theme.colors.onSurfaceVariant }}
					>
						{t('about.copyright', { year: new Date().getFullYear() })}
					</Text>
				</View>
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	hero: {
		alignItems: 'center',
		paddingVertical: 24,
		gap: 4,
	},
	appName: {
		fontWeight: '700',
	},
	subheader: {
		paddingHorizontal: 16,
		paddingVertical: 6,
		lineHeight: 20,
	},
	copyrightBlock: {
		alignItems: 'center',
		paddingHorizontal: 16,
		paddingVertical: 16,
	},
});
