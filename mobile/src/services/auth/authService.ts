import * as AuthSession from 'expo-auth-session';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
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

const TOKEN_KEY = 'monaco-notepad:oauth';
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

export class AuthService {
	private token: StoredToken | null = null;
	private refreshPromise: Promise<void> | null = null;
	private listeners = new Set<Listener>();

	async load(): Promise<void> {
		const raw = await SecureStore.getItemAsync(TOKEN_KEY);
		if (!raw) return;
		try {
			this.token = JSON.parse(raw) as StoredToken;
		} catch {
			this.token = null;
		}
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
		const redirectUri = AuthSession.makeRedirectUri({
			scheme: 'monaconotepad',
			path: 'oauth',
		});
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
				extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : undefined,
			},
			DISCOVERY,
		);
		await this.persistTokenResult(tokenResult);
	}

	/** 有効な access_token を返す。期限切れなら refresh する。 */
	async getAccessToken(): Promise<string> {
		if (!this.token) throw new Error('Not signed in');
		if (this.isExpired()) {
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

	private async refresh(): Promise<void> {
		if (this.refreshPromise) return this.refreshPromise;
		if (!this.token?.refreshToken) {
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
				console.warn('[Auth] refresh failed; signing out:', e);
				await this.signOut();
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

	private async persistTokenResult(r: AuthSession.TokenResponse): Promise<void> {
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
		this.emit({ signedIn: true });
	}

	private resolveClientId(): string {
		const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string>;
		if (Platform.OS === 'ios' && extra.googleOAuthIosClientId) return extra.googleOAuthIosClientId;
		if (Platform.OS === 'android' && extra.googleOAuthAndroidClientId)
			return extra.googleOAuthAndroidClientId;
		if (extra.googleOAuthWebClientId) return extra.googleOAuthWebClientId;
		throw new Error(
			'Google OAuth client ID is not configured. Set googleOAuth*ClientId in app.json → extra.',
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
