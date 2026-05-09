/**
 * authService の「Drive 接続が切れたまま気付かない」防止ロジックのテスト。
 *
 * カバー対象:
 *   - refresh() で invalid_grant 系エラー → signOut + drive:reauth-required を発火
 *   - refresh() でネットワーク系エラー → signOut しない、reauth 通知も飛ばさない
 *   - notifyReauthRequired() の重複抑止 (1 オフラインセッション = 1 通知)
 *   - persistTokenResult / signIn 後にフラグがリセットされ、再度通知できる
 */
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncEvents } from '../../sync/events';
import { AuthService } from '../authService';

const TOKEN_KEY = 'monaco-notepad.oauth';

// expo-constants の OAuth client ID 解決をテスト中だけ通せるよう、必要な値を seed する。
vi.mock('expo-constants', () => ({
	default: {
		expoConfig: {
			extra: {
				googleOAuthIosClientId: 'test-ios-client.apps.googleusercontent.com',
				googleOAuthAndroidClientId:
					'test-android-client.apps.googleusercontent.com',
				googleOAuthWebClientId: 'test-web-client.apps.googleusercontent.com',
			},
		},
	},
}));

async function seedToken(refreshToken = 'rt-1') {
	await SecureStore.setItemAsync(
		TOKEN_KEY,
		JSON.stringify({
			accessToken: 'at-1',
			refreshToken,
			// 既に期限切れ (= refresh が走る)
			expiresAt: Date.now() - 60_000,
		}),
	);
}

describe('AuthService.refresh + notifyReauthRequired', () => {
	let svc: AuthService;
	let captured: Array<{ reason: string; detail?: string }>;
	let unsubscribe: () => void;

	beforeEach(async () => {
		svc = new AuthService();
		captured = [];
		unsubscribe = syncEvents.on('drive:reauth-required', (p) => {
			captured.push({ reason: p.reason, detail: p.detail });
		});
		await seedToken();
		await svc.load();
	});

	afterEach(() => {
		unsubscribe();
		vi.restoreAllMocks();
	});

	it('refresh が invalid_grant を投げると signOut + reauth 通知が発火', async () => {
		const refreshSpy = vi
			.spyOn(AuthSession, 'refreshAsync')
			.mockRejectedValueOnce(new Error('invalid_grant: token expired'));

		await expect(svc.getAccessToken()).rejects.toThrow();
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		// signOut が走ってトークンが消えている
		expect(svc.isSignedIn()).toBe(false);
		expect(await SecureStore.getItemAsync(TOKEN_KEY)).toBeNull();
		// 再ログイン要求イベント発火
		expect(captured).toEqual([
			expect.objectContaining({ reason: 'invalid_grant' }),
		]);
	});

	it('refresh がネットワーク系エラーでは signOut も reauth 通知もしない', async () => {
		vi.spyOn(AuthSession, 'refreshAsync').mockRejectedValueOnce(
			new Error('Network request failed'),
		);

		await expect(svc.getAccessToken()).rejects.toThrow();
		// 一時的失敗扱い: トークンを保持し signed-in 状態は維持
		expect(svc.isSignedIn()).toBe(true);
		expect(await SecureStore.getItemAsync(TOKEN_KEY)).not.toBeNull();
		// reauth 通知も飛ばさない (polling 側のリトライに委ねる)
		expect(captured).toEqual([]);
	});

	it('notifyReauthRequired は同一セッションで 1 度だけ発火', () => {
		svc.notifyReauthRequired('invalid_grant', 'first');
		svc.notifyReauthRequired('invalid_grant', 'second');
		svc.notifyReauthRequired('polling_failed', 'third');
		expect(captured).toHaveLength(1);
		expect(captured[0]).toEqual({ reason: 'invalid_grant', detail: 'first' });
	});

	it('resetReauthNotified() 後は再度通知できる', () => {
		svc.notifyReauthRequired('invalid_grant');
		expect(captured).toHaveLength(1);
		svc.notifyReauthRequired('invalid_grant'); // 抑止される
		expect(captured).toHaveLength(1);

		svc.resetReauthNotified();
		svc.notifyReauthRequired('polling_failed');
		expect(captured).toHaveLength(2);
		expect(captured[1]).toEqual(
			expect.objectContaining({ reason: 'polling_failed' }),
		);
	});

	it('refresh 成功 (persistTokenResult) で reauth フラグがリセットされる', async () => {
		// 一度通知
		svc.notifyReauthRequired('polling_failed');
		expect(captured).toHaveLength(1);

		// 直後に成功した refresh が走る (テスト中のモック TokenResponse は引数不要)
		vi.spyOn(AuthSession, 'refreshAsync').mockResolvedValueOnce({
			accessToken: 'at-2',
			refreshToken: 'rt-2',
			expiresIn: 3600,
		} as unknown as AuthSession.TokenResponse);
		await svc.getAccessToken();

		// 同じセッション中の再オフラインでも改めて通知できる
		svc.notifyReauthRequired('polling_failed');
		expect(captured).toHaveLength(2);
	});

	it('refresh_token が無い状態で getAccessToken → invalid_grant 扱いで通知', async () => {
		// refresh_token を空にしたトークンを seed
		await SecureStore.setItemAsync(
			TOKEN_KEY,
			JSON.stringify({
				accessToken: 'at-no-rt',
				expiresAt: Date.now() - 60_000,
			}),
		);
		const fresh = new AuthService();
		await fresh.load();
		const localCaptured: string[] = [];
		const off = syncEvents.on('drive:reauth-required', (p) =>
			localCaptured.push(p.reason),
		);
		try {
			await expect(fresh.getAccessToken()).rejects.toThrow();
			expect(localCaptured).toEqual(['invalid_grant']);
		} finally {
			off();
		}
	});
});
