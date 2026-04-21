import { afterEach, vi } from 'vitest';

// Expo / RN の native モジュール群を in-memory 実装に差し替える。
// 実装は src/test/mocks/ 配下にまとまっている。
vi.mock('expo-file-system', async () => await import('./src/test/mocks/expoFileSystem'));
vi.mock('expo-crypto', async () => await import('./src/test/mocks/expoCrypto'));
vi.mock('expo-secure-store', async () => await import('./src/test/mocks/expoSecureStore'));
vi.mock('expo-localization', async () => await import('./src/test/mocks/expoLocalization'));
vi.mock('expo-auth-session', async () => await import('./src/test/mocks/expoAuthSession'));
vi.mock('expo-constants', async () => await import('./src/test/mocks/expoConstants'));
vi.mock('@react-native-community/netinfo', async () =>
	await import('./src/test/mocks/netinfo'),
);
vi.mock('react-native', async () => await import('./src/test/mocks/reactNative'));

// 各テスト後にモック状態をリセット。
afterEach(async () => {
	const { resetFileSystem } = await import('./src/test/mocks/expoFileSystem');
	const { resetSecureStore } = await import('./src/test/mocks/expoSecureStore');
	resetFileSystem();
	resetSecureStore();
});
