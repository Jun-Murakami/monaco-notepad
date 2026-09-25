import { describe, expect, it } from 'vitest';
import { makeNote } from '@/test/helpers';
import { computeContentHash } from '../hash';

describe('computeContentHash', () => {
	it('同じ入力で同じハッシュを返す', async () => {
		const note = makeNote({ id: 'a', title: 'hello', content: 'world' });
		const h1 = await computeContentHash(note);
		const h2 = await computeContentHash({ ...note });
		expect(h1).toBe(h2);
		expect(h1).toMatch(/^[a-f0-9]{64}$/);
	});

	it('title/content/language/archived の変更はハッシュに影響する', async () => {
		const base = makeNote({ id: 'a', title: 't', content: 'c' });
		const baseH = await computeContentHash(base);
		expect(await computeContentHash({ ...base, title: 't2' })).not.toBe(baseH);
		expect(await computeContentHash({ ...base, content: 'c2' })).not.toBe(
			baseH,
		);
		expect(
			await computeContentHash({ ...base, language: 'typescript' }),
		).not.toBe(baseH);
		expect(await computeContentHash({ ...base, archived: true })).not.toBe(
			baseH,
		);
	});

	it('folderId の変更はハッシュに影響しない（ローカルメタデータ扱い）', async () => {
		const base = makeNote({ id: 'a', folderId: '' });
		const h1 = await computeContentHash(base);
		const h2 = await computeContentHash({ ...base, folderId: 'folder-123' });
		expect(h1).toBe(h2);
	});

	it('modifiedTime の変更はハッシュに影響しない', async () => {
		const base = makeNote({
			id: 'a',
			modifiedTime: '2026-01-01T00:00:00.000Z',
		});
		const h1 = await computeContentHash(base);
		const h2 = await computeContentHash({
			...base,
			modifiedTime: '2026-06-01T12:00:00.000Z',
		});
		expect(h1).toBe(h2);
	});
});
