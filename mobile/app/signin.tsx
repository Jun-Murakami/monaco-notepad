import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Appbar, Button, Text, useTheme } from 'react-native-paper';
import { driveService } from '@/services/sync/driveService';

export default function SignInScreen() {
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const closeSignIn = () => {
		// 成功時と同じ畳み方で確実にルート (/) に戻る。
		if (router.canDismiss()) {
			router.dismissAll();
		} else if (router.canGoBack()) {
			router.back();
		} else {
			router.replace('/');
		}
	};

	const onSignIn = async () => {
		setLoading(true);
		setError(null);
		try {
			await driveService.signIn();
			closeSignIn();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	};

	return (
		<View
			style={[styles.container, { backgroundColor: theme.colors.background }]}
		>
			<Appbar.Header>
				<Appbar.BackAction onPress={closeSignIn} disabled={loading} />
				<Appbar.Content title={t('auth.signIn')} />
			</Appbar.Header>
			<View style={styles.content}>
				<Text variant="headlineSmall" style={styles.title}>
					{t('app.title')}
				</Text>
				<Text variant="bodyMedium" style={styles.prompt}>
					{t('auth.signInPrompt')}
				</Text>
				{error && (
					<Text
						variant="bodySmall"
						style={[styles.errorText, { color: theme.colors.error }]}
					>
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
				<Button
					mode="text"
					onPress={closeSignIn}
					disabled={loading}
					style={styles.cancelButton}
				>
					{t('auth.cancel')}
				</Button>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	content: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		padding: 24,
	},
	title: { marginBottom: 16 },
	prompt: { marginBottom: 24, textAlign: 'center' },
	errorText: { marginBottom: 16 },
	cancelButton: { marginTop: 8 },
});
