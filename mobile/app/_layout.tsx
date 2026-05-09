import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ActivityIndicator, PaperProvider, Text } from 'react-native-paper';
import { configureReanimatedLogger } from 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ReauthRequiredDialog } from '@/components/ReauthRequiredDialog';
import { useAppTheme } from '@/hooks/useAppTheme';
import { useInitialize } from '@/hooks/useInitialize';
import i18n from '@/i18n';

// Reanimated 4 の strict mode は SharedValue.value を render 中に読むと warn を出す。
// 開発中の gesture animation で過剰に出る場合があるため strict だけ off にする。
configureReanimatedLogger({ strict: false });

// 起動高速化後、ready=false の時間が一瞬しかなく ActivityIndicator が
// チラッと出てすぐ消える挙動 (= 固まって見えると誤解される) を防ぐ。
// この時間以上待ってもまだ初期化が終わらない場合だけスピナーを表示する。
const SPINNER_DELAY_MS = 1000;

export default function RootLayout() {
	const { theme, isDark } = useAppTheme();
	const { ready, error } = useInitialize();
	// ready=false が SPINNER_DELAY_MS を超えたら true になる。
	// ready が早く true になればこの state は false のまま、何も表示されない。
	const [showSpinner, setShowSpinner] = useState(false);

	useEffect(() => {
		if (ready) return;
		const timer = setTimeout(() => setShowSpinner(true), SPINNER_DELAY_MS);
		return () => clearTimeout(timer);
	}, [ready]);

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
						// エラーは「固まって見える」問題と無関係なので即座に表示する。
						<Text variant="bodyMedium" style={{ color: theme.colors.error }}>
							{error.message}
						</Text>
					) : showSpinner ? (
						<ActivityIndicator />
					) : null}
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
								<Stack.Screen name="conflict-backups" />
								<Stack.Screen name="settings" />
								<Stack.Screen name="about" />
								<Stack.Screen name="licenses" />
								<Stack.Screen
									name="signin"
									options={{ presentation: 'modal' }}
								/>
								<Stack.Screen name="oauth2redirect" />
							</Stack>
							<ReauthRequiredDialog />
						</BottomSheetModalProvider>
					</PaperProvider>
				</I18nextProvider>
			</SafeAreaProvider>
		</GestureHandlerRootView>
	);
}
