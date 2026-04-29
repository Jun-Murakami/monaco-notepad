/**
 * Shiki Highlighter のシングルトン管理。
 *
 * 起動時に grammar を一切ロードせずに Highlighter を立ち上げ、
 * `ensureLanguage(id)` が呼ばれた時点で当該 grammar を遅延ロードする。
 *
 * ハイライトエンジンは `react-native-shiki-engine` の `createNativeEngine()`
 * (JSI + 直リンク Oniguruma、VSCode/Monaco と同一エンジン)。Native module が
 * 利用できない環境（vitest / web / prebuild 未実行）では Highlighter は
 * 生成されず、`getHighlighter()` は reject する。呼び出し側 (SyntaxHighlightView)
 * は失敗時に素の monospace テキストへ静かにフォールバックする。
 */
import { createHighlighterCore, type HighlighterCore } from '@shikijs/core';
import darkPlus from '@shikijs/themes/dark-plus';
import lightPlus from '@shikijs/themes/light-plus';
import {
	createNativeEngine,
	isNativeEngineAvailable,
} from 'react-native-shiki-engine';
import { SHIKI_LANGUAGE_LOADERS } from './languageLoaders';

export const SHIKI_THEME_DARK = 'dark-plus';
export const SHIKI_THEME_LIGHT = 'light-plus';

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLanguages = new Set<string>();
const inFlightLoads = new Map<string, Promise<void>>();

/**
 * Highlighter のシングルトンを取得する。初回呼び出し時に初期化が走る。
 * Native engine が無い環境では reject する。
 */
export function getHighlighter(): Promise<HighlighterCore> {
	if (!highlighterPromise) {
		highlighterPromise = (async () => {
			if (!isNativeEngineAvailable()) {
				throw new Error(
					'react-native-shiki-engine native module is not available. Run `npx expo prebuild` and rebuild the app.',
				);
			}
			return createHighlighterCore({
				themes: [darkPlus, lightPlus],
				langs: [],
				engine: createNativeEngine(),
			});
		})();
		// reject が swallow されないようハンドリング: 次回 getHighlighter() で
		// 再試行できるよう Promise を捨てる。
		highlighterPromise.catch(() => {
			highlighterPromise = null;
		});
	}
	return highlighterPromise;
}

/**
 * 指定の Shiki language ID を Highlighter にロードする。
 * 既にロード済み or SpecialLanguage（plaintext 等）なら何もしない。
 *
 * 同じ言語が並行リクエストされても loadLanguage を 1 回だけ呼ぶように
 * inFlightLoads で同期する。
 */
export async function ensureLanguage(shikiId: string): Promise<void> {
	if (shikiId === 'plaintext' || shikiId === 'text') return;
	if (loadedLanguages.has(shikiId)) return;

	const inFlight = inFlightLoads.get(shikiId);
	if (inFlight) return inFlight;

	const loader = SHIKI_LANGUAGE_LOADERS[shikiId];
	if (!loader) return;

	const promise = (async () => {
		try {
			const highlighter = await getHighlighter();
			const grammar = await loader();
			await highlighter.loadLanguage(grammar);
			loadedLanguages.add(shikiId);
		} finally {
			inFlightLoads.delete(shikiId);
		}
	})();
	inFlightLoads.set(shikiId, promise);
	return promise;
}

/**
 * テスト用: シングルトン状態をリセット。
 * 本番コードからは使わない。
 */
export function _resetHighlighterForTest(): void {
	highlighterPromise = null;
	loadedLanguages.clear();
	inFlightLoads.clear();
}
