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
import type { NoteList } from '../types';

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

	// ★ 実機再現: 初回 pull 中に kill → 再起動。前回 session で download し終えた分は
	// ローカルファイルとして残っているので、再 pull で download をスキップして残りだけ
	// 落とせること (Drive を無駄に叩かない)。
	it('partial pull → 再起動で既ダウンロード分は skip され残りだけ download される', async () => {
		// cloud に 5 件、ローカルには前半 3 件だけ既にダウンロード済みの状態を構築
		const all = ['a', 'b', 'c', 'd', 'e'].map((id) =>
			makeNote({ id, content: `cloud-${id}` }),
		);
		for (const n of all) cloud.setCloudNote(n);
		await cloud.rebuildNoteListFromCloud(iso(10_000));

		// 前回 session で a, b, c だけローカルへ書き込んだ状態を再現
		// (同じ contentHash になるよう同じ内容で saveNote)
		for (const id of ['a', 'b', 'c']) {
			const n = all.find((x) => x.id === id)!;
			await notes.saveNoteFromSync(n);
		}
		// updateSyncedState には未到達 (kill された想定) なので lastSyncedDriveTs="" のまま

		const downloadsBefore = cloud.calls.download;

		await orch.syncNotes();

		// 残り d, e の 2 件だけ download されるはず
		expect(cloud.calls.download - downloadsBefore).toBe(2);

		// 全 5 件がローカルに揃っている
		for (const id of ['a', 'b', 'c', 'd', 'e']) {
			expect((await notes.readNote(id))?.content).toBe(`cloud-${id}`);
		}

		// updateSyncedState が走り lastSyncedDriveTs が更新されている
		expect(state.lastSyncedDriveTs()).toBe(cloud.noteListModifiedTime);

		// 全件分の hash が永続化されている
		for (const id of ['a', 'b', 'c', 'd', 'e']) {
			expect(state.lastSyncedHash(id)).toBeDefined();
		}
	});

	it('partial pull resume: download 中に kill されても per-note hash は永続化されるので次回 skip 可能', async () => {
		const all = ['a', 'b', 'c'].map((id) =>
			makeNote({ id, content: `cloud-${id}` }),
		);
		for (const n of all) cloud.setCloudNote(n);
		await cloud.rebuildNoteListFromCloud(iso(10_000));

		// b の download だけ失敗させて mid-pull kill を擬似的に再現する
		const origDownload = cloud.downloadNote.bind(cloud);
		cloud.downloadNote = async (noteId) => {
			if (noteId === 'b') throw new Error('simulated kill');
			return origDownload(noteId);
		};

		await expect(orch.syncNotes()).rejects.toThrow('simulated kill');

		// a は既に download 完了 → per-note hash が永続化されているはず
		expect(state.lastSyncedHash('a')).toBeDefined();
		// b/c は未完なので hash 無し
		expect(state.lastSyncedHash('c')).toBeUndefined();
	});
});

describe('SyncOrchestrator.syncNotes: 構造先行コミット (pull 中の UI 整合性)', () => {
	// pull 中は cloudList の folders / 順序 / 折りたたみ状態だけを先にローカルへ反映し、
	// notes は localList のものに保つ。これにより、フォルダ配下のノートが「フォルダ未確立」
	// で一時的に top-level にフラット落ちするのを防ぐ。
	// flattenNoteList が order 上の未知 ID を silent skip する仕様に支えられている。

	it('1 件目 download が始まる時点で cloud の folders / 順序 / 折りたたみ状態が反映されている', async () => {
		// folder 配下に 2 ノート + top-level に 1 ノートを cloud に置く
		const inFolder1 = makeNote({ id: 'in1', content: 'in1', folderId: 'f1' });
		const inFolder2 = makeNote({ id: 'in2', content: 'in2', folderId: 'f1' });
		const topLevel = makeNote({ id: 'top', content: 'top' });
		for (const n of [inFolder1, inFolder2, topLevel]) cloud.setCloudNote(n);
		cloud.noteList.folders = [{ id: 'f1', name: 'Work', archived: false }];
		cloud.noteList.topLevelOrder = [
			{ type: 'note', id: 'top' },
			{ type: 'folder', id: 'f1' },
		];
		cloud.noteList.collapsedFolderIds = ['f1'];
		await cloud.rebuildNoteListFromCloud(iso(10_000));

		// 最初の downloadNote 呼び出し時点でローカル側 noteList を捕獲
		let midSnapshot: NoteList | null = null;
		const origDownload = cloud.downloadNote.bind(cloud);
		cloud.downloadNote = async (id) => {
			if (midSnapshot === null) {
				midSnapshot = notes.getNoteList();
			}
			return origDownload(id);
		};

		await orch.syncNotes();

		// 1 件目 download の時点で folder 構造が確立している
		expect(midSnapshot).not.toBeNull();
		const snap = midSnapshot as unknown as NoteList;
		expect(snap.folders).toEqual([{ id: 'f1', name: 'Work', archived: false }]);
		expect(snap.topLevelOrder).toEqual([
			{ type: 'note', id: 'top' },
			{ type: 'folder', id: 'f1' },
		]);
		expect(snap.collapsedFolderIds).toEqual(['f1']);
		// notes はまだ空（既存ローカルがゼロなので localList が空のまま継承される）。
		// → 未着のノートが「フォルダから外れて top-level に出る」誤表示は起きない。
		expect(snap.notes).toEqual([]);

		// pull 完了後は cloudList と完全一致
		const finalList = notes.getNoteList();
		expect(finalList.notes.map((n) => n.id).sort()).toEqual(
			['in1', 'in2', 'top'].sort(),
		);
		expect(finalList.folders).toHaveLength(1);
	});

	it('既存ローカルノートは pull 中も保持される（pre-commit が notes を上書きしない）', async () => {
		// 前回 sync 済みの a が local に存在する状態
		const existing = makeNote({ id: 'a', content: 'existing' });
		cloud.setCloudNote(existing);
		await notes.saveNote(existing);
		await cloud.rebuildNoteListFromCloud(iso(10_000));
		await state.updateSyncedState(cloud.noteListModifiedTime, {
			a: await computeContentHash(existing),
		});

		// cloud に新しい b が増えた → pull がトリガされる
		const newOne = makeNote({ id: 'b', content: 'new' });
		cloud.setCloudNote(newOne);
		await cloud.rebuildNoteListFromCloud(iso(20_000));

		let midSnapshot: NoteList | null = null;
		const origDownload = cloud.downloadNote.bind(cloud);
		cloud.downloadNote = async (id) => {
			if (midSnapshot === null) {
				midSnapshot = notes.getNoteList();
			}
			return origDownload(id);
		};

		await orch.syncNotes();

		// pull 中: a は依然としてローカル側に見える
		expect(midSnapshot).not.toBeNull();
		const snap2 = midSnapshot as unknown as NoteList;
		expect(snap2.notes.find((n) => n.id === 'a')).toBeDefined();
		// pull 完了後: a / b 両方
		const finalList = notes.getNoteList();
		expect(finalList.notes.map((n) => n.id).sort()).toEqual(['a', 'b']);
	});

	it('partial pull の中断後、kill 直前のローカル状態でも folder 構造が維持されている', async () => {
		// folder 配下に 3 ノート
		const all = ['a', 'b', 'c'].map((id) =>
			makeNote({ id, content: `cloud-${id}`, folderId: 'f1' }),
		);
		for (const n of all) cloud.setCloudNote(n);
		cloud.noteList.folders = [{ id: 'f1', name: 'Work', archived: false }];
		cloud.noteList.topLevelOrder = [{ type: 'folder', id: 'f1' }];
		await cloud.rebuildNoteListFromCloud(iso(10_000));

		// b の download だけ失敗させて mid-pull kill を擬似的に再現
		const origDownload = cloud.downloadNote.bind(cloud);
		cloud.downloadNote = async (noteId) => {
			if (noteId === 'b') throw new Error('simulated kill');
			return origDownload(noteId);
		};

		await expect(orch.syncNotes()).rejects.toThrow('simulated kill');

		// 中断時点: 構造は確立、a だけ届いている、b/c は未着
		const interrupted = notes.getNoteList();
		expect(interrupted.folders).toEqual([
			{ id: 'f1', name: 'Work', archived: false },
		]);
		expect(interrupted.topLevelOrder).toEqual([{ type: 'folder', id: 'f1' }]);
		// 届いた a は folder 配下のメタとして登録されている
		expect(interrupted.notes.map((n) => n.id)).toEqual(['a']);
		expect(interrupted.notes[0].folderId).toBe('f1');
		// → flattenNoteList で b/c は order 上の未知 ID として silent skip され、
		//   a だけが folder 配下に表示される。フラット落ちは起きない。

		// 再起動 simulate: 失敗注入を解除して resume
		cloud.downloadNote = origDownload;
		await orch.syncNotes();

		const finalList = notes.getNoteList();
		expect(finalList.notes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
		expect(finalList.notes.every((n) => n.folderId === 'f1')).toBe(true);
		expect(finalList.folders).toHaveLength(1);
	});

	it('toDownload が空なら pre-commit は走らない (replaceNoteList は最終の 1 回だけ)', async () => {
		// cloud と local の note は完全一致、cloudTs だけ進んだ状態
		const note = makeNote({ id: 'a', content: 'same' });
		cloud.setCloudNote(note);
		await notes.saveNote(note);
		await cloud.rebuildNoteListFromCloud(iso(10_000));
		// updateSyncedState は呼ばずに cloudChanged を維持
		// → 同じ hash なので toDownload は空になる

		let replaceCount = 0;
		const origReplace = notes.replaceNoteList.bind(notes);
		notes.replaceNoteList = async (list) => {
			replaceCount++;
			return origReplace(list);
		};

		await orch.syncNotes();

		// pre-commit はスキップされ、最終の 1 回だけ
		expect(replaceCount).toBe(1);
	});
});

describe('SyncOrchestrator.syncNotes: ユーザー操作勝ちマージ (pull 中の dirty 検出)', () => {
	// pull 開始時に revision を取り、終了時に変化していたらユーザー操作ありと判断。
	// その場合 cloudList での全置換をやめてローカル list を勝たせ、
	// dirty フラグも維持して次サイクル push でユーザー変更を Drive に伝搬させる。

	it('pull 中に reorder すると、完了後もユーザーの並び順が維持される', async () => {
		// cloud に 2 ノートを順序 [a, b] で置く
		const a = makeNote({ id: 'a', content: 'a' });
		const b = makeNote({ id: 'b', content: 'b' });
		cloud.setCloudNote(a);
		cloud.setCloudNote(b);
		cloud.noteList.topLevelOrder = [
			{ type: 'note', id: 'a' },
			{ type: 'note', id: 'b' },
		];
		await cloud.rebuildNoteListFromCloud(iso(10_000));

		// 1 件目 download 完了直後にユーザーが reorder した想定で
		// topLevelOrder を [b, a] に書き換え + markDirty
		let mutated = false;
		const origDownload = cloud.downloadNote.bind(cloud);
		cloud.downloadNote = async (id) => {
			const result = await origDownload(id);
			if (!mutated) {
				mutated = true;
				const list = notes.getNoteList();
				list.topLevelOrder = [
					{ type: 'note', id: 'b' },
					{ type: 'note', id: 'a' },
				];
				await notes.replaceNoteList(list);
				await state.markDirty();
			}
			return result;
		};

		await orch.syncNotes();

		// ユーザーの reorder が残っている
		const final = notes.getNoteList();
		expect(final.topLevelOrder).toEqual([
			{ type: 'note', id: 'b' },
			{ type: 'note', id: 'a' },
		]);
		// dirty も維持 (次 sync で push される)
		expect(state.isDirty()).toBe(true);
	});

	it('pull 中に新規ノートを作成すると、完了後もリストに残り dirty が立つ', async () => {
		const cloudA = makeNote({ id: 'cloud-a', content: 'from-cloud' });
		cloud.setCloudNote(cloudA);
		await cloud.rebuildNoteListFromCloud(iso(10_000));

		// download 中にユーザーが 'user-b' を新規作成
		let mutated = false;
		const origDownload = cloud.downloadNote.bind(cloud);
		cloud.downloadNote = async (id) => {
			const result = await origDownload(id);
			if (!mutated) {
				mutated = true;
				const newNote = makeNote({
					id: 'user-b',
					content: 'created-during-pull',
				});
				await notes.saveNote(newNote);
				await state.markNoteDirty(newNote.id);
			}
			return result;
		};

		await orch.syncNotes();

		// 両方ローカルに残る (cloud-a は pull で取得、user-b はユーザー作成)
		const final = notes.getNoteList();
		expect(final.notes.map((n) => n.id).sort()).toEqual(['cloud-a', 'user-b']);
		// 'user-b' は dirty として記録され、次 sync で push される
		expect(state.isDirty()).toBe(true);
		expect(state.snapshot().dirtyNoteIds).toHaveProperty('user-b');
		// user-b の本文ファイルも残っている
		expect((await notes.readNote('user-b'))?.content).toBe(
			'created-during-pull',
		);
	});

	it('pull 中にフォルダを作成すると、完了後もフォルダが残る', async () => {
		const cloudA = makeNote({ id: 'a', content: 'from-cloud' });
		cloud.setCloudNote(cloudA);
		await cloud.rebuildNoteListFromCloud(iso(10_000));

		let mutated = false;
		const origDownload = cloud.downloadNote.bind(cloud);
		cloud.downloadNote = async (id) => {
			const result = await origDownload(id);
			if (!mutated) {
				mutated = true;
				await notes.createFolder('UserFolder');
				await state.markDirty();
			}
			return result;
		};

		await orch.syncNotes();

		const final = notes.getNoteList();
		expect(final.folders.some((f) => f.name === 'UserFolder')).toBe(true);
		expect(state.isDirty()).toBe(true);
	});

	it('ユーザー操作なしの pull は従来通り cloudList で全置換される (dirty を立てない)', async () => {
		// cloud 側の構造 (folders / collapsedFolderIds) を仕込む
		const a = makeNote({ id: 'a', content: 'a' });
		cloud.setCloudNote(a);
		cloud.noteList.folders = [
			{ id: 'cloud-f', name: 'CloudFolder', archived: false },
		];
		cloud.noteList.collapsedFolderIds = ['cloud-f'];
		await cloud.rebuildNoteListFromCloud(iso(10_000));

		await orch.syncNotes();

		// dirty は立っていない
		expect(state.isDirty()).toBe(false);
		const final = notes.getNoteList();
		// cloud の構造がそのまま反映されている
		expect(final.folders).toEqual([
			{ id: 'cloud-f', name: 'CloudFolder', archived: false },
		]);
		expect(final.collapsedFolderIds).toEqual(['cloud-f']);
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

	// ★ 実機再現: 大量アップロード途中で kill → 再起動 → connect() で recoverCloudOrphans が
	// 走り 既アップ済みノートが「不明ノート」へローカル退避 → 続いて polling が syncNotes →
	// 残り未アップを完遂し dirty=false まで持っていく挙動の検証。
	it('partial upload → kill → restart で recoverCloudOrphans を経ても残ノートが完遂される', async () => {
		const { recoverCloudOrphans } = await import('../orphanRecovery');

		// 5 件 dirty (offline-first 想定)
		const all = ['a', 'b', 'c', 'd', 'e'].map((id) =>
			makeNote({ id, content: `content-${id}` }),
		);
		for (const n of all) {
			await notes.saveNote(n);
			await state.markNoteDirty(n.id);
		}

		// 前回 session で a, b, c だけ Drive に上げた状態 (noteList は更新されないまま kill された)
		for (const id of ['a', 'b', 'c']) {
			const n = all.find((x) => x.id === id)!;
			cloud.setCloudNote(n);
			await state.updateSyncedNoteHash(id, await computeContentHash(n));
		}
		// cloud noteList は空のまま (ensureDriveLayout が作って以来 updateNoteList 未呼び出し)
		cloud.noteList = {
			version: 'v2',
			notes: [],
			folders: [],
			topLevelOrder: [],
			archivedTopLevelOrder: [],
			collapsedFolderIds: [],
		};
		cloud.noteListModifiedTime = iso(1000);

		// connect() 相当: recoverCloudOrphans が走る
		// → cloud noteList に登録されていない 3 件が「不明ノート」へ退避される
		await recoverCloudOrphans(cloud as unknown as DriveSyncService, notes);

		// この時点でローカルでは a/b/c が「不明ノート」フォルダ配下に移動している
		const orphanFolder = notes
			.getNoteList()
			.folders.find((f) => f.name === '不明ノート');
		expect(orphanFolder).toBeDefined();

		// 続いて polling が syncNotes() を呼ぶ
		const createsBefore = cloud.calls.create;
		const updatesBefore = cloud.calls.update;
		await orch.syncNotes();

		// a/b/c は既に cloud にあるので create されず、d/e だけ新規 create される
		expect(cloud.calls.create - createsBefore).toBe(2);
		expect(cloud.calls.update - updatesBefore).toBe(0);

		// 5 件すべて cloud に存在
		for (const id of ['a', 'b', 'c', 'd', 'e']) {
			expect(cloud.notes.has(id)).toBe(true);
		}
		// cloud noteList にも 5 件全部反映
		expect(cloud.noteList.notes.map((n) => n.id).sort()).toEqual([
			'a',
			'b',
			'c',
			'd',
			'e',
		]);
		// dirty が false になっている
		expect(state.isDirty()).toBe(false);
	});

	// ★ desktop→mobile pull シナリオ: cloud noteList に folders が含まれていれば、
	// 初回サインインの pullCloudChanges を経て mobile 側にも folders が再構築されるか。
	it('desktop が folders 付きで push 済み cloud から mobile が pull すると folders を保持する', async () => {
		// 「desktop が既に folders+notes を cloud に push した状態」を再現する
		const f1: { id: string; name: string; archived: boolean } = {
			id: 'desk-folder-1',
			name: 'Desktop Project',
			archived: false,
		};
		const f2: { id: string; name: string; archived: boolean } = {
			id: 'desk-folder-2',
			name: 'Desktop Misc',
			archived: false,
		};
		const note1 = makeNote({ id: 'n1', folderId: f1.id, content: 'in proj' });
		const note2 = makeNote({ id: 'n2', folderId: f2.id, content: 'in misc' });
		const note3 = makeNote({ id: 'n3', folderId: '', content: 'top level' });
		cloud.setCloudNote(note1);
		cloud.setCloudNote(note2);
		cloud.setCloudNote(note3);
		await cloud.rebuildNoteListFromCloud(iso(1000));
		// 重要: rebuildNoteListFromCloud は notes だけ書き直すので folders は手動で乗せる
		cloud.noteList.folders = [f1, f2];
		cloud.noteList.topLevelOrder = [
			{ type: 'folder', id: f1.id },
			{ type: 'folder', id: f2.id },
			{ type: 'note', id: 'n3' },
		];

		// mobile 側はまっさら (ローカルにノート無し / dirty 無し)
		await orch.syncNotes();

		const local = notes.getNoteList();
		// folders が cloud から復元されているはず
		expect(local.folders.map((f) => f.name).sort()).toEqual([
			'Desktop Misc',
			'Desktop Project',
		]);
		// note1 は f1 配下、note2 は f2 配下、note3 は top level
		expect(local.notes.find((n) => n.id === 'n1')?.folderId).toBe(f1.id);
		expect(local.notes.find((n) => n.id === 'n2')?.folderId).toBe(f2.id);
		expect(local.notes.find((n) => n.id === 'n3')?.folderId).toBe('');
		expect(local.topLevelOrder.length).toBe(3);
	});

	// ★ ユーザー報告: 同期完了後にフォルダ構造が消えてフラットに表示される問題の検証。
	// シナリオ: ローカルでフォルダ分けしたノートを offline-first で作成 → partial upload →
	// kill → 再起動 → recoverCloudOrphans が既アップ分を「不明ノート」へ退避 → polling
	// が残ノートを upload して noteList を確定 → 結果として元のフォルダが残っているか
	it('partial upload → kill → restart 後もユーザーのフォルダ構造が残る', async () => {
		const { recoverCloudOrphans } = await import('../orphanRecovery');

		// ローカルにフォルダを 2 つ作る
		const f1 = await notes.createFolder('Project A');
		const f2 = await notes.createFolder('Project B');

		// 各フォルダに 2 件ずつノートを入れる (a,b ∈ f1, c,d ∈ f2)
		const a = makeNote({ id: 'a', folderId: f1.id, content: 'a' });
		const b = makeNote({ id: 'b', folderId: f1.id, content: 'b' });
		const c = makeNote({ id: 'c', folderId: f2.id, content: 'c' });
		const d = makeNote({ id: 'd', folderId: f2.id, content: 'd' });
		for (const n of [a, b, c, d]) {
			await notes.saveNote(n);
			await state.markNoteDirty(n.id);
		}

		// 前回 session で a, c だけ Drive に上げた状態
		for (const n of [a, c]) {
			cloud.setCloudNote(n);
			await state.updateSyncedNoteHash(n.id, await computeContentHash(n));
		}
		// cloud noteList はまだ空
		cloud.noteList = {
			version: 'v2',
			notes: [],
			folders: [],
			topLevelOrder: [],
			archivedTopLevelOrder: [],
			collapsedFolderIds: [],
		};
		cloud.noteListModifiedTime = iso(1000);

		// connect() 相当: recoverCloudOrphans (a, c は cloud にあるが noteList には無いので「不明ノート」行き)
		await recoverCloudOrphans(cloud as unknown as DriveSyncService, notes);

		// polling が syncNotes() を呼ぶ
		await orch.syncNotes();

		// 同期後の最終状態
		const final = notes.getNoteList();
		const folderNames = final.folders.map((f) => f.name).sort();

		// ★ 元のフォルダ "Project A" / "Project B" が消えていないことを確認
		expect(folderNames).toContain('Project A');
		expect(folderNames).toContain('Project B');

		// b は元のフォルダ f1 のまま
		const bMeta = final.notes.find((n) => n.id === 'b');
		expect(bMeta?.folderId).toBe(f1.id);

		// d は元のフォルダ f2 のまま
		const dMeta = final.notes.find((n) => n.id === 'd');
		expect(dMeta?.folderId).toBe(f2.id);

		// cloud noteList にも folders が反映されている
		const cloudFolderNames = cloud.noteList.folders.map((f) => f.name).sort();
		expect(cloudFolderNames).toContain('Project A');
		expect(cloudFolderNames).toContain('Project B');
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
