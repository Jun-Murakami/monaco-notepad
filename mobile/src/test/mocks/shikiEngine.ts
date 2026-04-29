/**
 * react-native-shiki-engine の Vitest 用スタブ。
 * テストでは native engine を使えないので「利用不可」を返す。
 * 実際の Shiki tokenize を流したい場合は @shikijs/engine-javascript を別途
 * 注入してテストする方針（現状は SyntaxHighlightView レベルの単体テストでは
 * highlighter を全体モックする）。
 */
export function isNativeEngineAvailable(): boolean {
	return false;
}

export function createNativeEngine(): never {
	throw new Error('native engine is not available in test environment');
}
