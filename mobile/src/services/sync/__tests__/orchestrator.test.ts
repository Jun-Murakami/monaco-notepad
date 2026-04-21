import { Directory } from 'expo-file-system';
import { beforeEach, describe, expect, it } from 'vitest';
import { NoteService } from '@/services/notes/noteService';
import { CONFLICT_BACKUP_DIR } from '@/services/storage/paths';
import { FakeCloud } from '@/test/fakeCloud';
import { iso, makeNote } from '@/test/helpers';
import type { DriveSyncService } from '../driveSyncService';
import { computeContentHash } from '../hash';
import { SyncOrchestrator } from '../orchestrator';
import { SyncStateManager } from '../syncState';

/**
 * SyncOrchestrator の全シナリオテスト。
 *
 * ここが本命。デスクトップ版と同じ挙動を守ることを一つずつ検証する。
 *
 * シナリオ一覧：
 * - no-op: 両方変更なし
 * - push のみ: ローカル変更をアップロード（作成/更新/削除）
 * - pull のみ: クラウド変更をダウンロード（新規/更新/削除）
 * - conflict: LWW by ModifiedTime、local 勝ち / cloud 勝ち
 * - conflict: cloudHash == lastHash なら local 勝ち固定（誤検知の除外）
 * - race: 同期中にユーザー編集が来ると dirty を維持
 * - 削除 vs クラウド変更: バックアップ取って削除
 * - 初回 push（cloud 空 + local あり）
 * - 順次同期で hash が更新される
 */

let cloud: FakeCloud;
let notes: NoteService;
let state: SyncStateManager;
let orch: SyncOrchestrator;

async function setup(opts?: { enableConflictBackup?: boolean }): Promise<void> {
	cloud = new FakeCloud();
	notes = new NoteService();
	state = new SyncStateManager();
	await notes.load();
	await state.load();
	orch = new SyncOrchestrator(
		cloud as unknown as DriveSyncService,
		notes,
		state,
		opts ?? {},
	);
}

beforeEach(async () => {
	await setup();
});

describe('SyncOrchestrator.syncNotes: no-op', () => {
	it('クラウドもローカルも変化なしなら何もしない', async () => {
		await orch.syncNotes();
		expect(cloud.calls.updateNoteList).toBe(0);
		expect(cloud.calls.create + cloud.calls.update + cloud.calls.delete).toBe(
			0,
		);
	});
});

describe('SyncOrchestrator.syncNotes: push only (local dirty, cloud unchanged)', () => {
	it('新規ノートをクラウドに作成してから noteList を更新', async () => {
		const note = makeNote({ id: 'a', title: 'A', content: 'a' });
		await notes.saveNote(note);
		await state.markNoteDirty('a');

		await orch.syncNotes();

		expect(cloud.calls.create).toBe(1);
		expect(cloud.calls.updateNoteList).toBe(1);
		expect(cloud.notes.has('a')).toBe(true);
		expect(state.isDirty()).toBe(false);
		expect(state.lastSyncedHash('a')).toBe(await computeContentHash(note));
	});

	it('既存ノートの更新は updateNote を使う', async () => {
		// クラウドに既存のコピーを置いておく（同期済みとしてマーク）
		const original = makeNote({ id: 'a', content: 'v1' });
		cloud.setCloudNote(original);
		await cloud.rebuildNoteListFromCloud(iso());
		await state.updateSyncedState(cloud.noteListModifiedTime, {
			a: await computeContentHash(original),
		});

		// ローカルだけ編集
		const edited = makeNote({
			id: 'a',
			content: 'v2',
			modifiedTime: iso(10_000),
		});
		await notes.saveNote(edited);
		await state.markNoteDirty('a');

		await orch.syncNotes();

		expect(cloud.calls.update).toBe(1);
		expect(cloud.notes.get('a')?.content).toBe('v2');
	});

	it('ローカル削除をクラウドにも反映', async () => {
		// 事前にクラウド/ローカル両方に a を置く
		const a = makeNote({ id: 'a' });
		cloud.setCloudNote(a);
		await cloud.rebuildNoteListFromCloud(iso());
		await notes.saveNote(a);
		await state.updateSyncedState(cloud.noteListModifiedTime, {
			a: await computeContentHash(a),
		});

		// ローカル側で削除（ローカルのみ変化）
		await notes.deleteNote('a');
		await state.markNoteDeleted('a');

		await orch.syncNotes();

		expect(cloud.notes.has('a')).toBe(false);
		expect(state.isDirty()).toBe(false);
	});

	it('race: push 中に別ノートが dirty になったら dirty を維持、hash と ts は更新', async () => {
		const a = makeNote({ id: 'a' });
		await notes.saveNote(a);
		await state.markNoteDirty('a');

		// 同期本体をまたいで別ノートを dirty にする
		const origUpdate = cloud.updateNoteList.bind(cloud);
		cloud.updateNoteList = async (list) => {
			await state.markNoteDirty('b');
			return origUpdate(list);
		};

		await orch.syncNotes();

		// a の hash は記録された
		expect(state.lastSyncedHash('a')).toBeTruthy();
		// dirty は維持
		expect(state.isDirty()).toBe(true);
		expect(state.snapshot().dirtyNoteIds).toHaveProperty('b');
	});
});

describe('SyncOrchestrator.syncNotes: pull only (cloud changed, local clean)', () => {
	it('クラウドの新規ノートをローカルにダウンロード', async () => {
		const cloudNote = makeNote({ id: 'cloud-only', content: 'remote' });
		cloud.setCloudNote(cloudNote);
		await cloud.rebuildNoteListFromCloud(iso(10_000));
		// lastSyncedDriveTs はデフォルト "" なので cloudChanged=true

		await orch.syncNotes();

		expect((await notes.readNote('cloud-only'))?.content).toBe('remote');
		expect(state.lastSyncedDriveTs()).toBe(cloud.noteListModifiedTime);
	});

	it('クラウドから消えたノートはローカルからも削除', async () => {
		// 事前に a をローカルに登録（クラウドには無い状態を作る）
		const a = makeNote({ id: 'a' });
		await notes.saveNote(a);
		// クラウドは別ノート b だけ
		const b = makeNote({ id: 'b' });
		cloud.setCloudNote(b);
		await cloud.rebuildNoteListFromCloud(iso(10_000));

		await orch.syncNotes();

		// a はローカルからも消える
		expect(await notes.readNote('a')).toBeNull();
		expect((await notes.readNote('b'))?.content).toBe('hello');
	});

	it('クラウドだけ更新されたノートはローカルにも反映', async () => {
		const v1 = makeNote({ id: 'a', content: 'v1' });
		await notes.saveNote(v1);
		cloud.setCloudNote(v1);
		await cloud.rebuildNoteListFromCloud(iso());
		await state.updateSyncedState(cloud.noteListModifiedTime, {
			a: await computeContentHash(v1),
		});

		// クラウド側だけ v2 に更新
		const v2 = makeNote({ id: 'a', content: 'v2-from-cloud' });
		cloud.setCloudNote(v2);
		await cloud.rebuildNoteListFromCloud(iso(20_000));

		await orch.syncNotes();

		expect((await notes.readNote('a'))?.content).toBe('v2-from-cloud');
	});
});

describe('SyncOrchestrator.syncNotes: conflict', () => {
	it('両方変更・local のタイムスタンプが新しい → local が勝ってクラウドを上書き', async () => {
		const base = makeNote({ id: 'a', content: 'base' });
		cloud.setCloudNote(base);
		await cloud.rebuildNoteListFromCloud(iso());
		await notes.saveNote(base);
		await state.updateSyncedState(cloud.noteListModifiedTime, {
			a: await computeContentHash(base),
		});

		// 両者がそれぞれ改変
		const localEdit = makeNote({
			id: 'a',
			content: 'local-wins',
			modifiedTime: iso(20_000),
		});
		await notes.saveNote(localEdit);
		await state.markNoteDirty('a');

		const cloudEdit = makeNote({
			id: 'a',
			content: 'cloud-loses',
			modifiedTime: iso(10_000),
		});
		cloud.setCloudNote(cloudEdit);
		await cloud.rebuildNoteListFromCloud(iso(10_000));

		await orch.syncNotes();

		expect(cloud.notes.get('a')?.content).toBe('local-wins');
		expect((await notes.readNote('a'))?.content).toBe('local-wins');
	});

	it('両方変更・cloud のタイムスタンプが新しい → cloud が勝ってローカルを上書き、かつ local のバックアップが残る', async () => {
		await setup({ enableConflictBackup: true });
		const base = makeNote({ id: 'a', content: 'base' });
		cloud.setCloudNote(base);
		await cloud.rebuildNoteListFromCloud(iso());
		await notes.saveNote(base);
		await state.updateSyncedState(cloud.noteListModifiedTime, {
			a: await computeContentHash(base),
		});

		const localLoser = makeNote({
			id: 'a',
			content: 'local-loses',
			modifiedTime: iso(10_000),
		});
		await notes.saveNote(localLoser);
		await state.markNoteDirty('a');

		const cloudWinner = makeNote({
			id: 'a',
			content: 'cloud-wins',
			modifiedTime: iso(20_000),
		});
		cloud.setCloudNote(cloudWinner);
		await cloud.rebuildNoteListFromCloud(iso(20_000));

		await orch.syncNotes();

		expect((await notes.readNote('a'))?.content).toBe('cloud-wins');
		const backups = new Directory(CONFLICT_BACKUP_DIR)
			.list()
			.map((e) => e.name);
		expect(
			backups.some((n) => n.startsWith('cloud_wins_') && n.endsWith('_a.json')),
		).toBe(true);
	});

	it('enableConflictBackup=false ならバックアップを書かない', async () => {
		await setup({ enableConflictBackup: false });
		const base = makeNote({ id: 'a', content: 'base' });
		cloud.setCloudNote(base);
		await cloud.rebuildNoteListFromCloud(iso());
		await notes.saveNote(base);
		await state.updateSyncedState(cloud.noteListModifiedTime, {
			a: await computeContentHash(base),
		});

		await notes.saveNote(
			makeNote({ id: 'a', content: 'local-loses', modifiedTime: iso(10_000) }),
		);
		await state.markNoteDirty('a');
		cloud.setCloudNote(
			makeNote({ id: 'a', content: 'cloud-wins', modifiedTime: iso(20_000) }),
		);
		await cloud.rebuildNoteListFromCloud(iso(20_000));

		await orch.syncNotes();

		// バックアップディレクトリは存在しないか空
		const backupDir = new Directory(CONFLICT_BACKUP_DIR);
		if (backupDir.exists) {
			expect(backupDir.list().length).toBe(0);
		}
	});

	it('cloud の hash が lastSyncedHash と一致 → 真の競合ではなく local 勝ち固定', async () => {
		const base = makeNote({ id: 'a', content: 'base' });
		cloud.setCloudNote(base);
		await cloud.rebuildNoteListFromCloud(iso());
		await notes.saveNote(base);
		const baseHash = await computeContentHash(base);
		await state.updateSyncedState(cloud.noteListModifiedTime, { a: baseHash });

		// ローカルは変更して dirty
		const localV2 = makeNote({
			id: 'a',
			content: 'local-v2',
			modifiedTime: iso(50_000),
		});
		await notes.saveNote(localV2);
		await state.markNoteDirty('a');

		// クラウド側: 内容は同じ base のまま、noteList の ModifiedTime だけ進んだ（例えばメタデータ変更）
		await cloud.rebuildNoteListFromCloud(iso(30_000));

		await orch.syncNotes();

		// ローカル勝ち
		expect(cloud.notes.get('a')?.content).toBe('local-v2');
	});

	it('deleted なのにクラウド側で変更あり → バックアップして削除', async () => {
		const base = makeNote({ id: 'a', content: 'base' });
		cloud.setCloudNote(base);
		await cloud.rebuildNoteListFromCloud(iso());
		await notes.saveNote(base);
		await state.updateSyncedState(cloud.noteListModifiedTime, {
			a: await computeContentHash(base),
		});

		// ローカルで削除
		await notes.deleteNote('a');
		await state.markNoteDeleted('a');

		// 同期のタイミングでクラウド側も改変（=異なる hash）
		cloud.setCloudNote(
			makeNote({
				id: 'a',
				content: 'cloud-changed',
				modifiedTime: iso(30_000),
			}),
		);
		await cloud.rebuildNoteListFromCloud(iso(30_000));

		await orch.syncNotes();

		expect(cloud.notes.has('a')).toBe(false);
		const backups = new Directory(CONFLICT_BACKUP_DIR)
			.list()
			.map((e) => e.name);
		expect(
			backups.some(
				(n) => n.startsWith('cloud_delete_') && n.endsWith('_a.json'),
			),
		).toBe(true);
	});

	it('race: conflict 解決中に別ノートが dirty → dirty を維持しつつ解決済み hash は保存', async () => {
		const base = makeNote({ id: 'a', content: 'base' });
		cloud.setCloudNote(base);
		await cloud.rebuildNoteListFromCloud(iso());
		await notes.saveNote(base);
		await state.updateSyncedState(cloud.noteListModifiedTime, {
			a: await computeContentHash(base),
		});
		// ローカル/クラウド双方変更
		await notes.saveNote(
			makeNote({ id: 'a', content: 'local', modifiedTime: iso(10_000) }),
		);
		await state.markNoteDirty('a');
		cloud.setCloudNote(
			makeNote({ id: 'a', content: 'cloud', modifiedTime: iso(20_000) }),
		);
		await cloud.rebuildNoteListFromCloud(iso(20_000));

		// updateNoteList の直前で別ノート b を dirty に
		const origUpdate = cloud.updateNoteList.bind(cloud);
		cloud.updateNoteList = async (list) => {
			await state.markNoteDirty('b');
			return origUpdate(list);
		};

		await orch.syncNotes();

		expect(state.isDirty()).toBe(true);
		expect(state.snapshot().dirtyNoteIds).toHaveProperty('b');
		// a は解決済み（cloud 勝ち）なので hash が更新されている
		expect(state.lastSyncedHash('a')).toBeTruthy();
	});
});

describe('SyncOrchestrator.saveNoteAndUpdateList', () => {
	it('既存がなければ create、あれば update', async () => {
		const a = makeNote({ id: 'a', content: 'first' });
		await notes.saveNote(a);
		await state.markNoteDirty('a');
		await orch.saveNoteAndUpdateList(a);
		expect(cloud.calls.create).toBe(1);
		expect(cloud.notes.get('a')?.content).toBe('first');

		const a2 = makeNote({
			id: 'a',
			content: 'second',
			modifiedTime: iso(10_000),
		});
		await notes.saveNote(a2);
		await state.markNoteDirty('a');
		await orch.saveNoteAndUpdateList(a2);
		expect(cloud.calls.update).toBe(1);
		expect(cloud.notes.get('a')?.content).toBe('second');
	});

	it('saveNoteAndUpdateList 実行中に別の saveNote が入っても直列化される（syncLock）', async () => {
		const a = makeNote({ id: 'a', content: 'va' });
		const b = makeNote({ id: 'b', content: 'vb', modifiedTime: iso(10_000) });
		await notes.saveNote(a);
		await notes.saveNote(b);
		await state.markNoteDirty('a');
		await state.markNoteDirty('b');

		// 並行に呼ぶ
		await Promise.all([
			orch.saveNoteAndUpdateList(a),
			orch.saveNoteAndUpdateList(b),
		]);

		expect(cloud.calls.create + cloud.calls.update).toBeGreaterThanOrEqual(2);
		expect(cloud.notes.has('a')).toBe(true);
		expect(cloud.notes.has('b')).toBe(true);
	});
});

describe('SyncOrchestrator: first-push scenario', () => {
	it('lastSyncedDriveTs が "" で cloud が空 → 全ローカルノートをアップロード', async () => {
		const a = makeNote({ id: 'a', content: 'a' });
		const b = makeNote({ id: 'b', content: 'b' });
		await notes.saveNote(a);
		await notes.saveNote(b);
		await state.markNoteDirty('a');
		await state.markNoteDirty('b');

		// クラウドは空（初期 noteListModifiedTime とデフォルト lastSyncedDriveTs="" なので cloudChanged=true）
		// → 両方変更扱いで conflict 分岐に入るが cloudMeta が無いため create にフォールバック
		await orch.syncNotes();

		expect(cloud.notes.has('a')).toBe(true);
		expect(cloud.notes.has('b')).toBe(true);
	});
});

describe('SyncOrchestrator: idempotency', () => {
	it('2 連続の syncNotes() は 2 回目は no-op', async () => {
		const a = makeNote({ id: 'a', content: 'a' });
		await notes.saveNote(a);
		await state.markNoteDirty('a');

		await orch.syncNotes();
		const callsAfterFirst = { ...cloud.calls };
		await orch.syncNotes();

		expect(cloud.calls.create).toBe(callsAfterFirst.create);
		expect(cloud.calls.update).toBe(callsAfterFirst.update);
		expect(cloud.calls.updateNoteList).toBe(callsAfterFirst.updateNoteList);
	});
});
