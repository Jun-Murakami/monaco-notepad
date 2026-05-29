import { describe, expect, it } from 'vitest';
import { isSafeNoteId, NOTES_DIR, noteFilePath } from '../paths';

describe('isSafeNoteId', () => {
	it('正当な ID（UUID v4 / タイムスタンプ）は許可する', () => {
		for (const id of [
			'550e8400-e29b-41d4-a716-446655440000',
			'abc_DEF-123',
			'1700000000000',
		]) {
			expect(isSafeNoteId(id)).toBe(true);
		}
	});

	it('パストラバーサル・区切り文字・空・特殊値・制御文字を拒否する', () => {
		for (const id of [
			'',
			'.',
			'..',
			'../evil',
			'..\\evil',
			'foo/bar',
			'foo\\bar',
			'../../sync_state',
			'..\\..\\..\\token',
			'a/../../b',
			'tab\tinside',
		]) {
			expect(isSafeNoteId(id)).toBe(false);
		}
	});
});

describe('noteFilePath', () => {
	it('安全な ID は NOTES_DIR 配下のパスを返す', () => {
		const id = '550e8400-e29b-41d4-a716-446655440000';
		expect(noteFilePath(id)).toBe(`${NOTES_DIR}${id}.json`);
	});

	it('危険な ID は例外を投げ、ディレクトリ外パスを生成しない', () => {
		expect(() => noteFilePath('../../sync_state')).toThrow(/unsafe note id/);
		expect(() => noteFilePath('a/b')).toThrow(/unsafe note id/);
	});
});
