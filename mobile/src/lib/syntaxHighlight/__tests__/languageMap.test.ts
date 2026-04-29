import { describe, expect, it } from 'vitest';
import { MONACO_LANGUAGE_IDS } from '@/constants/monacoLanguages';
import {
	isMonacoLanguageSupportedOnMobile,
	SUPPORTED_MONACO_IDS,
	toShikiLanguage,
	UNSUPPORTED_MONACO_IDS,
} from '../languageMap';

describe('languageMap', () => {
	describe('toShikiLanguage', () => {
		it('returns plaintext for null/undefined/empty', () => {
			expect(toShikiLanguage(null)).toBe('plaintext');
			expect(toShikiLanguage(undefined)).toBe('plaintext');
			expect(toShikiLanguage('')).toBe('plaintext');
		});

		it('passes through identity-mapped Monaco IDs', () => {
			expect(toShikiLanguage('javascript')).toBe('javascript');
			expect(toShikiLanguage('typescript')).toBe('typescript');
			expect(toShikiLanguage('python')).toBe('python');
			expect(toShikiLanguage('rust')).toBe('rust');
		});

		it('maps Monaco IDs that differ from Shiki IDs', () => {
			expect(toShikiLanguage('dockerfile')).toBe('docker');
			expect(toShikiLanguage('mips')).toBe('mipsasm');
			expect(toShikiLanguage('protobuf')).toBe('proto');
			expect(toShikiLanguage('restructuredtext')).toBe('rst');
			expect(toShikiLanguage('shell')).toBe('shellscript');
			expect(toShikiLanguage('systemverilog')).toBe('system-verilog');
		});

		it('falls back SQL dialects to sql', () => {
			expect(toShikiLanguage('mysql')).toBe('sql');
			expect(toShikiLanguage('pgsql')).toBe('sql');
			expect(toShikiLanguage('redshift')).toBe('sql');
			expect(toShikiLanguage('redis')).toBe('sql');
			expect(toShikiLanguage('msdax')).toBe('sql');
		});

		it('falls back pascaligo to pascal', () => {
			expect(toShikiLanguage('pascaligo')).toBe('pascal');
		});

		it('returns plaintext for unsupported languages', () => {
			expect(toShikiLanguage('azcli')).toBe('plaintext');
			expect(toShikiLanguage('csp')).toBe('plaintext');
			expect(toShikiLanguage('qsharp')).toBe('plaintext');
			expect(toShikiLanguage('flow9')).toBe('plaintext');
		});
	});

	describe('SUPPORTED_MONACO_IDS', () => {
		it('excludes all UNSUPPORTED_MONACO_IDS', () => {
			for (const id of UNSUPPORTED_MONACO_IDS) {
				expect(SUPPORTED_MONACO_IDS).not.toContain(id);
			}
		});

		it('includes plaintext (always selectable)', () => {
			expect(SUPPORTED_MONACO_IDS).toContain('plaintext');
		});

		it('contains every Monaco ID that is not unsupported', () => {
			const expected = MONACO_LANGUAGE_IDS.filter(
				(id) => !UNSUPPORTED_MONACO_IDS.has(id),
			);
			expect([...SUPPORTED_MONACO_IDS]).toEqual(expected);
		});

		it('covers the bulk of Monaco IDs (≥ 80%)', () => {
			const ratio = SUPPORTED_MONACO_IDS.length / MONACO_LANGUAGE_IDS.length;
			expect(ratio).toBeGreaterThanOrEqual(0.8);
		});
	});

	describe('isMonacoLanguageSupportedOnMobile', () => {
		it('returns true for supported', () => {
			expect(isMonacoLanguageSupportedOnMobile('javascript')).toBe(true);
			expect(isMonacoLanguageSupportedOnMobile('mysql')).toBe(true); // sql fallback
		});

		it('returns false for unsupported', () => {
			expect(isMonacoLanguageSupportedOnMobile('azcli')).toBe(false);
			expect(isMonacoLanguageSupportedOnMobile('qsharp')).toBe(false);
		});
	});
});
