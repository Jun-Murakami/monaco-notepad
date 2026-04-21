import { describe, expect, it } from 'vitest';
import { makeNote } from '@/test/helpers';
import {
	computeConflictCopyDedupHash,
	computeContentHash,
	isConflictCopyTitle,
} from '../hash';

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

describe('computeConflictCopyDedupHash', () => {
	it('content と language のみで判定する（id/title は無視）', async () => {
		const a = makeNote({
			id: 'a',
			title: 'Conflict Copy of X',
			content: 'same',
			language: 'go',
		});
		const b = makeNote({
			id: 'b',
			title: 'Conflict Copy of X',
			content: 'same',
			language: 'go',
		});
		expect(await computeConflictCopyDedupHash(a)).toBe(
			await computeConflictCopyDedupHash(b),
		);
	});

	it('content が違えばハッシュも違う', async () => {
		const a = makeNote({ id: 'a', content: 'x', language: 'go' });
		const b = makeNote({ id: 'b', content: 'y', language: 'go' });
		expect(await computeConflictCopyDedupHash(a)).not.toBe(
			await computeConflictCopyDedupHash(b),
		);
	});
});

describe('isConflictCopyTitle', () => {
	it('英語プレフィックスを検出', () => {
		expect(isConflictCopyTitle('Conflict Copy of Foo')).toBe(true);
		expect(isConflictCopyTitle('conflict copy of foo')).toBe(true);
	});
	it('日本語プレフィックスを検出', () => {
		expect(isConflictCopyTitle('競合コピー:Foo')).toBe(true);
	});
	it('通常タイトルは誤検出しない', () => {
		expect(isConflictCopyTitle('My Foo')).toBe(false);
		expect(isConflictCopyTitle('')).toBe(false);
	});
});
