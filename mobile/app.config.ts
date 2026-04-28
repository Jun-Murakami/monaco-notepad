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
	// トップレベル icon は Web (favicon を別指定してもフォールバック先になる) と
	// 旧 Android 7 以下向けのレガシーアイコンとして使用される。
	icon: './assets/icon.png',
	scheme: 'monaconotepad',
	userInterfaceStyle: 'automatic',
	newArchEnabled: true,
	// 旧 splash キーは SDK 55 で deprecated。expo-splash-screen プラグイン (plugins 配列) で設定する。
	ios: {
		supportsTablet: true,
		bundleIdentifier: 'dev.junmurakami.monaconotepad',
		// iOS 18+ のホーム画面 light/dark/tinted 表示に対応。
		// 各 1024x1024 PNG。dark/tinted を省略すると OS が light を流用する。
		icon: {
			light: './assets/icon-ios-light.png',
			dark: './assets/icon-ios-dark.png',
			tinted: './assets/icon-ios-tinted.png',
		},
		infoPlist: {
			UIBackgroundModes: ['fetch', 'processing'],
			CFBundleURLTypes: [
				// Google OAuth callback (reverse-DNS of iOS client ID)
				{ CFBundleURLSchemes: [IOS_REVERSE_DNS] },
			],
			// 米国輸出規制 (Encryption Export Compliance) の自己申告。
			// 本アプリは HTTPS / Keychain / SHA-256 など標準・適用除外の暗号のみ使用するため
			// false 固定で OK。これにより毎回 App Store Connect で申告する手間が省ける。
			ITSAppUsesNonExemptEncryption: false,
		},
	},
	android: {
		adaptiveIcon: {
			// 1024x1024、中央 ~626px 円内に収めた前景レイヤー。
			foregroundImage: './assets/adaptive-foreground.png',
			// 背景はグラデーション PNG。ロード失敗時用に backgroundColor も同系色を指定。
			backgroundImage: './assets/adaptive-background.png',
			backgroundColor: '#60c0d0',
			// Android 13+ のテーマアイコン（壁紙色で OS が再着色）。アルファのみ参照される。
			monochromeImage: './assets/adaptive-monochrome.png',
		},
		package: 'dev.junmurakami.monaconotepad',
		// ノート本文・同期状態は端末ローカルに保存されるため、Android Auto Backup
		// 経由で別端末/再インストール時に復元されないよう明示的に無効化する。
		allowBackup: false,
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
	plugins: [
		'expo-router',
		'expo-secure-store',
		[
			'expo-splash-screen',
			{
				image: './assets/splash.png',
				imageWidth: 200,
				resizeMode: 'contain',
				backgroundColor: '#60c0d0',
				dark: {
					// アイコンは light/dark 共通。背景色のみ切り替える。
					image: './assets/splash.png',
					backgroundColor: '#1e1e1e',
				},
			},
		],
	],
	experiments: {
		typedRoutes: true,
	},
	extra: {
		googleOAuthIosClientId: IOS_CLIENT_ID,
		googleOAuthAndroidClientId: ANDROID_CLIENT_ID,
		googleOAuthWebClientId: WEB_CLIENT_ID,
		eas: {
			projectId: 'b5e4d780-4e2a-4387-a514-d893989794c6',
		},
	},
};

export default config;
