import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { I18nextProvider } from 'react-i18next';
import { useColorScheme, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ActivityIndicator, PaperProvider, Text } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useInitialize } from '@/hooks/useInitialize';
import i18n from '@/i18n';
import { darkTheme, lightTheme } from '@/theme';

export default function RootLayout() {
	const scheme = useColorScheme();
	const theme = scheme === 'dark' ? darkTheme : lightTheme;
	const { ready, error } = useInitialize();

	if (!ready) {
		return (
			<PaperProvider theme={theme}>
				<View
					style={{
						flex: 1,
						alignItems: 'center',
						justifyContent: 'center',
						backgroundColor: theme.colors.background,
					}}
				>
					{error ? (
						<Text variant="bodyMedium" style={{ color: theme.colors.error }}>
							{error.message}
						</Text>
					) : (
						<ActivityIndicator />
					)}
				</View>
			</PaperProvider>
		);
	}

	return (
		<GestureHandlerRootView style={{ flex: 1 }}>
			<SafeAreaProvider>
				<I18nextProvider i18n={i18n}>
					<PaperProvider theme={theme}>
						<StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
						<Stack screenOptions={{ headerShown: true }}>
							<Stack.Screen
								name="index"
								options={{ title: 'Monaco Notepad' }}
							/>
							<Stack.Screen name="note/[id]" options={{ title: '' }} />
							<Stack.Screen name="settings" options={{ title: 'Settings' }} />
							<Stack.Screen
								name="signin"
								options={{ presentation: 'modal', title: 'Sign in' }}
							/>
						</Stack>
					</PaperProvider>
				</I18nextProvider>
			</SafeAreaProvider>
		</GestureHandlerRootView>
	);
}
