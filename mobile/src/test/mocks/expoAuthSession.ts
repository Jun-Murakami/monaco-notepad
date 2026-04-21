/**
 * expo-auth-session の最小スタブ。
 * authService を import したコードがロードできるようにするための占位。
 * 実際の OAuth 挙動は単体テスト対象外（別途 integration テストで扱う）。
 */

export const ResponseType = { Code: 'code' } as const;

export class AuthRequest {
	codeVerifier = 'stub-verifier';
	constructor(public readonly params: unknown) {}
	async promptAsync(): Promise<{
		type: 'success' | 'cancel';
		params?: Record<string, string>;
	}> {
		return { type: 'cancel' };
	}
}

export async function exchangeCodeAsync(): Promise<TokenResponse> {
	return new TokenResponse();
}
export async function refreshAsync(): Promise<TokenResponse> {
	return new TokenResponse();
}
export async function revokeAsync(): Promise<boolean> {
	return true;
}
export function makeRedirectUri(opts?: {
	scheme?: string;
	path?: string;
}): string {
	return `${opts?.scheme ?? 'monaconotepad'}://${opts?.path ?? 'oauth'}`;
}

export class TokenResponse {
	accessToken = 'stub-access-token';
	refreshToken = 'stub-refresh-token';
	expiresIn = 3600;
	idToken: string | undefined;
	scope: string | undefined;
}

export type DiscoveryDocument = {
	authorizationEndpoint?: string;
	tokenEndpoint?: string;
	revocationEndpoint?: string;
};

export default {
	ResponseType,
	AuthRequest,
	exchangeCodeAsync,
	refreshAsync,
	revokeAsync,
	makeRedirectUri,
	TokenResponse,
};
