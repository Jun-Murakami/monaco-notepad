import { describe, expect, it } from 'vitest';
import { makeNote } from '@/test/helpers';
import { parseRemoteNote, serializeNote } from '../codec';

describe('codec: ノート本体の syncParentVersion', () => {
	it('置き換える版番号を書き、読み戻せる', () => {
		const text = serializeNote(makeNote({ id: 'a' }), 7);
		expect(JSON.parse(text).syncParentVersion).toBe(7);
		expect(parseRemoteNote(text)?.parentVersion).toBe(7);
		expect(parseRemoteNote(text)?.note.id).toBe('a');
	});

	it('新規作成（版番号なし）では書かない', () => {
		const text = serializeNote(makeNote({ id: 'a' }));
		expect(JSON.parse(text)).not.toHaveProperty('syncParentVersion');
		expect(parseRemoteNote(text)?.parentVersion).toBeUndefined();
	});

	it('旧クライアントの書き込みや不正な値は「不明」として扱う', () => {
		for (const bad of [0, -1, 1.5, '3', null]) {
			const text = JSON.stringify({ id: 'a', syncParentVersion: bad });
			expect(parseRemoteNote(text)?.parentVersion, String(bad)).toBeUndefined();
		}
		expect(parseRemoteNote('{"id":"../x"}')).toBeNull();
	});
});
