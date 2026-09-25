import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeAtomic } from '@/services/storage/atomicFile';
import { storagePaths } from '@/services/storage/paths';
import { DesktopPeer, goContentHash, type PeerNote } from '@/test/desktopPeer';
import { FakeDrive } from '@/test/fakeDrive';
import { MobileDevice } from '@/test/mobileDevice';
import { computeContentHash } from '../hash';

/**
 * SyncEngine（v3）の振る舞いテスト。本番の DriveClient / DriveGateway を FakeDrive 上で動かし、
 * 相手端末はデスクトップ形式のピア（または別のモバイル端末）で模擬する。
 * 検証するのは「最終的に端末とクラウドがどういう状態になるか」であり、呼び出し回数ではない。
 */

let drive: FakeDrive;
let peer: DesktopPeer;
let mobile: MobileDevice;

function peerNote(
	id: string,
	content: string,
	overrides: Partial<PeerNote> = {},
): PeerNote {
	return {
		id,
		title: `Title ${id}`,
		content,
		language: 'markdown',
		archived: false,
		modifiedTime: drive.now(),
		...overrides,
	};
}

function cloudIds(): string[] {
	return peer.readList().notes.map((n) => n.id);
}

function cloudTopIds(): string[] {
	return (peer.readList().topLevelOrder ?? [])
		.filter((i) => i.type === 'note')
		.map((i) => i.id);
}

async function seedShared(): Promise<void> {
	peer.saveNote(peerNote('A', 'a1'));
	peer.saveNote(peerNote('B', 'b1'));
	await mobile.connect();
	await mobile.sync();
}

beforeEach(async () => {
	drive = new FakeDrive();
	vi.stubGlobal('fetch', drive.fetch);
	peer = new DesktopPeer(drive);
	mobile = new MobileDevice(drive);
	await mobile.boot();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('初回同期', () => {
	it('空の Drive にローカルのノートを全部上げ、noteList を作る（順序もそのまま）', async () => {
		await mobile.createNote({ id: 'X', title: 'x', content: 'x1' });
		await mobile.createNote({ id: 'Y', title: 'y', content: 'y1' });
		await mobile.connect();

		await mobile.sync();

		peer.ensureLayout();
		expect(cloudTopIds()).toEqual(['Y', 'X']);
		expect(peer.readCloudNote('X')?.content).toBe('x1');
		expect(peer.readCloudNote('Y')?.content).toBe('y1');
	});

	it('既存の Drive からフォルダ・順序ごと取り込む', async () => {
		peer.ensureLayout();
		peer.createFolder('work', 'Work');
		peer.saveNote(peerNote('W1', 'w1'), { folderId: 'work' });
		peer.saveNote(peerNote('A', 'a1'));
		await mobile.connect();

		await mobile.sync();

		expect(mobile.list().topLevelOrder).toEqual([
			{ type: 'note', id: 'A' },
			{ type: 'folder', id: 'work' },
		]);
		expect(mobile.folderOf('W1')).toBe('work');
		expect((await mobile.readNote('W1'))?.content).toBe('w1');
	});

	it('2 回目の同期は何も送受信しない（冪等）', async () => {
		peer.ensureLayout();
		await seedShared();

		const report = await mobile.sync();

		expect(report).toMatchObject({
			uploaded: 0,
			downloaded: 0,
			deletedLocal: 0,
			deletedRemote: 0,
			listUploaded: false,
		});
		expect(await mobile.hasPendingWork()).toBe(false);
	});
});

describe('競合と削除', () => {
	beforeEach(() => {
		peer.ensureLayout();
	});

	it('同時編集でピアが新しければピアの内容を採用し、ローカル版をバックアップする', async () => {
		await seedShared();
		await mobile.editNoteOffline('A', { content: 'older on mobile' });
		peer.saveNote(peerNote('A', 'newer on desktop'));

		await mobile.sync();

		expect((await mobile.readNote('A'))?.content).toBe('newer on desktop');
		expect(mobile.backups).toHaveLength(1);
		expect(mobile.backups[0]).toMatchObject({ kind: 'cloud_wins' });
		expect(mobile.backups[0].note.content).toBe('older on mobile');
	});

	it('同時編集でモバイルが新しければモバイルの内容がクラウドに残る', async () => {
		await seedShared();
		peer.saveNote(peerNote('A', 'older on desktop'));
		await mobile.editNoteOffline('A', { content: 'newer on mobile' });

		await mobile.sync();

		expect(peer.readCloudNote('A')?.content).toBe('newer on mobile');
		expect((await mobile.readNote('A'))?.content).toBe('newer on mobile');
		const meta = peer.readList().notes.find((n) => n.id === 'A');
		expect(meta?.contentHash).toBe(
			goContentHash(peer.readCloudNote('A') as PeerNote),
		);
	});

	it('ピアで削除されたノートは、モバイルで編集していればクラウドに復活する（編集が勝つ）', async () => {
		await seedShared();
		await mobile.editNoteOffline('B', {
			content: 'edited while deleted elsewhere',
		});
		peer.deleteNote('B');

		await mobile.sync();

		expect(peer.readCloudNote('B')?.content).toBe(
			'edited while deleted elsewhere',
		);
		expect(cloudIds()).toContain('B');
	});

	it('ピアで削除されたノートは、モバイルで触っていなければバックアップして消す', async () => {
		await seedShared();
		peer.deleteNote('B');

		await mobile.sync();

		expect(mobile.list().notes.map((n) => n.id)).toEqual(['A']);
		expect(mobile.backups.map((b) => b.kind)).toEqual(['cloud_delete']);
	});

	it('モバイルで削除したノートは、ピアが編集していれば復元され削除意図は取り消される', async () => {
		await seedShared();
		await mobile.deleteNoteOffline('B');
		peer.saveNote(peerNote('B', 'b2 edited on desktop'));

		await mobile.sync();

		expect((await mobile.readNote('B'))?.content).toBe('b2 edited on desktop');
		expect(cloudIds()).toContain('B');
		expect(mobile.state.snapshot().deletedNoteIds).toEqual({});
	});

	it('モバイルで削除したノートはクラウドからも消える', async () => {
		await seedShared();
		await mobile.deleteNoteOffline('B');

		await mobile.sync();

		expect(peer.readCloudNote('B')).toBeUndefined();
		expect(cloudIds()).toEqual(['A']);
		expect(await mobile.hasPendingWork()).toBe(false);
	});

	it('同期中に編集されたノートはダウンロード結果で上書きせず、次の同期で競合として解決する', async () => {
		await seedShared();
		peer.saveNote(peerNote('A', 'a2 from desktop'));
		drive.beforeRequest(
			(r) =>
				r.deviceId === 'mobile' &&
				r.op === 'files.download' &&
				r.fileName === 'A.json',
			async () => {
				await mobile.editNoteOffline('A', { content: 'typed during sync' });
			},
		);

		await mobile.sync();
		expect((await mobile.readNote('A'))?.content).toBe('typed during sync');

		await mobile.sync();
		// モバイルの編集の方が新しいので勝ち、ピアの版はバックアップされる
		expect(peer.readCloudNote('A')?.content).toBe('typed during sync');
		expect((await mobile.readNote('A'))?.content).toBe('typed during sync');
	});
});

describe('障害からの回復', () => {
	beforeEach(() => {
		peer.ensureLayout();
	});

	it('ダウンロードが一時エラーでも、次の同期で内容が届く', async () => {
		await seedShared();
		peer.saveNote(peerNote('B', 'b2'));
		drive.failWhen(
			(r) =>
				r.deviceId === 'mobile' &&
				r.op === 'files.download' &&
				r.fileName === 'B.json',
			500,
			1,
		);

		const first = await mobile.sync();
		expect(first.failures).toBe(1);
		expect(await mobile.hasPendingWork()).toBe(true);

		await mobile.sync();
		expect((await mobile.readNote('B'))?.content).toBe('b2');
	});

	it('新規ノートのアップロードに失敗しても、クラウド noteList に本体の無い記載を作らない', async () => {
		await seedShared();
		await mobile.createNoteOffline({ id: 'M', title: 'm', content: 'm1' });
		await mobile.editNoteOffline('M', { content: 'm2' });
		drive.failWhen(
			(r) =>
				r.deviceId === 'mobile' &&
				r.op === 'files.create' &&
				r.fileName === 'M.json',
			503,
			1,
		);

		await mobile.sync();
		expect(cloudIds()).not.toContain('M');

		await mobile.sync();
		expect(cloudIds()).toContain('M');
		expect(cloudTopIds()[0]).toBe('M');
		expect(peer.readCloudNote('M')?.content).toBe('m2');
	});

	it('noteList の書き込み直前にピアが書いたら、上書きせずにやり直して両方を残す', async () => {
		await seedShared();
		await mobile.createNoteOffline({ id: 'M', title: 'm', content: 'm1' });
		await mobile.editNoteOffline('A', { content: 'a2 on mobile' });
		let fired = false;
		drive.beforeRequest(
			(r) =>
				!fired &&
				r.deviceId === 'mobile' &&
				r.op === 'files.list' &&
				(r.query ?? '').includes("name='noteList_v2.json'") &&
				drive.requests.some(
					(q) =>
						q.deviceId === 'mobile' &&
						q.op === 'files.update' &&
						q.fileName === 'A.json',
				),
			() => {
				fired = true;
				peer.saveNote(peerNote('P', 'from desktop'));
			},
		);

		const report = await mobile.sync();

		expect(report.attempts).toBe(2);
		expect(cloudIds()).toEqual(expect.arrayContaining(['A', 'B', 'M', 'P']));
		expect(mobile.list().notes.map((n) => n.id)).toEqual(
			expect.arrayContaining(['P']),
		);
	});
});

describe('v2 からの移行・Drive の入れ替わり', () => {
	beforeEach(() => {
		peer.ensureLayout();
	});

	it('v2 の同期記録（hash のみ）から、内容を壊さず・余計なアップロード無しで移行する', async () => {
		// v2 で同期済みの状態を作る: ピアの A をモバイルがローカルに持ち、lastSyncedNoteHash を記録済み
		const a = peerNote('A', 'a1');
		peer.saveNote(a);
		await mobile.notes.saveNote(
			{ ...a, contentHeader: 'a1', folderId: '' },
			{ prependToOrder: true },
		);
		const paths = storagePaths('/mem/devices/mobile/monaco-notepad/');
		const hash = await computeContentHash({
			...a,
			contentHeader: '',
			folderId: '',
		});
		await writeAtomic(
			paths.syncStatePath,
			JSON.stringify({
				dirty: false,
				lastSyncedDriveTs: '2026-01-01T00:00:00Z',
				dirtyNoteIds: {},
				deletedNoteIds: {},
				deletedFolderIds: {},
				lastSyncedNoteHash: { A: hash },
			}),
		);
		mobile = new MobileDevice(drive);
		await mobile.boot();
		await mobile.connect();

		const report = await mobile.sync();

		expect(report.uploaded).toBe(0);
		expect((await mobile.readNote('A'))?.content).toBe('a1');
		expect(await mobile.hasPendingWork()).toBe(false);
	});

	it('Drive のデータが丸ごと消えても（別端末で全削除）、ローカルのノートは消さずに上げ直す', async () => {
		await seedShared();
		for (const f of [...drive.files.values()]) {
			if (f.name === 'monaco-notepad') drive.deleteFile(f.id);
		}

		await mobile.sync();

		expect(
			mobile
				.list()
				.notes.map((n) => n.id)
				.sort(),
		).toEqual(['A', 'B']);
		peer.ensureLayout();
		expect(cloudIds().sort()).toEqual(['A', 'B']);
		expect(peer.readCloudNote('A')?.content).toBe('a1');
	});

	it('同じノートの本体ファイルが重複していたら、新しい方を採用し古い方を消す', async () => {
		await seedShared();
		// 別端末の不具合で同名ファイルが 2 つできた
		drive.createFile(
			'A.json',
			[peer.notesFolder().id],
			JSON.stringify({ ...peerNote('A', 'a-dup-newer') }),
		);

		await mobile.sync();

		expect((await mobile.readNote('A'))?.content).toBe('a-dup-newer');
		expect(drive.list(`name='A.json' and trashed=false`)).toHaveLength(1);
	});

	it('本体の無い noteList の記載（ゴースト）は取り込まず、クラウドからも落とす', async () => {
		await seedShared();
		peer.publishNoteMeta(peerNote('G', 'ghost'));
		await mobile.editNoteOffline('A', { content: 'a2' });

		await mobile.sync();

		expect(mobile.list().notes.map((n) => n.id)).not.toContain('G');
		expect(cloudIds()).not.toContain('G');
	});
});

describe('複数のモバイル端末', () => {
	it('別々のノートを同時に編集・作成しても、両端末とクラウドが同じ状態に収束する', async () => {
		peer.ensureLayout();
		peer.saveNote(peerNote('A', 'a1'));
		peer.saveNote(peerNote('B', 'b1'));
		const phone = mobile;
		const tablet = new MobileDevice(drive, 'tablet');
		await tablet.boot();
		await phone.connect();
		await tablet.connect();
		await phone.sync();
		await tablet.sync();

		await phone.editNoteOffline('A', { content: 'a2 phone' });
		await phone.createNoteOffline({
			id: 'P1',
			title: 'p',
			content: 'phone new',
		});
		await tablet.editNoteOffline('B', { content: 'b2 tablet' });
		await tablet.createNoteOffline({
			id: 'T1',
			title: 't',
			content: 'tablet new',
		});
		await phone.sync();
		await tablet.sync();
		await phone.sync();

		for (const device of [phone, tablet]) {
			expect(new Set(device.list().notes.map((n) => n.id))).toEqual(
				new Set(['A', 'B', 'P1', 'T1']),
			);
			expect((await device.readNote('A'))?.content).toBe('a2 phone');
			expect((await device.readNote('B'))?.content).toBe('b2 tablet');
		}
		expect(phone.list().topLevelOrder).toEqual(tablet.list().topLevelOrder);
		expect(phone.topLevelNoteIds().slice(0, 2).sort()).toEqual(['P1', 'T1']);
	});
});
