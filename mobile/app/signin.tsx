import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Text, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { driveService } from '@/services/sync/driveService';

export default function SignInScreen() {
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onSignIn = async () => {
		setLoading(true);
		setError(null);
		try {
			await driveService.signIn();
			router.back();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	};

	return (
		<View style={[styles.container, { backgroundColor: theme.colors.background }]}>
			<Text variant="headlineSmall" style={styles.title}>
				{t('app.title')}
			</Text>
			<Text variant="bodyMedium" style={styles.prompt}>
				{t('auth.signInPrompt')}
			</Text>
			{error && (
				<Text variant="bodySmall" style={{ color: theme.colors.error, marginBottom: 16 }}>
					{error}
				</Text>
			)}
			<Button
				mode="contained"
				icon="google"
				onPress={onSignIn}
				loading={loading}
				disabled={loading}
			>
				{t('auth.signIn')}
			</Button>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		padding: 24,
	},
	title: { marginBottom: 16 },
	prompt: { marginBottom: 24, textAlign: 'center' },
});
