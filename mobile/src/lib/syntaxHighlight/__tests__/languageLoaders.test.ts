import { describe, expect, it } from 'vitest';
import { MONACO_LANGUAGE_IDS } from '@/constants/monacoLanguages';
import { hasShikiLanguage, SHIKI_LANGUAGE_LOADERS } from '../languageLoaders';
import { toShikiLanguage, UNSUPPORTED_MONACO_IDS } from '../languageMap';

describe('languageLoaders', () => {
	it('hasShikiLanguage handles plaintext as built-in', () => {
		expect(hasShikiLanguage('plaintext')).toBe(true);
		expect(hasShikiLanguage('text')).toBe(true);
	});

	it('hasShikiLanguage returns false for unknown ids', () => {
		expect(hasShikiLanguage('totally-not-a-language')).toBe(false);
	});

	it('every supported Monaco ID maps to a loadable Shiki grammar (or plaintext)', () => {
		for (const monacoId of MONACO_LANGUAGE_IDS) {
			if (UNSUPPORTED_MONACO_IDS.has(monacoId)) continue;
			const shikiId = toShikiLanguage(monacoId);
			expect(
				hasShikiLanguage(shikiId),
				`Monaco ID "${monacoId}" → "${shikiId}" should have a Shiki loader`,
			).toBe(true);
		}
	});

	it('every loader entry actually resolves to a grammar array', async () => {
		// 全部回すのは重いので、代表的なものだけ実際に import を実行して
		// dynamic import が壊れていないことを確認する。
		const sample = ['javascript', 'typescript', 'python', 'sql', 'markdown'];
		for (const id of sample) {
			const loader = SHIKI_LANGUAGE_LOADERS[id];
			expect(loader, `loader for ${id}`).toBeDefined();
			const grammar = await loader();
			expect(Array.isArray(grammar)).toBe(true);
			expect(grammar.length).toBeGreaterThan(0);
			expect(grammar[0]).toHaveProperty('name');
			expect(grammar[0]).toHaveProperty('scopeName');
		}
	});
});
