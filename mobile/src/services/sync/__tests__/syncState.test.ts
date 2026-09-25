import { describe, expect, it } from 'vitest';
import { writeAtomic } from '@/services/storage/atomicFile';
import { SYNC_STATE_PATH } from '@/services/storage/paths';
import { SyncStateManager } from '../syncState';

async function freshState(): Promise<SyncStateManager> {
	const s = new SyncStateManager();
	await s.load();
	return s;
}

describe('SyncStateManager', () => {
	it('初期状態は同期不要', async () => {
		const s = await freshState();
		expect(s.isDirty()).toBe(false);
	});

	it('markNoteDirty で dirty, dirtyNoteIds が立つ', async () => {
		const s = await freshState();
		await s.markNoteDirty('n1');
		expect(s.isDirty()).toBe(true);
		expect(s.snapshot().dirtyNoteIds).toEqual({ n1: true });
	});

	it('markNoteDeleted は dirtyNoteIds から除き deletedNoteIds に入れる', async () => {
		const s = await freshState();
		await s.markNoteDirty('n1');
		await s.markNoteDeleted('n1');
		const snap = s.snapshot();
		expect(snap.dirtyNoteIds).toEqual({});
		expect(snap.deletedNoteIds).toEqual({ n1: true });
	});

	it('再 markNoteDirty は deletedNoteIds を取り消す（復活扱い）', async () => {
		const s = await freshState();
		await s.markNoteDeleted('n1');
		await s.markNoteDirty('n1');
		const snap = s.snapshot();
		expect(snap.dirtyNoteIds).toEqual({ n1: true });
		expect(snap.deletedNoteIds).toEqual({});
	});

	it('completeSync: 同期中に操作が無ければヒント系をクリアする', async () => {
		const s = await freshState();
		await s.markNoteDirty('n1');
		await s.markFolderDeleted('f1');
		const snap = await s.getDirtySnapshotWithRevision();

		const cleared = await s.completeSync(snap.revision, [], true);

		expect(cleared).toBe(true);
		expect(s.isDirty()).toBe(false);
		expect(s.snapshot().dirtyNoteIds).toEqual({});
		expect(s.snapshot().deletedFolderIds).toEqual({});
	});

	it('completeSync: 同期中にユーザー操作があればヒント系を残す（次の同期で拾う）', async () => {
		const s = await freshState();
		await s.markNoteDirty('n1');
		const snap = await s.getDirtySnapshotWithRevision();
		await s.markNoteDirty('n2'); // 同期中の編集

		const cleared = await s.completeSync(snap.revision, [], true);

		expect(cleared).toBe(false);
		expect(s.isDirty()).toBe(true);
		expect(s.snapshot().dirtyNoteIds).toEqual({ n1: true, n2: true });
	});

	it('completeSync: 失敗があった同期ではヒント系を残し、再同期を促す', async () => {
		const s = await freshState();
		await s.markNoteDirty('n1');
		const snap = await s.getDirtySnapshotWithRevision();

		expect(await s.completeSync(snap.revision, [], false)).toBe(false);
		expect(s.isDirty()).toBe(true);
	});

	it('completeSync: 削除意図は処理が確定した ID だけ個別に消える', async () => {
		const s = await freshState();
		await s.markNoteDeleted('done');
		await s.markNoteDeleted('pending');
		const snap = await s.getDirtySnapshotWithRevision();

		await s.completeSync(snap.revision, ['done'], false);

		expect(s.snapshot().deletedNoteIds).toEqual({ pending: true });
		// 未処理の削除が残っている間は「同期が必要」
		expect(s.isDirty()).toBe(true);
	});

	it('v2 の lastSyncedNoteHash は移行用に読めて、completeSync 後は消える', async () => {
		await writeAtomic(
			SYNC_STATE_PATH,
			JSON.stringify({
				dirty: false,
				lastSyncedDriveTs: '2026-01-01T00:00:00Z',
				dirtyNoteIds: {},
				deletedNoteIds: {},
				deletedFolderIds: {},
				lastSyncedNoteHash: { a: 'hash-a' },
			}),
		);
		const s = await freshState();
		expect(s.legacyNoteHashes()).toEqual({ a: 'hash-a' });

		const snap = await s.getDirtySnapshotWithRevision();
		await s.completeSync(snap.revision, [], true);
		expect(s.legacyNoteHashes()).toEqual({});
	});

	it('永続化: 別インスタンスで load しても記録が復元される（revision は永続化しない）', async () => {
		const a = await freshState();
		await a.markNoteDirty('n1');
		await a.markNoteDeleted('n2');

		const b = await freshState();
		expect(b.snapshot().dirtyNoteIds).toEqual({ n1: true });
		expect(b.snapshot().deletedNoteIds).toEqual({ n2: true });
		const snap = await b.getDirtySnapshotWithRevision();
		expect(snap.revision).toBe(0);
	});

	it('壊れた sync_state.json は初期状態として読む', async () => {
		await writeAtomic(SYNC_STATE_PATH, '{ broken');
		const s = await freshState();
		expect(s.isDirty()).toBe(false);
	});

	it('reset で全リセット', async () => {
		const s = await freshState();
		await s.markNoteDirty('n1');
		await s.markNoteDeleted('n2');
		await s.reset();
		expect(s.isDirty()).toBe(false);
		expect(s.snapshot().deletedNoteIds).toEqual({});
	});
});
