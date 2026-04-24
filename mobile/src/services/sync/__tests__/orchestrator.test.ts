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

// ----------------------------------------------------------------------------
// 「noteList だけクラウドに反映されてノート本体が上がらない」回避のテスト群。
//
// デスクトップ版では onConnected → ensureNoteList が local メタデータで Drive の
// noteList を先に作ってしまい、個別ノート本体が Drive に無い "ゾンビ状態" になるバグが
// あった。モバイル版は ensureDriveLayout が空の noteList を作り、その後の syncNotes で
// resolveConflict 経路を通って個別ノートを上げる設計なのでこの構造的な不具合は起きない。
// ここでは退行防止として:
//   (1) ノート本体が Drive に上がってから noteList が更新される順序
//   (2) 全件アップロードされる
//   (3) UploadNote メッセージに current/total が付いている
//   (4) 途中で失敗した場合 dirty が残って再試行できる
// を明示的に検証する。
// ----------------------------------------------------------------------------

describe('SyncOrchestrator: offline-first bulk upload', () => {
	it('cloud 空 + local dirty 複数 → 全ノート本体が上がってから noteList が更新される', async () => {
		const items = [
			makeNote({ id: 'a', content: 'offline a' }),
			makeNote({ id: 'b', content: 'offline b' }),
			makeNote({ id: 'c', content: 'offline c' }),
		];
		for (const n of items) {
			await notes.saveNote(n);
			await state.markNoteDirty(n.id);
		}

		// updateNoteList が呼ばれた瞬間に cloud.notes に何が入っているかを記録する。
		// 順序として「ノート本体が全部入ってから noteList が更新される」ことを検証する。
		const origUpdateList = cloud.updateNoteList.bind(cloud);
		let cloudNotesAtUpdateList: string[] = [];
		cloud.updateNoteList = async (list) => {
			cloudNotesAtUpdateList = Array.from(cloud.notes.keys()).sort();
			return origUpdateList(list);
		};

		await orch.syncNotes();

		// (2) 全件アップロード
		expect(cloud.notes.has('a')).toBe(true);
		expect(cloud.notes.has('b')).toBe(true);
		expect(cloud.notes.has('c')).toBe(true);
		expect(cloud.calls.create).toBe(3);

		// (1) updateNoteList 呼び出し時点で既に全ノート本体が cloud にあった
		expect(cloudNotesAtUpdateList).toEqual(['a', 'b', 'c']);

		// cloudList に全件メタデータが入っている
		const uploadedIds = cloud.noteList.notes.map((n) => n.id).sort();
		expect(uploadedIds).toEqual(['a', 'b', 'c']);

		// 同期完了
		expect(state.isDirty()).toBe(false);
	});

	it('cloud 空 + local dirty 1 件 → pushLocalChanges 経路（cloudTs==="" の no-op 判定を潜る）でも全体フロー', async () => {
		// lastSyncedDriveTs = "" のまま、かつ cloudMeta.modifiedTime が初期値と異なる状態
		const a = makeNote({ id: 'a', content: 'solo' });
		await notes.saveNote(a);
		await state.markNoteDirty('a');

		await orch.syncNotes();

		expect(cloud.notes.get('a')?.content).toBe('solo');
		expect(cloud.noteList.notes.map((n) => n.id)).toEqual(['a']);
		expect(state.isDirty()).toBe(false);
	});

	it('upload メッセージに current/total (1/N, 2/N, ...) が付く', async () => {
		const events: Array<{ noteId: string; current?: number; total?: number }> =
			[];
		const { syncEvents } = await import('../events');
		const unsub = syncEvents.on('sync:message', (msg) => {
			if (msg.code === 'drive.sync.uploadNote') {
				const args = msg.args ?? {};
				events.push({
					noteId: String(args.noteId),
					current: args.current as number | undefined,
					total: args.total as number | undefined,
				});
			}
		});

		try {
			for (const id of ['a', 'b', 'c']) {
				await notes.saveNote(makeNote({ id, content: id }));
				await state.markNoteDirty(id);
			}
			await orch.syncNotes();
		} finally {
			unsub();
		}

		expect(events.length).toBe(3);
		// current は 1..N、total は一定
		const currents = events.map((e) => e.current).sort();
		expect(currents).toEqual([1, 2, 3]);
		expect(events.every((e) => e.total === 3)).toBe(true);
	});

	it('途中で createNote が失敗したら dirty を維持して次回再試行できる', async () => {
		const items = [
			makeNote({ id: 'a', content: 'a' }),
			makeNote({ id: 'b', content: 'b' }),
		];
		for (const n of items) {
			await notes.saveNote(n);
			await state.markNoteDirty(n.id);
		}

		// b の create だけ 1 回目は失敗させる（オフラインや断続的な接続を模擬）
		const origCreate = cloud.createNote.bind(cloud);
		let failed = false;
		cloud.createNote = async (note) => {
			if (!failed && note.id === 'b') {
				failed = true;
				throw new Error('simulated network failure');
			}
			return origCreate(note);
		};

		await expect(orch.syncNotes()).rejects.toThrow('simulated network failure');

		// 1 回目: a は上がったが b は失敗、 dirty は維持
		expect(cloud.notes.has('a')).toBe(true);
		expect(cloud.notes.has('b')).toBe(false);
		expect(state.isDirty()).toBe(true);
		expect(state.snapshot().dirtyNoteIds).toHaveProperty('b');

		// 2 回目: 成功する
		await orch.syncNotes();
		expect(cloud.notes.has('b')).toBe(true);
		expect(state.isDirty()).toBe(false);
	});
});

// ----------------------------------------------------------------------------
// Resume 最適化: 大量アップロード途中で終了 → 再起動後に「既に上がったノート」を
// 個別にスキップして残りだけアップロードする挙動の検証。
//
// ユーザーがクラッシュと再起動の間に該当ノートを編集していた場合は hash が変わるので
// スキップされずに正しく再 upload される事も確認する。
// ----------------------------------------------------------------------------

describe('SyncOrchestrator: resume skip (partial upload recovery)', () => {
	it('前回 session で上げ終えたノートは Drive を叩かずにスキップされる (pushLocalChanges 経路)', async () => {
		// セットアップ: a と b をローカル作成、 a は前回既に Drive に上げ終わったと仮定する
		const a = makeNote({ id: 'a', content: 'a-content' });
		const b = makeNote({ id: 'b', content: 'b-content' });
		await notes.saveNote(a);
		await notes.saveNote(b);
		await state.markNoteDirty('a');
		await state.markNoteDirty('b');

		// 前回の Drive 状態 + 個別永続化 hash を再現
		const aHash = await computeContentHash(a);
		cloud.setCloudNote(a);
		await state.updateSyncedNoteHash('a', aHash);
		// noteList もデスクトップ版の resume を模擬して cloudTs=lastSyncedTs (cloud unchanged) にする
		await cloud.rebuildNoteListFromCloud(iso());
		await state.updateSyncedState(cloud.noteListModifiedTime, {});

		// a は再アップしない、b だけ create される
		const createsBefore = cloud.calls.create;
		const updatesBefore = cloud.calls.update;

		await orch.syncNotes();

		expect(cloud.calls.create - createsBefore).toBe(1); // b だけ
		expect(cloud.calls.update - updatesBefore).toBe(0); // a は Drive を叩かない
		expect(cloud.notes.has('a')).toBe(true);
		expect(cloud.notes.has('b')).toBe(true);
		expect(state.isDirty()).toBe(false);
	});

	it('resume 時にユーザーが編集していた場合 (hash 変更) は skip されずに再 upload', async () => {
		const a = makeNote({ id: 'a', content: 'v1' });
		await notes.saveNote(a);
		await state.markNoteDirty('a');

		// 「前回 v1 を上げ終えた」状態を作る
		const v1Hash = await computeContentHash(a);
		cloud.setCloudNote(a);
		await state.updateSyncedNoteHash('a', v1Hash);
		await cloud.rebuildNoteListFromCloud(iso());
		await state.updateSyncedState(cloud.noteListModifiedTime, {});

		// ユーザーがダウンタイム中に編集
		const v2 = makeNote({ id: 'a', content: 'v2 edited during downtime' });
		await notes.saveNote(v2);
		await state.markNoteDirty('a');

		await orch.syncNotes();

		// hash が変わっているので updateNote (既存のため) が呼ばれる
		expect(cloud.notes.get('a')?.content).toBe('v2 edited during downtime');
	});

	it('resolveConflict 経路 (offline-first) でも resume skip が効く', async () => {
		const a = makeNote({ id: 'a', content: 'a-content' });
		const b = makeNote({ id: 'b', content: 'b-content' });
		await notes.saveNote(a);
		await notes.saveNote(b);
		await state.markNoteDirty('a');
		await state.markNoteDirty('b');

		// a は既に Drive に上がったが noteList にはまだ登録されていない状態
		// (cloud.notes に a を入れるが rebuildNoteListFromCloud に含めない)
		cloud.notes.set('a', { ...a });
		cloud.noteModifiedTimes.set('a', a.modifiedTime);
		await state.updateSyncedNoteHash('a', await computeContentHash(a));
		// cloud noteList は空 (ensureDriveLayout が作った直後相当) → cloudChanged=true & localDirty=true → resolveConflict
		cloud.noteList = {
			version: 'v2',
			notes: [],
			folders: [],
			topLevelOrder: [],
			archivedTopLevelOrder: [],
			collapsedFolderIds: [],
		};
		cloud.noteListModifiedTime = iso(1000);

		const createsBefore = cloud.calls.create;
		await orch.syncNotes();

		// a は既に Drive にあるので createNote が呼ばれず、b だけ create される
		expect(cloud.calls.create - createsBefore).toBe(1);
		expect(cloud.notes.has('a')).toBe(true);
		expect(cloud.notes.has('b')).toBe(true);
		// 最終的に noteList にも両方反映される
		const uploadedIds = cloud.noteList.notes.map((n) => n.id).sort();
		expect(uploadedIds).toEqual(['a', 'b']);
	});

	it('resume 後の進捗表示は残件数に rebase して 1..M の連番 (ジャンプなし)', async () => {
		const { syncEvents } = await import('../events');
		const events: Array<{ noteId: string; current: number; total: number }> =
			[];
		const unsub = syncEvents.on('sync:message', (msg) => {
			if (msg.code === 'drive.sync.uploadNote') {
				const args = msg.args ?? {};
				events.push({
					noteId: String(args.noteId),
					current: args.current as number,
					total: args.total as number,
				});
			}
		});

		try {
			// 5 件 dirty、うち 3 件を「前回上げ終えた」状態にする
			const all = ['a', 'b', 'c', 'd', 'e'].map((id) =>
				makeNote({ id, content: `content-${id}` }),
			);
			for (const n of all) {
				await notes.saveNote(n);
				await state.markNoteDirty(n.id);
			}
			for (const id of ['a', 'c', 'e']) {
				const n = all.find((x) => x.id === id)!;
				cloud.setCloudNote(n);
				await state.updateSyncedNoteHash(id, await computeContentHash(n));
			}
			await cloud.rebuildNoteListFromCloud(iso());
			await state.updateSyncedState(cloud.noteListModifiedTime, {});

			await orch.syncNotes();
		} finally {
			unsub();
		}

		// 残り 2 件だけが emit されるはず (b, d)
		expect(events.length).toBe(2);
		// total は全メッセージで 2 (rebase 済み、元の 5 ではない)
		expect(events.every((e) => e.total === 2)).toBe(true);
		// current は 1, 2 の連番 (順序依存なし)
		const currents = events.map((e) => e.current).sort();
		expect(currents).toEqual([1, 2]);
		// 対象は b, d のいずれか
		const uploadedIds = events.map((e) => e.noteId).sort();
		expect(uploadedIds).toEqual(['b', 'd']);
	});

	it('resume なし (初回フル upload) でも total=dirty 件数、current=1..N', async () => {
		const { syncEvents } = await import('../events');
		const events: Array<{ current: number; total: number }> = [];
		const unsub = syncEvents.on('sync:message', (msg) => {
			if (msg.code === 'drive.sync.uploadNote') {
				const args = msg.args ?? {};
				events.push({
					current: args.current as number,
					total: args.total as number,
				});
			}
		});

		try {
			for (const id of ['x', 'y', 'z']) {
				await notes.saveNote(makeNote({ id, content: id }));
				await state.markNoteDirty(id);
			}
			await orch.syncNotes();
		} finally {
			unsub();
		}

		expect(events.length).toBe(3);
		expect(events.every((e) => e.total === 3)).toBe(true);
		expect(events.map((e) => e.current).sort()).toEqual([1, 2, 3]);
	});

	it('resume 途中で別ノートの upload が失敗しても、既済み分の hash は消えない', async () => {
		// a, b, c あり。 a は既に上げ済み永続化済。b の createNote は 1 回目失敗させる。
		const a = makeNote({ id: 'a', content: 'a' });
		const b = makeNote({ id: 'b', content: 'b' });
		const c = makeNote({ id: 'c', content: 'c' });
		await notes.saveNote(a);
		await notes.saveNote(b);
		await notes.saveNote(c);
		await state.markNoteDirty('a');
		await state.markNoteDirty('b');
		await state.markNoteDirty('c');

		const aHash = await computeContentHash(a);
		cloud.setCloudNote(a);
		await state.updateSyncedNoteHash('a', aHash);
		await cloud.rebuildNoteListFromCloud(iso());
		await state.updateSyncedState(cloud.noteListModifiedTime, {});

		const origCreate = cloud.createNote.bind(cloud);
		let failed = false;
		cloud.createNote = async (note) => {
			if (!failed && note.id === 'b') {
				failed = true;
				throw new Error('flaky');
			}
			return origCreate(note);
		};

		await expect(orch.syncNotes()).rejects.toThrow('flaky');

		// a の hash は維持されている (次回再試行で再スキップされる)
		expect(state.lastSyncedHash('a')).toBe(aHash);

		// 2 回目: 残り (b, c) だけ upload される
		const createsBefore = cloud.calls.create;
		await orch.syncNotes();

		// b, c の create だけ実行されるはず
		expect(cloud.calls.create - createsBefore).toBeGreaterThanOrEqual(1);
		expect(cloud.notes.has('a')).toBe(true);
		expect(cloud.notes.has('b')).toBe(true);
		expect(cloud.notes.has('c')).toBe(true);
		expect(state.isDirty()).toBe(false);
	});
});
