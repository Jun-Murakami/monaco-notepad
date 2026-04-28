import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { I18nextProvider } from 'react-i18next';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ActivityIndicator, PaperProvider, Text } from 'react-native-paper';
import { configureReanimatedLogger } from 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAppTheme } from '@/hooks/useAppTheme';
import { useInitialize } from '@/hooks/useInitialize';
import i18n from '@/i18n';

// Reanimated 4 の strict mode は SharedValue.value を render 中に読むと warn を出す。
// 開発中の gesture animation で過剰に出る場合があるため strict だけ off にする。
configureReanimatedLogger({ strict: false });

export default function RootLayout() {
	const { theme, isDark } = useAppTheme();
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
						<BottomSheetModalProvider>
							<StatusBar style={isDark ? 'light' : 'dark'} />
							{/*
							 * 各画面が react-native-paper の Appbar を自前で描画するので、
							 * Stack の自動 header は出さない（出すと二重ヘッダーになる）。
							 */}
							<Stack
								screenOptions={{
									headerShown: false,
									contentStyle: { backgroundColor: theme.colors.background },
								}}
							>
								<Stack.Screen name="index" />
								<Stack.Screen name="note/[id]" />
								<Stack.Screen name="archive" />
								<Stack.Screen name="settings" />
								<Stack.Screen
									name="signin"
									options={{ presentation: 'modal' }}
								/>
								<Stack.Screen name="oauth2redirect" />
							</Stack>
						</BottomSheetModalProvider>
					</PaperProvider>
				</I18nextProvider>
			</SafeAreaProvider>
		</GestureHandlerRootView>
	);
}
