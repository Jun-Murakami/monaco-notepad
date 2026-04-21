import type { ExpoConfig } from 'expo/config';

/**
 * Expo の動的設定。
 *
 * OAuth クライアント ID 等の環境固有値は `.env.local`（gitignore 済）から
 * 注入する。本リポジトリは OSS のため、値の直書きはしない。
 *
 * ローカル開発: `mobile/.env.local` に値を記載
 * EAS Build:   `eas secret:create --name GOOGLE_OAUTH_IOS_CLIENT_ID --value ...`
 *
 * テンプレート: `.env.example` を参照。
 */

const IOS_CLIENT_ID =
	process.env.GOOGLE_OAUTH_IOS_CLIENT_ID ??
	'REPLACE_WITH_IOS_CLIENT_ID.apps.googleusercontent.com';
const ANDROID_CLIENT_ID =
	process.env.GOOGLE_OAUTH_ANDROID_CLIENT_ID ??
	'REPLACE_WITH_ANDROID_CLIENT_ID.apps.googleusercontent.com';
const WEB_CLIENT_ID =
	process.env.GOOGLE_OAUTH_WEB_CLIENT_ID ??
	'REPLACE_WITH_WEB_CLIENT_ID.apps.googleusercontent.com';

/**
 * Google OAuth の native redirect URI 用スキーム。
 * Client ID を逆 DNS 化したものを intent filter / CFBundleURLTypes に登録することで、
 * `com.googleusercontent.apps.<PREFIX>:/oauth2redirect` が本アプリに戻ってくる。
 */
const toReverseDns = (clientId: string) =>
	`com.googleusercontent.apps.${clientId.replace(/\.apps\.googleusercontent\.com$/, '')}`;
const IOS_REVERSE_DNS = toReverseDns(IOS_CLIENT_ID);
const ANDROID_REVERSE_DNS = toReverseDns(ANDROID_CLIENT_ID);

// `newArchEnabled` は Expo SDK 52+ で有効な設定だが @expo/config-types の型が追いついていないため拡張する。
const config: ExpoConfig & { newArchEnabled?: boolean } = {
	name: 'Monaco Notepad',
	slug: 'monaco-notepad',
	version: '0.1.0',
	orientation: 'portrait',
	icon: './assets/icon.png',
	scheme: 'monaconotepad',
	userInterfaceStyle: 'automatic',
	newArchEnabled: true,
	splash: {
		image: './assets/splash.png',
		resizeMode: 'contain',
		backgroundColor: '#ffffff',
	},
	ios: {
		supportsTablet: true,
		bundleIdentifier: 'app.monaconotepad.mobile',
		infoPlist: {
			UIBackgroundModes: ['fetch', 'processing'],
			CFBundleURLTypes: [
				// Google OAuth callback (reverse-DNS of iOS client ID)
				{ CFBundleURLSchemes: [IOS_REVERSE_DNS] },
			],
		},
	},
	android: {
		adaptiveIcon: {
			foregroundImage: './assets/adaptive-icon.png',
			backgroundColor: '#ffffff',
		},
		package: 'app.monaconotepad.mobile',
		intentFilters: [
			{
				action: 'VIEW',
				category: ['BROWSABLE', 'DEFAULT'],
				data: [{ scheme: ANDROID_REVERSE_DNS }],
			},
		],
	},
	web: {
		bundler: 'metro',
		output: 'static',
		favicon: './assets/favicon.png',
	},
	plugins: ['expo-router', 'expo-secure-store'],
	experiments: {
		typedRoutes: true,
	},
	extra: {
		googleOAuthIosClientId: IOS_CLIENT_ID,
		googleOAuthAndroidClientId: ANDROID_CLIENT_ID,
		googleOAuthWebClientId: WEB_CLIENT_ID,
	},
};

export default config;
