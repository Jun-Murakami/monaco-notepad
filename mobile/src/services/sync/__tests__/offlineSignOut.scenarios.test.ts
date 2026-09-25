import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopPeer } from '@/test/desktopPeer';
import { FakeDrive } from '@/test/fakeDrive';
import { MobileDevice } from '@/test/mobileDevice';
import { computeContentHash } from '../hash';
import { saveNoteLocally } from '../localActions';
import {
	MAX_RECOVERED_NOTES_PER_SYNC,
	recoveredNoteTitle,
} from '../syncEngine';

/**
 * オフライン / 連携解除中のノート操作と、復帰時の競合解決（端末間シナリオ）。
 *
 * `mobile` が通信できない・連携を解除している間も、`other` は操作と同期を続ける。
 * 復帰後の同期で次が成り立つことを検証する:
 *   - 離れていた間の操作（作成・編集・削除・移動・並び替え）が失われずに相手へ届く
 *   - 相手の操作も取り込まれる（削除されたノートが復活しない）
 *   - 同じノートの衝突は docs/sync-engine-v3.md §6 どおり（新しい編集が勝つ / 編集は削除に勝つ）
 *     で解決され、負けた版は競合バックアップに残る。衝突していないのにバックアップを作らない
 */

let drive: FakeDrive;
/** オフライン / 連携解除する端末。 */
let mobile: MobileDevice;
/** その間も操作・同期を続ける端末。 */
let other: MobileDevice;

async function contentOf(
	d: MobileDevice,
	id: string,
): Promise<string | undefined> {
	return (await d.readNote(id))?.content;
}

function cloudContent(id: string): string | undefined {
	const file = drive.findByName(`${id}.json`);
	return file ? JSON.parse(file.content).content : undefined;
}

function noteFileCount(id: string): number {
	return [...drive.files.values()].filter((f) => f.name === `${id}.json`)
		.length;
}

function backupsOf(d: MobileDevice): Array<[string, string, string]> {
	return d.backups.map((b) => [b.kind, b.note.id, b.note.content]);
}

/** 両端末を同期し、同じ一覧に収束していることを確かめる。 */
async function syncBoth(): Promise<void> {
	await mobile.sync();
	await other.sync();
	await mobile.sync();
	expect(JSON.stringify(mobile.list())).toBe(JSON.stringify(other.list()));
	expect(await mobile.hasPendingWork()).toBe(false);
	expect(await other.hasPendingWork()).toBe(false);
}

beforeEach(async () => {
	drive = new FakeDrive();
	vi.stubGlobal('fetch', drive.fetch);
	mobile = new MobileDevice(drive, 'mobile');
	other = new MobileDevice(drive, 'other');
	await mobile.boot();
	await other.boot();

	// 共有状態: other が A, B を作り（表示順 [B, A]）、mobile も同期済み
	await other.connect();
	await other.createNote({ id: 'A', title: 'A', content: 'a1' });
	await other.createNote({ id: 'B', title: 'B', content: 'b1' });
	await mobile.connect();
	await mobile.sync();
	expect(mobile.topLevelNoteIds()).toEqual(['B', 'A']);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('オフライン中の操作と復帰', () => {
	it('作成・編集・削除は端末に残り、復帰後の同期で相手へ届く（Drive にはオフライン中に何も書かない）', async () => {
		mobile.goOffline();
		await mobile.createNoteOffline({ id: 'C', title: 'C', content: 'c1' });
		await mobile.createNoteOffline({ id: 'D', title: 'D', content: 'd1' });
		await mobile.editNoteOffline('A', { content: 'a2 offline' });
		await mobile.deleteNoteOffline('B');
		const historyBefore = drive.noteHistory.length;

		expect(await mobile.trySync()).not.toBeNull();
		expect(await mobile.hasPendingWork()).toBe(true);
		expect(drive.noteHistory.length).toBe(historyBefore);
		expect(mobile.topLevelNoteIds()).toEqual(['D', 'C', 'A']);
		expect(await contentOf(mobile, 'A')).toBe('a2 offline');

		mobile.goOnline();
		await syncBoth();
		expect(other.topLevelNoteIds()).toEqual(['D', 'C', 'A']);
		expect(await contentOf(other, 'A')).toBe('a2 offline');
		expect(await other.readNote('B')).toBeNull();
		expect(drive.findByName('B.json')).toBeUndefined();
		expect(backupsOf(mobile)).toEqual([]);
		// 相手の削除でローカルのノートを消すときは必ず残す（cloud_delete）
		expect(backupsOf(other)).toEqual([['cloud_delete', 'B', 'b1']]);
	});

	it('同じノートを両方で編集し相手が後: 相手の版が勝ち、こちらの版は cloud_wins バックアップに残る', async () => {
		mobile.goOffline();
		await mobile.editNoteOffline('A', { content: 'mobile edit' });
		await other.editNote('A', { content: 'other edit (later)' });

		mobile.goOnline();
		await syncBoth();
		expect(await contentOf(mobile, 'A')).toBe('other edit (later)');
		expect(await contentOf(other, 'A')).toBe('other edit (later)');
		expect(cloudContent('A')).toBe('other edit (later)');
		expect(backupsOf(mobile)).toEqual([['cloud_wins', 'A', 'mobile edit']]);
		expect(backupsOf(other)).toEqual([]);
	});

	it('同じノートを両方で編集しこちらが後: こちらの版が勝ち、相手の版は local_wins バックアップに残る', async () => {
		mobile.goOffline();
		await other.editNote('A', { content: 'other edit' });
		await mobile.editNoteOffline('A', { content: 'mobile edit (later)' });

		mobile.goOnline();
		await syncBoth();
		expect(await contentOf(mobile, 'A')).toBe('mobile edit (later)');
		expect(await contentOf(other, 'A')).toBe('mobile edit (later)');
		expect(backupsOf(mobile)).toEqual([['local_wins', 'A', 'other edit']]);
		// other から見ると「自分は変えていない所に新しい版が来た」だけ
		expect(backupsOf(other)).toEqual([]);
	});

	it('オフライン中に編集したノートを相手が削除していた: 編集が勝ち、相手の端末にも戻る', async () => {
		mobile.goOffline();
		await mobile.editNoteOffline('A', { content: 'kept by edit' });
		await other.deleteNoteOffline('A');
		await other.sync();
		expect(drive.findByName('A.json')).toBeUndefined();

		mobile.goOnline();
		await syncBoth();
		expect(await contentOf(mobile, 'A')).toBe('kept by edit');
		expect(await contentOf(other, 'A')).toBe('kept by edit');
		expect(other.topLevelNoteIds()).toContain('A');
		expect(backupsOf(mobile)).toEqual([]);
	});

	it('オフライン中に削除したノートを相手が編集していた: 編集が勝って戻り、削除の意図は残らない', async () => {
		mobile.goOffline();
		await mobile.deleteNoteOffline('A');
		await other.editNote('A', { content: 'edited elsewhere' });

		mobile.goOnline();
		await syncBoth();
		expect(await contentOf(mobile, 'A')).toBe('edited elsewhere');
		expect(mobile.topLevelNoteIds()).toContain('A');
		expect(cloudContent('A')).toBe('edited elsewhere');
		expect(mobile.state.snapshot().deletedNoteIds).toEqual({});
	});

	it('両方で削除: どちらにも残らず、削除の意図も残らない', async () => {
		mobile.goOffline();
		await mobile.deleteNoteOffline('A');
		await other.deleteNoteOffline('A');
		await other.sync();

		mobile.goOnline();
		await syncBoth();
		expect(await mobile.readNote('A')).toBeNull();
		expect(await other.readNote('A')).toBeNull();
		expect(noteFileCount('A')).toBe(0);
		expect(mobile.state.snapshot().deletedNoteIds).toEqual({});
	});

	it('オフライン中に移動した先のフォルダを相手が削除していた: フォルダは復活し、ノートはその中に残る', async () => {
		const f = await other.createFolder('F');
		await other.sync();
		await mobile.sync();

		mobile.goOffline();
		await mobile.moveNoteToFolder('A', f);
		await other.archiveFolder(f);
		await other.deleteArchivedFolder(f);
		await other.sync();

		mobile.goOnline();
		await syncBoth();
		for (const d of [mobile, other]) {
			expect(d.folderOf('A'), d.deviceId).toBe(f);
			const folder = d.list().folders.find((x) => x.id === f);
			expect(folder?.archived, d.deviceId).toBe(false);
			expect(
				d.list().topLevelOrder.some((i) => i.type === 'folder' && i.id === f),
				d.deviceId,
			).toBe(true);
		}
	});

	it('オフライン中の並び替えと相手の新規作成: 両方が反映される', async () => {
		mobile.goOffline();
		await mobile.reorderTopLevel([
			{ type: 'note', id: 'A' },
			{ type: 'note', id: 'B' },
		]);
		await other.createNote({ id: 'N', title: 'N', content: 'n1' });

		mobile.goOnline();
		await syncBoth();
		expect(mobile.topLevelNoteIds()).toEqual(['N', 'A', 'B']);
	});

	it('オフライン中にアプリを再起動しても、未送信の変更は復帰後に送られる', async () => {
		mobile.goOffline();
		await mobile.createNoteOffline({ id: 'C', title: 'C', content: 'c1' });
		await mobile.editNoteOffline('A', { content: 'a2' });
		await mobile.deleteNoteOffline('B');
		expect(await mobile.trySync()).not.toBeNull();

		await mobile.restart();
		expect(await mobile.trySync()).not.toBeNull();
		expect(await mobile.hasPendingWork()).toBe(true);

		mobile.goOnline();
		await syncBoth();
		expect(other.topLevelNoteIds()).toEqual(['C', 'A']);
		expect(await contentOf(other, 'A')).toBe('a2');
		expect(await other.readNote('B')).toBeNull();
	});

	it('同期の途中（本体の送信後・noteList の更新前）で通信が切れても、復帰後に重複・欠落なく収束する', async () => {
		await mobile.createNoteOffline({ id: 'C', title: 'C', content: 'c1' });
		await mobile.editNoteOffline('A', { content: 'a2' });
		drive.beforeRequest(
			(r) =>
				r.deviceId === 'mobile' &&
				r.op === 'files.update' &&
				r.fileName === 'noteList_v2.json',
			() => mobile.goOffline(),
		);
		expect(await mobile.trySync()).not.toBeNull();
		// 本体は Drive にあるが、noteList にはまだ載っていない
		expect(cloudContent('C')).toBe('c1');
		await other.sync();

		mobile.goOnline();
		await syncBoth();
		expect(other.topLevelNoteIds()).toEqual(['C', 'B', 'A']);
		expect(await contentOf(other, 'A')).toBe('a2');
		expect(noteFileCount('C')).toBe(1);
		expect(noteFileCount('A')).toBe(1);
		expect(backupsOf(mobile)).toEqual([]);
		expect(backupsOf(other)).toEqual([]);
	});

	it('フォルダごとアーカイブ（オフライン）と相手の編集が衝突しても、ノートは表示される場所に残る', async () => {
		const f = await other.createFolder('F');
		await other.moveNoteToFolder('A', f);
		await other.moveNoteToFolder('B', f);
		await other.sync();
		await mobile.sync();

		mobile.goOffline();
		await mobile.archiveFolder(f);
		await other.editNote('A', { content: 'edited after archive' });

		mobile.goOnline();
		await syncBoth();
		// 新しい編集が勝つ（アーカイブした版はバックアップに残る）
		expect(await contentOf(mobile, 'A')).toBe('edited after archive');
		expect(backupsOf(mobile).map(([kind, id]) => [kind, id])).toEqual([
			['cloud_wins', 'A'],
		]);
		for (const d of [mobile, other]) {
			const list = d.list();
			for (const n of list.notes) {
				if (!n.folderId) continue;
				// アクティブなノートがアーカイブ済みフォルダにあると、どの画面にも表示されない
				const folder = list.folders.find((x) => x.id === n.folderId);
				expect(folder?.archived, `${d.deviceId}: ${n.id}`).toBe(n.archived);
			}
		}
	});
});

describe('連携解除（サインアウト）中の操作と再接続', () => {
	it('解除中に作成・編集したノートは再接続後に送られ、競合バックアップは作られない', async () => {
		await mobile.signOut();
		await mobile.editNoteOffline('A', { content: 'a2 while signed out' });
		await mobile.createNoteOffline({ id: 'C', title: 'C', content: 'c1' });

		await mobile.signIn();
		await syncBoth();
		expect(other.topLevelNoteIds()).toEqual(['C', 'B', 'A']);
		expect(await contentOf(other, 'A')).toBe('a2 while signed out');
		expect(backupsOf(mobile)).toEqual([]);
		expect(backupsOf(other)).toEqual([]);
	});

	it('解除中に相手が編集しただけのノートは、バックアップを作らずに相手の版になる', async () => {
		await mobile.signOut();
		await other.editNote('A', { content: 'a2 by other' });

		await mobile.signIn();
		await syncBoth();
		expect(await contentOf(mobile, 'A')).toBe('a2 by other');
		expect(backupsOf(mobile)).toEqual([]);
	});

	it('解除中に相手が削除したノートは、再接続後にこの端末からも消える（復活しない）', async () => {
		await mobile.signOut();
		await other.deleteNoteOffline('A');
		await other.sync();

		await mobile.signIn();
		await syncBoth();
		expect(await mobile.readNote('A')).toBeNull();
		expect(drive.findByName('A.json')).toBeUndefined();
		expect(backupsOf(mobile)).toEqual([['cloud_delete', 'A', 'a1']]);
	});

	it('削除を同期する前に解除しても、再接続後に削除が相手へ届く', async () => {
		mobile.goOffline();
		await mobile.deleteNoteOffline('A');
		expect(await mobile.trySync()).not.toBeNull();
		await mobile.signOut();
		mobile.goOnline();

		await mobile.signIn();
		await syncBoth();
		expect(drive.findByName('A.json')).toBeUndefined();
		expect(await other.readNote('A')).toBeNull();
		expect(await mobile.readNote('A')).toBeNull();
	});

	it('解除中に削除したノートを相手が編集していた: 編集が勝つ', async () => {
		await mobile.signOut();
		await mobile.deleteNoteOffline('A');
		await other.editNote('A', { content: 'edited elsewhere' });

		await mobile.signIn();
		await syncBoth();
		expect(await contentOf(mobile, 'A')).toBe('edited elsewhere');
		expect(cloudContent('A')).toBe('edited elsewhere');
	});

	it('解除中のフォルダ作成・移動・並び替えは再接続後も保たれる', async () => {
		await mobile.signOut();
		const f = await mobile.createFolder('F');
		await mobile.moveNoteToFolder('A', f);
		await mobile.reorderTopLevel([
			{ type: 'note', id: 'B' },
			{ type: 'folder', id: f },
		]);

		await mobile.signIn();
		await syncBoth();
		for (const d of [mobile, other]) {
			expect(d.folderOf('A'), d.deviceId).toBe(f);
			expect(d.list().topLevelOrder, d.deviceId).toEqual([
				{ type: 'note', id: 'B' },
				{ type: 'folder', id: f },
			]);
		}
	});

	it('別のアカウントに接続し直した場合: 以前の Drive の同期記録を持ち込まず、ノートを消さずにアップロードする', async () => {
		await mobile.signOut();
		const drive2 = new FakeDrive('acct2');
		const peer2 = new DesktopPeer(drive2);
		peer2.ensureLayout();
		peer2.saveNote({
			id: 'X',
			title: 'X',
			content: 'x1',
			language: 'markdown',
			archived: false,
			modifiedTime: drive2.now(),
		});
		const historyBefore = drive.noteHistory.length;
		vi.stubGlobal('fetch', drive2.fetch);

		await mobile.signIn();
		await mobile.sync();
		expect(
			mobile
				.list()
				.notes.map((n) => n.id)
				.sort(),
		).toEqual(['A', 'B', 'X']);
		expect(drive2.findByName('A.json')).toBeDefined();
		expect(drive2.findByName('B.json')).toBeDefined();
		expect(backupsOf(mobile)).toEqual([]);
		// 元のアカウントの Drive には何も書かない
		expect(drive.noteHistory.length).toBe(historyBefore);
	});
});

describe('復帰時の競合（シミュレーションで見つかったレース）', () => {
	it('削除後に古い編集で復元されたノートを、削除された版を持つ別の端末が書き戻さない', async () => {
		const third = new MobileDevice(drive, 'third');
		await third.boot();
		await third.connect();
		await third.sync();

		mobile.goOffline();
		await mobile.editNoteOffline('A', { content: 'offline edit (older)' });
		await other.editNote('A', { content: 'other edit (newer)' });
		await third.sync();
		await other.deleteNoteOffline('A');
		await other.sync();

		// 編集は削除に勝つ: オフラインだった端末がノートを作り直す（時刻は削除された版より古い）
		mobile.goOnline();
		await mobile.sync();
		await third.sync();
		await other.sync();
		await mobile.sync();

		for (const d of [mobile, other, third]) {
			expect(await contentOf(d, 'A'), d.deviceId).toBe('offline edit (older)');
		}
		expect(cloudContent('A')).toBe('offline edit (older)');
		// 削除された版はそれを持っていた端末に残る（他端末でのリモート削除と同じ扱い）
		expect(backupsOf(third)).toEqual([
			['cloud_wins', 'A', 'other edit (newer)'],
		]);
	});

	it('判断から書き込みまでの間に他端末が新しい版を書いて上書きされても、上書きした側の版はバックアップに残る', async () => {
		await mobile.editNoteOffline('A', { content: 'mobile edit (older)' });
		drive.beforeRequest(
			(r) =>
				r.deviceId === 'mobile' &&
				r.op === 'files.update' &&
				r.fileName === 'A.json',
			async () => {
				await other.editNote('A', { content: 'other edit (newer)' });
			},
		);
		await mobile.sync();
		// mobile の古い判断による書き込みで、other の新しい版が上書きされた
		expect(cloudContent('A')).toBe('mobile edit (older)');

		await syncBoth();
		expect(await contentOf(mobile, 'A')).toBe('other edit (newer)');
		expect(await contentOf(other, 'A')).toBe('other edit (newer)');
		expect(backupsOf(other)).toEqual([
			['local_wins', 'A', 'mobile edit (older)'],
		]);
	});
	it('自分の版を見ずに新しい版で上書きされた端末は、自分の版をバックアップに残す', async () => {
		await other.editNoteOffline('A', { content: 'other edit (older)' });
		await mobile.editNoteOffline('A', { content: 'mobile edit (newer)' });
		// mobile は「Drive は前回から変わっていない」と判断して送る。その送信の直前に other が自分の編集を送る
		drive.beforeRequest(
			(r) =>
				r.deviceId === 'mobile' &&
				r.op === 'files.update' &&
				r.fileName === 'A.json',
			async () => {
				await other.sync();
			},
		);
		await mobile.sync();
		expect(cloudContent('A')).toBe('mobile edit (newer)');

		await syncBoth();
		expect(await contentOf(other, 'A')).toBe('mobile edit (newer)');
		// mobile は other の版を見ていないので、other から見ると競合。新しい方が勝ち、自分の版は残る
		expect(backupsOf(other)).toEqual([
			['cloud_wins', 'A', 'other edit (older)'],
		]);
	});

	it('入れ違いが 2 回重なっても（見ずに上書きされた版の上に別端末が書いても）、消えた版はバックアップに残る', async () => {
		const third = new MobileDevice(drive, 'third');
		await third.boot();
		await third.connect();
		await third.sync();

		// other は「Drive は前回から変わっていない」と判断して送る。その送信の直前に mobile が編集を送る
		await other.editNoteOffline('A', { content: 'other edit (blind)' });
		drive.beforeRequest(
			(r) =>
				r.deviceId === 'other' &&
				r.op === 'files.update' &&
				r.fileName === 'A.json',
			async () => {
				await mobile.editNote('A', { content: 'mobile edit' });
			},
		);
		await other.sync();
		expect(cloudContent('A')).toBe('other edit (blind)');
		// mobile が同期する前に、third が other の版を見た上で（より新しく）書く
		await third.sync();
		await third.editNote('A', { content: 'third edit (newest)' });

		await mobile.sync();
		await other.sync();
		await third.sync();
		for (const d of [mobile, other, third]) {
			expect(await contentOf(d, 'A'), d.deviceId).toBe('third edit (newest)');
		}
		expect(backupsOf(mobile)).toEqual([['cloud_wins', 'A', 'mobile edit']]);
		expect(backupsOf(other)).toEqual([]);
		expect(backupsOf(third)).toEqual([]);
	});

	it('相手が続けて編集した途中の版を見逃しただけなら、バックアップを作らない', async () => {
		mobile.goOffline();
		await other.editNote('A', { content: 'a2' });
		await other.editNote('A', { content: 'a3' });
		await other.editNote('A', { content: 'a4' });

		mobile.goOnline();
		await syncBoth();
		expect(await contentOf(mobile, 'A')).toBe('a4');
		expect(backupsOf(mobile)).toEqual([]);
	});

	// 既知の制限: 勝敗は modifiedTime（端末の時計）で決めるので、時計が大きく進んでいる端末があると
	// その後の他端末の編集が巻き戻ることがある。ただし黙っては消えず、バックアップに残る。
	it('時計が進んでいる端末があると後からの編集が巻き戻ることがあるが、黙っては消えない', async () => {
		// other の時計は 1 年進んでいる
		const a = await other.readNote('A');
		if (!a) throw new Error('A missing');
		await saveNoteLocally(other.notes, other.state, {
			...a,
			content: 'edited on a clock that runs ahead',
			modifiedTime: '2027-01-01T00:00:00.000Z',
		});
		await other.sync();
		await mobile.sync();
		// mobile は other の版を見た上で編集する（mobile の時計ではこちらの方が古い時刻になる）
		await mobile.editNote('A', { content: 'edited later on mobile' });

		await syncBoth();
		expect(await contentOf(mobile, 'A')).toBe(
			'edited on a clock that runs ahead',
		);
		expect(backupsOf(other)).toEqual([
			['local_wins', 'A', 'edited later on mobile'],
		]);
	});
});

describe('ノート一覧の記録（contentHash）と本体の食い違い', () => {
	/** ノート本体が Drive に書き込まれた回数。 */
	function uploadCount(id: string): number {
		return drive.noteHistory.filter(
			(h) => h.kind === 'upload' && h.name === `${id}.json`,
		).length;
	}

	/** ノート一覧に記録された contentHash だけを本体と食い違わせる（旧版や保存途中の中断で起きうる状態）。 */
	async function setStaleListHash(d: MobileDevice, id: string): Promise<void> {
		await d.notes.transact(async (tx) => {
			const list = tx.list();
			await tx.setNoteList({
				...list,
				notes: list.notes.map((n) =>
					n.id === id
						? { ...n, contentHash: 'stale-hash-from-an-older-version' }
						: n,
				),
			});
		});
	}

	it('記録が古いだけで中身が同じノートを送り続けない（記録は本体に合わせて直る）', async () => {
		await setStaleListHash(mobile, 'A');
		const before = uploadCount('A');

		for (let i = 0; i < 5; i++) {
			await mobile.sync();
			await other.sync();
		}

		expect(uploadCount('A')).toBe(before);
		const note = await mobile.readNote('A');
		if (!note) throw new Error('A missing');
		expect(mobile.list().notes.find((n) => n.id === 'A')?.contentHash).toBe(
			await computeContentHash(note),
		);
	});

	it('一覧が知らないうちに本体が変わっていたら、勝敗を決めずに復帰ノートとして残す', async () => {
		// mobile の本体だけが（一覧の記録を更新しないまま）別の内容になっている
		await changeFileBehindList(
			mobile,
			'A',
			'local file content the list does not know about',
		);
		// 相手が A を編集する
		await other.editNote('A', { content: 'other edit' });

		await mobile.sync();
		// A は相手の版になり、mobile の本体の内容は復帰ノートとして残る（バックアップではなく別のノート）
		expect(await contentOf(mobile, 'A')).toBe('other edit');
		expect(await recoveredNotes(mobile)).toEqual({
			'A (Recovered)': 'local file content the list does not know about',
		});
		expect(backupsOf(mobile)).toEqual([]);
	});
});

// ---- 出どころ不明のローカルの内容（復帰ノート） ----

/** ノート一覧の記録を変えずに本体だけを書き換える（過去のバージョンの不具合で起きた状態）。 */
async function changeFileBehindList(
	d: MobileDevice,
	id: string,
	content: string,
): Promise<void> {
	const note = await d.readNote(id);
	if (!note) throw new Error(`${id} missing`);
	await d.notes.transact((tx) => tx.writeNoteFile({ ...note, content }));
}

/** 復帰ノートのタイトル → 内容（このテストのノートは ID とタイトルが同じなので、それ以外）。 */
async function recoveredNotes(
	d: MobileDevice,
): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const m of d.list().notes) {
		if (m.id === m.title) continue;
		out[m.title] = (await contentOf(d, m.id)) ?? '';
	}
	return out;
}

function recoveredNoteId(d: MobileDevice): string | undefined {
	return d.list().notes.find((m) => m.id !== m.title)?.id;
}

/** ノート一覧の記録が本体と一致しているか。 */
async function listHashMatchesFile(
	d: MobileDevice,
	id: string,
): Promise<boolean> {
	const note = await d.readNote(id);
	if (!note) throw new Error(`${id} missing`);
	return (
		d.list().notes.find((m) => m.id === id)?.contentHash ===
		(await computeContentHash(note))
	);
}

describe('出どころ不明のローカルの内容（復帰ノート）', () => {
	it('起動後の最初の同期で見つけ、元のノートのすぐ下に復帰ノートとして残す', async () => {
		await changeFileBehindList(mobile, 'A', 'only on this mobile');
		// 同期の判定だけでは気づかない（記録も base も同じ）。起動後の最初の同期で全ノートを本体と照合する
		await mobile.restart();

		await syncBoth();
		const recovered = recoveredNoteId(mobile);
		if (!recovered) throw new Error('recovered note missing');
		for (const d of [mobile, other]) {
			expect(await contentOf(d, 'A')).toBe('a1');
			expect(await recoveredNotes(d)).toEqual({
				'A (Recovered)': 'only on this mobile',
			});
			expect(d.topLevelNoteIds()).toEqual(['B', 'A', recovered]);
			expect(backupsOf(d)).toEqual([]);
		}
		expect(cloudContent(recovered)).toBe('only on this mobile');
		expect(await listHashMatchesFile(mobile, 'A')).toBe(true);

		// 一度分けたら繰り返さない
		await mobile.restart();
		await syncBoth();
		expect(Object.keys(await recoveredNotes(mobile))).toHaveLength(1);
	});

	it('復帰ノートは同じフォルダの、元のノートのすぐ下に入る', async () => {
		const folder = await other.createFolder('F');
		await other.moveNoteToFolder('A', folder);
		await other.moveNoteToFolder('B', folder);
		await other.sync();
		await mobile.sync();
		const inFolder = (d: MobileDevice) =>
			d
				.list()
				.notes.filter((m) => m.folderId === folder)
				.map((m) => m.id);
		const before = inFolder(mobile);
		expect([...before].sort()).toEqual(['A', 'B']);
		await changeFileBehindList(mobile, 'B', 'only on this mobile');
		await mobile.restart();

		await syncBoth();
		const recovered = recoveredNoteId(mobile);
		if (!recovered) throw new Error('recovered note missing');
		const want = before.flatMap((id) => (id === 'B' ? [id, recovered] : [id]));
		for (const d of [mobile, other]) {
			expect(await recoveredNotes(d)).toEqual({
				'B (Recovered)': 'only on this mobile',
			});
			expect(inFolder(d)).toEqual(want);
		}
	});

	it('一度に大量に食い違うときは分けず、送らず、記録も直さない', async () => {
		const ids: string[] = [];
		for (let i = 0; i <= MAX_RECOVERED_NOTES_PER_SYNC; i++) {
			const id = `N${String(i).padStart(2, '0')}`;
			await other.createNote({ id, title: id, content: `synced ${id}` });
			ids.push(id);
		}
		await mobile.sync();
		for (const id of ids) {
			await changeFileBehindList(mobile, id, `local ${id}`);
		}
		const historyBefore = drive.noteHistory.length;
		await mobile.restart();

		await mobile.sync();
		expect(await recoveredNotes(mobile)).toEqual({});
		for (const id of ids) {
			expect(await contentOf(mobile, id)).toBe(`local ${id}`);
			expect(cloudContent(id)).toBe(`synced ${id}`);
			expect(await listHashMatchesFile(mobile, id)).toBe(false);
		}
		expect(drive.noteHistory.length).toBe(historyBefore);
	});

	it('リモートの版を取れなかったら分けず、次の同期でやり直す', async () => {
		await changeFileBehindList(mobile, 'A', 'only on this mobile');
		await mobile.restart();
		drive.failWhen(
			(r) =>
				r.deviceId === 'mobile' &&
				r.op === 'files.download' &&
				r.fileName === 'A.json',
			500,
			1,
		);

		await mobile.sync();
		expect(await recoveredNotes(mobile)).toEqual({});
		expect(await contentOf(mobile, 'A')).toBe('only on this mobile');

		await syncBoth();
		expect(await contentOf(mobile, 'A')).toBe('a1');
		expect(await recoveredNotes(mobile)).toEqual({
			'A (Recovered)': 'only on this mobile',
		});
	});

	it('同期中にユーザーが編集を続けたら分けず、上書きされるクラウドの版をバックアップに残す', async () => {
		await changeFileBehindList(mobile, 'A', 'only on this mobile');
		await mobile.restart();
		drive.beforeRequest(
			(r) =>
				r.deviceId === 'mobile' &&
				r.op === 'files.download' &&
				r.fileName === 'A.json',
			async () => {
				const a = await mobile.readNote('A');
				if (!a) throw new Error('A missing');
				await saveNoteLocally(mobile.notes, mobile.state, {
					...a,
					content: 'edited during sync',
					modifiedTime: drive.now(),
				});
			},
		);

		await mobile.sync();
		await syncBoth();
		expect(await recoveredNotes(mobile)).toEqual({});
		expect(await contentOf(mobile, 'A')).toBe('edited during sync');
		expect(await contentOf(other, 'A')).toBe('edited during sync');
		expect(backupsOf(mobile)).toEqual([['local_wins', 'A', 'a1']]);
	});

	it('相手が削除していたら分けずに、手元の内容で復元する（編集は削除に勝つ）', async () => {
		await other.deleteNoteOffline('A');
		await other.sync();
		await changeFileBehindList(mobile, 'A', 'only on this mobile');
		await mobile.restart();

		await syncBoth();
		expect(await recoveredNotes(mobile)).toEqual({});
		expect(await contentOf(mobile, 'A')).toBe('only on this mobile');
		expect(await contentOf(other, 'A')).toBe('only on this mobile');
	});

	it('タイトルの接尾辞は UI の言語に合わせる', () => {
		expect(recoveredNoteTitle('A', 'ja')).toBe('A(復帰済み)');
		expect(recoveredNoteTitle('A', 'en')).toBe('A (Recovered)');
	});
});
