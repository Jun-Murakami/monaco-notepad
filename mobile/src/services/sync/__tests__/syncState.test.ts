import { describe, expect, it } from 'vitest';
import { SyncStateManager } from '../syncState';

async function freshState(): Promise<SyncStateManager> {
	const s = new SyncStateManager();
	await s.load();
	return s;
}

describe('SyncStateManager', () => {
	it('初期状態: dirty=false, lastSyncedDriveTs=空', async () => {
		const s = await freshState();
		expect(s.isDirty()).toBe(false);
		expect(s.lastSyncedDriveTs()).toBe('');
	});

	it('markNoteDirty で dirty, dirtyNoteIds が立つ', async () => {
		const s = await freshState();
		await s.markNoteDirty('n1');
		const snap = s.snapshot();
		expect(s.isDirty()).toBe(true);
		expect(snap.dirtyNoteIds).toEqual({ n1: true });
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

	it('clearDirtyIfUnchanged: revision 一致なら dirty をクリア', async () => {
		const s = await freshState();
		await s.markNoteDirty('n1');
		const snap = await s.getDirtySnapshotWithRevision();
		const cleared = await s.clearDirtyIfUnchanged(
			snap.revision,
			'2026-02-01T00:00:00Z',
			{
				n1: 'hash-1',
			},
		);
		expect(cleared).toBe(true);
		expect(s.isDirty()).toBe(false);
		expect(s.lastSyncedDriveTs()).toBe('2026-02-01T00:00:00Z');
		expect(s.lastSyncedHash('n1')).toBe('hash-1');
	});

	it('clearDirtyIfUnchanged: 同期中に markDirty が走ると false を返し dirty を維持', async () => {
		const s = await freshState();
		await s.markNoteDirty('n1');
		const snap = await s.getDirtySnapshotWithRevision();
		// 同期中に別編集
		await s.markNoteDirty('n2');
		const cleared = await s.clearDirtyIfUnchanged(
			snap.revision,
			'2026-02-01T00:00:00Z',
			{
				n1: 'h1',
			},
		);
		expect(cleared).toBe(false);
		expect(s.isDirty()).toBe(true);
		// n1/n2 の両方がまだ dirty
		expect(s.snapshot().dirtyNoteIds).toEqual({ n1: true, n2: true });
	});

	it('updateSyncedState: dirty は維持しつつ hash と ts は更新', async () => {
		const s = await freshState();
		await s.markNoteDirty('n1');
		await s.updateSyncedState('2026-02-01T00:00:00Z', { n1: 'h1' });
		expect(s.isDirty()).toBe(true);
		expect(s.lastSyncedDriveTs()).toBe('2026-02-01T00:00:00Z');
		expect(s.lastSyncedHash('n1')).toBe('h1');
		expect(s.snapshot().dirtyNoteIds).toEqual({ n1: true });
	});

	it('forgetNoteHash で個別ノートの hash を落とす', async () => {
		const s = await freshState();
		await s.updateSyncedState('t', { n1: 'h1', n2: 'h2' });
		await s.forgetNoteHash('n1');
		expect(s.lastSyncedHash('n1')).toBeUndefined();
		expect(s.lastSyncedHash('n2')).toBe('h2');
	});

	it('reset: 全フィールド初期化', async () => {
		const s = await freshState();
		await s.markNoteDirty('n1');
		await s.updateSyncedState('ts', { n1: 'h1' });
		await s.reset();
		expect(s.isDirty()).toBe(false);
		expect(s.lastSyncedDriveTs()).toBe('');
		expect(s.snapshot().dirtyNoteIds).toEqual({});
		expect(s.lastSyncedHash('n1')).toBeUndefined();
	});

	it('永続化: 別インスタンスでもロード時に状態を復元', async () => {
		const a = await freshState();
		await a.markNoteDirty('n1');
		await a.markNoteDeleted('n2');
		await a.updateSyncedState('2026-03-01', { n1: 'h1' });

		const b = new SyncStateManager();
		await b.load();
		expect(b.isDirty()).toBe(true);
		expect(b.snapshot().dirtyNoteIds).toEqual({ n1: true });
		expect(b.snapshot().deletedNoteIds).toEqual({ n2: true });
		expect(b.lastSyncedHash('n1')).toBe('h1');
		expect(b.lastSyncedDriveTs()).toBe('2026-03-01');
	});

	it('revision はインスタンス内だけで有効（再ロード後はリセット）', async () => {
		const a = await freshState();
		await a.markNoteDirty('n1');
		const snapA = await a.getDirtySnapshotWithRevision();
		expect(snapA.revision).toBeGreaterThan(0);

		const b = new SyncStateManager();
		await b.load();
		const snapB = await b.getDirtySnapshotWithRevision();
		expect(snapB.revision).toBe(0);
	});

	it('revision は dirty 系操作でインクリメントされる', async () => {
		const s = await freshState();
		const r0 = (await s.getDirtySnapshotWithRevision()).revision;
		await s.markNoteDirty('n1');
		const r1 = (await s.getDirtySnapshotWithRevision()).revision;
		await s.markNoteDirty('n2');
		const r2 = (await s.getDirtySnapshotWithRevision()).revision;
		expect(r1).toBeGreaterThan(r0);
		expect(r2).toBeGreaterThan(r1);
	});

	it('同期成功後は dirtyNoteIds/deletedNoteIds が空でなくなる前の状態も hash だけ保存', async () => {
		const s = await freshState();
		await s.markNoteDirty('n1');
		await s.markNoteDeleted('n2');
		const snap = await s.getDirtySnapshotWithRevision();
		await s.clearDirtyIfUnchanged(snap.revision, 'ts', { n1: 'h1' });
		const after = s.snapshot();
		expect(after.dirtyNoteIds).toEqual({});
		expect(after.deletedNoteIds).toEqual({});
		expect(after.lastSyncedNoteHash).toEqual({ n1: 'h1' });
	});

	it('markFolderDeleted が deletedFolderIds に入る', async () => {
		const s = await freshState();
		await s.markFolderDeleted('f1');
		expect(s.snapshot().deletedFolderIds).toEqual({ f1: true });
		expect(s.isDirty()).toBe(true);
	});
});
