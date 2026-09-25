import { describe, expect, it } from 'vitest';
import { makeNote } from '@/test/helpers';
import { parseRemoteNote, serializeNote } from '../codec';

describe('codec: ノート本体の系譜（syncParentVersion / syncSkipped）', () => {
	it('置き換える版番号と見ずに上書きされた範囲を書き、読み戻せる', () => {
		const text = serializeNote(makeNote({ id: 'a' }), {
			parentVersion: 7,
			skipped: [
				[6, 6],
				[3, 4],
			],
		});
		const raw = JSON.parse(text);
		expect(raw.syncParentVersion).toBe(7);
		expect(raw.syncSkipped).toEqual([
			[3, 4],
			[6, 6],
		]);
		const parsed = parseRemoteNote(text);
		expect(parsed?.note.id).toBe('a');
		expect(parsed?.parentVersion).toBe(7);
		expect(parsed?.skipped).toEqual([
			[3, 4],
			[6, 6],
		]);
	});

	it('新規作成（版番号なし）では何も書かない', () => {
		const text = serializeNote(makeNote({ id: 'a' }), { skipped: [[1, 2]] });
		const raw = JSON.parse(text);
		expect(raw).not.toHaveProperty('syncParentVersion');
		expect(raw).not.toHaveProperty('syncSkipped');
		expect(parseRemoteNote(text)?.parentVersion).toBeUndefined();
	});

	it('範囲が空なら syncSkipped は書かない', () => {
		const raw = JSON.parse(
			serializeNote(makeNote({ id: 'a' }), { parentVersion: 3, skipped: [] }),
		);
		expect(raw).not.toHaveProperty('syncSkipped');
	});

	it('旧クライアントの書き込みや不正な値は「不明」として扱う', () => {
		for (const bad of [0, -1, 1.5, '3', null]) {
			const text = JSON.stringify({ id: 'a', syncParentVersion: bad });
			expect(parseRemoteNote(text)?.parentVersion, String(bad)).toBeUndefined();
		}
		const broken = JSON.stringify({
			id: 'a',
			syncParentVersion: 5,
			syncSkipped: [[2, 1], 'x', [1.5, 2], [3, 3]],
		});
		expect(parseRemoteNote(broken)?.skipped).toEqual([[3, 3]]);
		expect(parseRemoteNote('{"id":"../x"}')).toBeNull();
	});
});
