import { Directory, File } from 'expo-file-system';
import { describe, expect, it } from 'vitest';
import { ensureDir } from '@/services/storage/atomicFile';
import { NOTES_DIR, noteFilePath } from '@/services/storage/paths';
import { makeNote } from '@/test/helpers';
import { NoteService } from '../noteService';

async function fresh(): Promise<NoteService> {
	const s = new NoteService();
	await s.load();
	return s;
}

describe('NoteService', () => {
	it('saveNote で notes/{id}.json と noteList が更新される', async () => {
		const s = await fresh();
		await s.saveNote(makeNote({ id: 'a', title: 'T', content: 'C' }));
		const list = s.getNoteList();
		expect(list.notes).toHaveLength(1);
		expect(list.notes[0]).toMatchObject({
			id: 'a',
			title: 'T',
			language: 'plaintext',
		});
		expect(list.notes[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(list.topLevelOrder).toContainEqual({ type: 'note', id: 'a' });
	});

	it('saveNote を同じ id で再度呼ぶとメタデータが更新される（重複しない）', async () => {
		const s = await fresh();
		await s.saveNote(makeNote({ id: 'a', title: 'v1' }));
		await s.saveNote(makeNote({ id: 'a', title: 'v2' }));
		expect(s.getNoteList().notes).toHaveLength(1);
		expect(s.getNoteList().notes[0].title).toBe('v2');
		expect(
			s
				.getNoteList()
				.topLevelOrder.filter((i) => i.type === 'note' && i.id === 'a').length,
		).toBe(1);
	});

	it('readNote で保存済みノートを復元する', async () => {
		const s = await fresh();
		const note = makeNote({ id: 'a', content: 'hello' });
		await s.saveNote(note);
		const got = await s.readNote('a');
		expect(got?.content).toBe('hello');
	});

	it('deleteNote で notes/{id}.json と noteList から消える', async () => {
		const s = await fresh();
		await s.saveNote(makeNote({ id: 'a' }));
		await s.deleteNote('a');
		expect(s.getNoteList().notes).toHaveLength(0);
		expect(s.getNoteList().topLevelOrder).toHaveLength(0);
		expect(await s.readNote('a')).toBeNull();
	});

	it('createFolder でフォルダが増え topLevelOrder の先頭に追加される', async () => {
		const s = await fresh();
		const first = await s.createFolder('Work');
		const second = await s.createFolder('Personal');
		expect(s.getNoteList().folders).toHaveLength(2);
		expect(s.getNoteList().topLevelOrder[0]).toEqual({
			type: 'folder',
			id: second.id,
		});
		expect(s.getNoteList().topLevelOrder[1]).toEqual({
			type: 'folder',
			id: first.id,
		});
	});

	it('deleteFolder で配下ノートは FolderId="" へ繰り上げられる', async () => {
		const s = await fresh();
		const folder = await s.createFolder('Work');
		await s.saveNote(makeNote({ id: 'a', folderId: folder.id }));
		await s.deleteFolder(folder.id);
		expect(s.getNoteList().folders).toHaveLength(0);
		expect(s.getNoteList().notes[0].folderId).toBe('');
	});

	it('ensureFolder は同名フォルダがあれば再作成しない', async () => {
		const s = await fresh();
		const id1 = await s.ensureFolder('Unknown');
		const id2 = await s.ensureFolder('Unknown');
		expect(id1).toBe(id2);
		expect(s.getNoteList().folders).toHaveLength(1);
	});

	it('scanOrphans は notes/ 内で noteList に無いファイルを拾う', async () => {
		const s = await fresh();
		await ensureDir(NOTES_DIR);
		// noteList に無い note ファイルを直接書く
		const f = new File(noteFilePath('orphan-1'));
		f.create({ intermediates: true, overwrite: true });
		f.write(JSON.stringify(makeNote({ id: 'orphan-1', content: 'orphan' })));
		const orphans = await s.scanOrphans();
		expect(orphans).toHaveLength(1);
		expect(orphans[0].id).toBe('orphan-1');
	});

	it('recoverOrphanNote は「不明ノート」フォルダに登録する', async () => {
		const s = await fresh();
		const orphan = makeNote({ id: 'orphan-1', content: 'orphan' });
		await s.recoverOrphanNote(orphan);
		const list = s.getNoteList();
		const folder = list.folders.find((f) => f.name === '不明ノート');
		expect(folder).toBeDefined();
		expect(list.notes[0]).toMatchObject({
			id: 'orphan-1',
			folderId: folder!.id,
		});
	});

	it('replaceNoteList でクラウド同期結果を丸ごと取り込める', async () => {
		const s = await fresh();
		await s.saveNote(makeNote({ id: 'a' }));
		await s.replaceNoteList({
			version: 'v2',
			notes: [],
			folders: [],
			topLevelOrder: [],
			archivedTopLevelOrder: [],
			collapsedFolderIds: [],
		});
		expect(s.getNoteList().notes).toHaveLength(0);
	});

	it('replaceNoteListInMemory は永続化せずメモリだけ差し替える', async () => {
		const s = await fresh();
		await s.saveNote(makeNote({ id: 'a', title: 'persisted' }));
		s.replaceNoteListInMemory({
			version: 'v2',
			notes: [],
			folders: [],
			topLevelOrder: [],
			archivedTopLevelOrder: [],
			collapsedFolderIds: [],
		});
		expect(s.getNoteList().notes).toHaveLength(0);

		const reloaded = new NoteService();
		await reloaded.load();
		expect(reloaded.getNoteList().notes[0]?.id).toBe('a');
	});

	it('replaceNoteList({ preserveExtras: true }) は incoming に無い既存ノート/フォルダを保持する', async () => {
		// 同期 pull が並行で upsertMetadata した直後に、UI の楽観更新が古い baseline で
		// replaceNoteList を呼ぶ race。preserveExtras なしで上書きするとファイルが孤立する。
		const s = await fresh();
		// 既存 (= 「pull 中にダウンロード済み」相当)
		await s.saveNote(makeNote({ id: 'pulled-1', folderId: '' }));
		await s.saveNote(makeNote({ id: 'pulled-2', folderId: 'folder-x' }));
		const folder = await s.createFolder('Cloud Folder');
		const cloudFolderId = folder.id;
		// 「ユーザーが古い baseline で計算した」ように見える list (extras を全部欠いている)
		const stale: Parameters<typeof s.replaceNoteList>[0] = {
			version: 'v2',
			notes: [],
			folders: [],
			topLevelOrder: [{ type: 'folder', id: 'moved-folder' }],
			archivedTopLevelOrder: [],
			collapsedFolderIds: [],
		};
		await s.replaceNoteList(stale, { preserveExtras: true });
		const list = s.getNoteList();
		// 既存ノートはどちらも保持される
		expect(list.notes.map((n) => n.id).sort()).toEqual([
			'pulled-1',
			'pulled-2',
		]);
		// 既存フォルダも保持
		expect(list.folders.find((f) => f.id === cloudFolderId)).toBeDefined();
		// topLevelOrder: stale が指定した moved-folder + 既存 (extras) が末尾追加される
		const orderKeys = list.topLevelOrder.map((i) => `${i.type}:${i.id}`);
		expect(orderKeys).toContain('folder:moved-folder');
		expect(orderKeys).toContain(`folder:${cloudFolderId}`);
		// folderId 付きノートは topLevelOrder に乗らない (data model 整合)
		expect(orderKeys).not.toContain('note:pulled-2');
		// folderId なしノートは末尾追加
		expect(orderKeys).toContain('note:pulled-1');
	});

	it('replaceNoteList ({ preserveExtras: true }) でも incoming にある同一 ID は incoming 側で上書きされる', async () => {
		const s = await fresh();
		await s.saveNote(makeNote({ id: 'a', title: 'old' }));
		await s.replaceNoteList(
			{
				version: 'v2',
				notes: [
					{
						id: 'a',
						title: 'new',
						contentHeader: '',
						language: 'plaintext',
						modifiedTime: '2026-01-02T00:00:00.000Z',
						archived: false,
						folderId: '',
						contentHash: 'h',
					},
				],
				folders: [],
				topLevelOrder: [{ type: 'note', id: 'a' }],
				archivedTopLevelOrder: [],
				collapsedFolderIds: [],
			},
			{ preserveExtras: true },
		);
		expect(s.getNoteList().notes).toHaveLength(1);
		expect(s.getNoteList().notes[0].title).toBe('new');
	});

	it('永続化: 別インスタンスで load しても noteList が復元される', async () => {
		const a = await fresh();
		await a.saveNote(makeNote({ id: 'a', title: 'persisted' }));
		const b = new NoteService();
		await b.load();
		expect(b.getNoteList().notes[0]?.title).toBe('persisted');
	});

	// NOTES_DIR が未作成でも scanOrphans がクラッシュしない
	it('NOTES_DIR 未作成でも scanOrphans は空配列を返す', async () => {
		const s = new NoteService();
		await s.load();
		// load の時点で ensureDir されるので明示的には触らない
		const orphans = await s.scanOrphans();
		expect(orphans).toEqual([]);
		// notes/ が存在することは保証されない前提を確認（ここでは作成されている）
		const entries = new Directory(NOTES_DIR).list().map((e) => e.name);
		expect(entries).toEqual([]);
	});
});
