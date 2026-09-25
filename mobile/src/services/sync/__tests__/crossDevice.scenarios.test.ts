import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopPeer, goContentHash, type PeerNote } from '@/test/desktopPeer';
import { FakeDrive } from '@/test/fakeDrive';
import { MobileDevice } from '@/test/mobileDevice';

/**
 * 端末間シナリオテスト（モバイル × デスクトップ形式のピア）。
 *
 * ピアは「プロトコル通りに正しく振る舞う別端末」。ここで落ちるテストは、
 * 相手が正しくてもモバイル側の同期が データを壊す / 変更を取りこぼす ことを意味する。
 * ユーザー報告の 3 症状をそれぞれ再現する:
 *   ① モバイル⇄デスクトップの変更が反映されない
 *   ② 最新のノートがリストの下に来る
 *   ③ 他方の端末で「不明ノート」に入る
 */

const ORPHAN_FOLDER = '不明ノート';

let drive: FakeDrive;
let peer: DesktopPeer;
let mobile: MobileDevice;

function peerNote(id: string, content: string, overrides: Partial<PeerNote> = {}): PeerNote {
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

/** ピアで A, B を作り（表示順 [B, A]）、モバイルが接続して同期済みの状態にする。 */
async function seedShared(): Promise<void> {
	peer.saveNote(peerNote('A', 'a1'));
	peer.saveNote(peerNote('B', 'b1'));
	await mobile.connect();
	await mobile.sync();
	expect(mobile.topLevelNoteIds()).toEqual(['B', 'A']);
}

function cloudNoteIds(): string[] {
	return peer.readList().notes.map((n) => n.id);
}

function cloudTopLevelNoteIds(): string[] {
	return (peer.readList().topLevelOrder ?? [])
		.filter((i) => i.type === 'note')
		.map((i) => i.id);
}

beforeEach(async () => {
	drive = new FakeDrive();
	vi.stubGlobal('fetch', drive.fetch);
	peer = new DesktopPeer(drive);
	peer.ensureLayout();
	mobile = new MobileDevice(drive);
	await mobile.boot();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('① 変更の取りこぼし / 上書き', () => {
	it('モバイルでノートを編集しても、ピアが追加したノートはクラウドの noteList から消えない', async () => {
		await seedShared();
		peer.saveNote(peerNote('P', 'from desktop'));

		await mobile.editNote('A', { content: 'edited on mobile' });

		expect(cloudNoteIds()).toContain('P');
		await mobile.sync();
		expect((await mobile.readNote('P'))?.content).toBe('from desktop');
	});

	it('ノートを開いて閉じただけで、ピアの編集をクラウド上で巻き戻さない', async () => {
		await seedShared();
		const b2 = peerNote('B', 'b2 edited on desktop');
		peer.saveNote(b2);

		await mobile.openAndClose('A');

		const cloudB = peer.readList().notes.find((n) => n.id === 'B');
		expect(cloudB?.contentHash).toBe(goContentHash(b2));
	});

	it('モバイルの保存と入れ違いになったピアの編集も、次の同期でモバイルに届く', async () => {
		await seedShared();
		peer.saveNote(peerNote('B', 'b2 edited on desktop'));

		await mobile.editNote('A', { content: 'edited on mobile' });
		await mobile.sync();

		expect((await mobile.readNote('B'))?.content).toBe('b2 edited on desktop');
	});

	it('モバイルの編集はクラウドの本体と noteList の両方に反映される', async () => {
		await seedShared();

		await mobile.editNote('A', { content: 'edited on mobile' });

		expect(peer.readCloudNote('A')?.content).toBe('edited on mobile');
		const meta = peer.readList().notes.find((n) => n.id === 'A');
		const cloudA = peer.readCloudNote('A');
		expect(meta?.contentHash).toBe(goContentHash(cloudA as PeerNote));
	});

	it('ピアでの削除がモバイルに反映される', async () => {
		await seedShared();
		peer.deleteNote('B');

		await mobile.sync();

		expect(mobile.list().notes.map((n) => n.id)).toEqual(['A']);
		expect(await mobile.readNote('B')).toBeNull();
	});
});

describe('② 表示順', () => {
	it('ピアで作られた新規ノートは、モバイルに未送信の変更があっても先頭に並ぶ', async () => {
		await seedShared();
		await mobile.editNoteOffline('A', { content: 'offline edit' });
		peer.saveNote(peerNote('P', 'new on desktop'));

		await mobile.sync();

		expect(mobile.topLevelNoteIds()).toEqual(['P', 'B', 'A']);
		expect(cloudTopLevelNoteIds()).toEqual(['P', 'B', 'A']);
	});

	it('モバイルで作った新規ノートはクラウドでも先頭に並ぶ', async () => {
		await seedShared();

		await mobile.createNote({ id: 'M', title: 'mobile', content: 'm1' });
		await mobile.sync();

		expect(cloudTopLevelNoteIds()).toEqual(['M', 'B', 'A']);
		expect(peer.readCloudNote('M')?.content).toBe('m1');
	});

	it('フォルダ内のノートは、ピアの編集を取り込んでもフォルダから外れない', async () => {
		peer.createFolder('work', 'Work');
		peer.saveNote(peerNote('W1', 'w1'), { folderId: 'work' });
		peer.saveNote(peerNote('A', 'a1'));
		await mobile.connect();
		await mobile.sync();
		expect(mobile.folderOf('W1')).toBe('work');

		await mobile.editNoteOffline('A', { content: 'offline edit' });
		peer.saveNote(peerNote('W1', 'w2 edited on desktop'));
		await mobile.sync();

		expect(mobile.folderOf('W1')).toBe('work');
		expect(peer.readList().notes.find((n) => n.id === 'W1')?.folderId).toBe('work');
		expect(mobile.topLevelNoteIds()).not.toContain('W1');
	});

	it('同時編集でピアが勝っても、フォルダ所属は維持される', async () => {
		peer.createFolder('work', 'Work');
		peer.saveNote(peerNote('W1', 'w1'), { folderId: 'work' });
		await mobile.connect();
		await mobile.sync();

		await mobile.editNoteOffline('W1', { content: 'older edit on mobile' });
		peer.saveNote(peerNote('W1', 'newer edit on desktop'));
		await mobile.sync();

		expect((await mobile.readNote('W1'))?.content).toBe('newer edit on desktop');
		expect(mobile.folderOf('W1')).toBe('work');
		expect(peer.readList().notes.find((n) => n.id === 'W1')?.folderId).toBe('work');
	});
});

describe('③ 不明ノート', () => {
	it('アップロード途中（本体のみ）のノートを見ても、不明ノートに入れない', async () => {
		await seedShared();
		// ピアが本体だけ上げた瞬間にモバイルが再接続（アプリ再起動）
		peer.uploadNoteFile(peerNote('P', 'in flight'));
		await mobile.connect();
		// ピアが noteList を上げ終える。モバイルには未送信の編集がある。
		peer.publishNoteMeta(peerNote('P', 'in flight'));
		await mobile.editNoteOffline('A', { content: 'offline edit' });

		await mobile.sync();

		expect(mobile.folderNamed(ORPHAN_FOLDER)).toBeUndefined();
		expect(mobile.folderOf('P')).toBe('');
		expect((peer.readList().folders ?? []).map((f) => f.name)).not.toContain(ORPHAN_FOLDER);
		expect(peer.readList().notes.find((n) => n.id === 'P')?.folderId ?? '').toBe('');
	});

	it('同期（pull）中に作成したノートが同期後もリストに残る', async () => {
		await seedShared();
		peer.saveNote(peerNote('B', 'b2 edited on desktop'));
		const created = {
			id: 'N',
			title: 'created during sync',
			content: 'n1',
			contentHeader: '',
			language: 'markdown',
			modifiedTime: drive.now(),
			archived: false,
			folderId: '',
		};
		// pull が B をダウンロードする直前に、UI が新規ノートをローカル保存する
		drive.beforeRequest(
			(r) => r.deviceId === 'mobile' && r.op === 'files.download' && r.fileName === 'B.json',
			async () => {
				await mobile.notes.saveNote(created, { prependToOrder: true });
			},
		);

		await mobile.sync();
		// UI 側の markNoteDirty は保存の直後（同期と入れ違い）に走る
		await mobile.state.markNoteDirty('N');

		expect(mobile.list().notes.map((n) => n.id)).toContain('N');
		expect(mobile.topLevelNoteIds()[0]).toBe('N');
	});
});
