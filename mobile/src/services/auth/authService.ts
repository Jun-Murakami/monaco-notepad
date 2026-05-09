import * as AuthSession from 'expo-auth-session';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { type DriveReauthReason, syncEvents } from '../sync/events';
import { DRIVE_SCOPES } from '../sync/types';

/**
 * Google OAuth2 認証サービス。
 *
 * デスクトップ版とは異なり、モバイルでは refresh_token による自動更新を実装する：
 * - 初回ログイン: Authorization Code + PKCE で access_token + refresh_token を取得
 * - API 呼び出し前: 期限切れなら refresh_token で自動更新
 * - ログアウト: SecureStore 上の token を全削除
 *
 * SecureStore は iOS Keychain / Android Keystore を透過的に使う。
 */

// SecureStore のキーは英数字 / `.` / `-` / `_` のみ許容される
const TOKEN_KEY = 'monaco-notepad.oauth';
const DISCOVERY: AuthSession.DiscoveryDocument = {
	authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
	tokenEndpoint: 'https://oauth2.googleapis.com/token',
	revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

interface StoredToken {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number; // epoch ms
	idToken?: string;
	scope?: string;
}

export interface AuthStateChange {
	signedIn: boolean;
}

type Listener = (state: AuthStateChange) => void;

/**
 * `expo-auth-session` の refresh エラーが「refresh_token 失効」を示すかを判定する。
 * Google OAuth は `error_description: invalid_grant` を返してくるが、SDK が wrap した
 * Error の `message` に文字列として現れることが多い。
 *
 * 失効と判定したら sign-out + 再ログインダイアログ。判定しなければ
 * (ネットワーク不通など) signOut せず、polling 側のリトライに任せる。
 */
function isInvalidGrantError(err: unknown): boolean {
	const msg =
		err instanceof Error ? err.message : String(err ?? '').toLowerCase();
	return /invalid_grant|invalid grant|token has been expired|revoked/i.test(
		msg,
	);
}

export class AuthService {
	private token: StoredToken | null = null;
	private refreshPromise: Promise<void> | null = null;
	private listeners = new Set<Listener>();
	// drive:reauth-required の重複抑止フラグ。サインイン成功時にリセットされる。
	private reauthNotified = false;
	// load() の冪等化フラグ。SecureStore (iOS Keychain / Android Keystore) は
	// ネイティブ往復が重く ~300ms かかるため、起動シーケンスで複数経路から呼ばれても
	// 1 回しか読まないようにする。signOut/persistTokenResult は in-memory token も
	// 即時更新しているので、再読み込みする必要はない。
	private loaded = false;

	async load(): Promise<void> {
		if (this.loaded) return;
		const raw = await SecureStore.getItemAsync(TOKEN_KEY);
		if (raw) {
			try {
				this.token = JSON.parse(raw) as StoredToken;
			} catch {
				this.token = null;
			}
		}
		this.loaded = true;
	}

	isSignedIn(): boolean {
		return this.token !== null;
	}

	onAuthChange(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** サインインフロー。呼び出し側では React component の中で useAuthRequest を使うのが推奨だが、
	 *  素の Promise でも使えるようにラップ。 */
	async signIn(): Promise<void> {
		const clientId = this.resolveClientId();
		const redirectUri = this.buildRedirectUri(clientId);
		const request = new AuthSession.AuthRequest({
			clientId,
			scopes: DRIVE_SCOPES,
			redirectUri,
			usePKCE: true,
			responseType: AuthSession.ResponseType.Code,
			extraParams: { access_type: 'offline', prompt: 'consent' },
		});
		const result = await request.promptAsync(DISCOVERY);
		if (result.type !== 'success' || !result.params.code) {
			throw new Error(`Sign-in cancelled or failed: ${result.type}`);
		}
		const tokenResult = await AuthSession.exchangeCodeAsync(
			{
				clientId,
				code: result.params.code,
				redirectUri,
				extraParams: request.codeVerifier
					? { code_verifier: request.codeVerifier }
					: undefined,
			},
			DISCOVERY,
		);
		await this.persistTokenResult(tokenResult);
	}

	/**
	 * 有効な access_token を返す。期限切れなら refresh する。
	 *
	 * `opts.force` を真にすると、`isExpired()` が偽でも強制的に refresh する。
	 * Drive API から 401 が返ってきた直後など、ローカルの expiresAt と
	 * サーバ実際の token 状態がズレているケースで使う。
	 */
	async getAccessToken(opts?: { force?: boolean }): Promise<string> {
		if (!this.token) throw new Error('Not signed in');
		if (opts?.force || this.isExpired()) {
			await this.refresh();
		}
		if (!this.token) throw new Error('Not signed in');
		return this.token.accessToken;
	}

	async signOut(): Promise<void> {
		if (this.token?.refreshToken) {
			try {
				await AuthSession.revokeAsync(
					{ token: this.token.refreshToken, clientId: this.resolveClientId() },
					DISCOVERY,
				);
			} catch (e) {
				console.warn('[Auth] revoke failed:', e);
			}
		}
		this.token = null;
		await SecureStore.deleteItemAsync(TOKEN_KEY);
		this.emit({ signedIn: false });
	}

	/**
	 * 「再ログインが必要」をユーザーに能動的に通知する。同じセッションで複数回
	 * 飛ばさないよう reauthNotified フラグで抑止する。サインイン成功でリセット。
	 */
	notifyReauthRequired(reason: DriveReauthReason, detail?: string): void {
		if (this.reauthNotified) return;
		this.reauthNotified = true;
		syncEvents.emit('drive:reauth-required', { reason, detail });
	}

	/** 接続復帰やサインイン成功時に呼ばれ、再通知を可能にする。 */
	resetReauthNotified(): void {
		this.reauthNotified = false;
	}

	private async refresh(): Promise<void> {
		if (this.refreshPromise) return this.refreshPromise;
		if (!this.token?.refreshToken) {
			// refresh_token そのものがない = 失効と同じ扱い
			this.notifyReauthRequired('invalid_grant', 'No refresh token');
			await this.signOut();
			throw new Error('No refresh token; re-login required');
		}
		const clientId = this.resolveClientId();
		const refreshToken = this.token.refreshToken;
		this.refreshPromise = (async () => {
			try {
				const refreshed = await AuthSession.refreshAsync(
					{ clientId, refreshToken },
					DISCOVERY,
				);
				await this.persistTokenResult(refreshed);
			} catch (e) {
				if (isInvalidGrantError(e)) {
					// refresh_token 失効/取り消し → 再ログイン必須
					console.warn(
						'[Auth] refresh failed (invalid_grant); signing out:',
						e,
					);
					this.notifyReauthRequired(
						'invalid_grant',
						e instanceof Error ? e.message : String(e),
					);
					await this.signOut();
				} else {
					// ネットワーク不通など一時的失敗 → token は残し、polling のリトライに委ねる。
					// signOut しないので signedIn 状態は維持され、UI は「サインイン中だが
					// 一時的にオフライン」と表示される。
					console.warn('[Auth] refresh failed (transient); keeping token:', e);
				}
				throw e;
			} finally {
				this.refreshPromise = null;
			}
		})();
		return this.refreshPromise;
	}

	private isExpired(): boolean {
		if (!this.token) return true;
		return this.token.expiresAt - 60_000 < Date.now();
	}

	private async persistTokenResult(
		r: AuthSession.TokenResponse,
	): Promise<void> {
		const now = Date.now();
		const expiresIn = r.expiresIn ?? 3600;
		this.token = {
			accessToken: r.accessToken,
			refreshToken: r.refreshToken ?? this.token?.refreshToken,
			expiresAt: now + expiresIn * 1000,
			idToken: r.idToken,
			scope: r.scope,
		};
		await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(this.token));
		// トークンが更新できた = Drive 接続復活、次回オフライン時に再度通知できるようにする。
		this.reauthNotified = false;
		this.emit({ signedIn: true });
	}

	/**
	 * Google Android/iOS OAuth クライアント専用の redirect URI を構築する。
	 * Google は任意のカスタムスキームを許容せず、Client ID を逆 DNS 化した
	 * `com.googleusercontent.apps.<CLIENT_ID_PREFIX>:/oauth2redirect` のみを受け付ける。
	 * 対応するスキームは `app.config.ts` 側で intent filter / CFBundleURLTypes にも登録している。
	 */
	private buildRedirectUri(clientId: string): string {
		if (Platform.OS === 'android' || Platform.OS === 'ios') {
			const prefix = clientId.replace(/\.apps\.googleusercontent\.com$/, '');
			return `com.googleusercontent.apps.${prefix}:/oauth2redirect`;
		}
		// Web (dev only) は Expo 標準のスキーム解決に任せる
		return AuthSession.makeRedirectUri({
			scheme: 'monaconotepad',
			path: 'oauth',
		});
	}

	private resolveClientId(): string {
		const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string>;
		if (Platform.OS === 'ios' && extra.googleOAuthIosClientId)
			return extra.googleOAuthIosClientId;
		if (Platform.OS === 'android' && extra.googleOAuthAndroidClientId)
			return extra.googleOAuthAndroidClientId;
		if (extra.googleOAuthWebClientId) return extra.googleOAuthWebClientId;
		throw new Error(
			'Google OAuth client ID is not configured. Set GOOGLE_OAUTH_*_CLIENT_ID in mobile/.env.local (see .env.example).',
		);
	}

	private emit(change: AuthStateChange): void {
		for (const l of this.listeners) {
			try {
				l(change);
			} catch (e) {
				console.warn('[Auth] listener failed:', e);
			}
		}
	}
}

export const authService = new AuthService();
