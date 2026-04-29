import { afterEach, describe, expect, it } from 'vitest';
import {
	_resetHighlighterForTest,
	ensureLanguage,
	getHighlighter,
	SHIKI_THEME_DARK,
	SHIKI_THEME_LIGHT,
} from '../highlighter';

describe('highlighter (no native engine)', () => {
	afterEach(() => {
		_resetHighlighterForTest();
	});

	it('rejects when native engine is unavailable (Vitest mocks it as such)', async () => {
		await expect(getHighlighter()).rejects.toThrow(/native module/);
	});

	it('allows retry after a failed init by clearing the cached promise', async () => {
		await expect(getHighlighter()).rejects.toThrow();
		// 2 回目: rejection 後に再 try できる（cache が剥がされる）。
		// native は依然 unavailable なので reject 自体は同じ。
		await expect(getHighlighter()).rejects.toThrow();
	});

	it('ensureLanguage no-ops for plaintext / text without touching highlighter', async () => {
		await expect(ensureLanguage('plaintext')).resolves.toBeUndefined();
		await expect(ensureLanguage('text')).resolves.toBeUndefined();
	});

	it('ensureLanguage no-ops for unknown ids (no loader registered)', async () => {
		await expect(
			ensureLanguage('totally-not-a-language'),
		).resolves.toBeUndefined();
	});

	it('exports the expected theme constants', () => {
		expect(SHIKI_THEME_DARK).toBe('dark-plus');
		expect(SHIKI_THEME_LIGHT).toBe('light-plus');
	});
});
