import { writeAsStringAsync } from 'expo-file-system';
import { beforeEach, describe, expect, it } from 'vitest';
import { NoteService } from '@/services/notes/noteService';
import { NOTES_DIR, noteFilePath } from '@/services/storage/paths';
import { ensureDir } from '@/services/storage/atomicFile';
import { FakeCloud } from '@/test/fakeCloud';
import { iso, makeNote } from '@/test/helpers';
import type { DriveSyncService } from '../driveSyncService';
import { recoverCloudOrphans, recoverLocalOrphans } from '../orphanRecovery';

let cloud: FakeCloud;
let notes: NoteService;

beforeEach(async () => {
	cloud = new FakeCloud();
	notes = new NoteService();
	await notes.load();
});

describe('recoverLocalOrphans', () => {
	it('notes/ 内で noteList に無いファイルを「不明ノート」フォルダへ登録', async () => {
		await ensureDir(NOTES_DIR);
		await writeAsStringAsync(
			noteFilePath('orphan-1'),
			JSON.stringify(makeNote({ id: 'orphan-1', content: 'lost' })),
		);
		const count = await recoverLocalOrphans(notes);
		expect(count).toBe(1);
		const folder = notes.getNoteList().folders.find((f) => f.name === '不明ノート');
		expect(folder).toBeDefined();
		expect(notes.getNoteList().notes[0]).toMatchObject({
			id: 'orphan-1',
			folderId: folder!.id,
		});
	});

	it('孤立ゼロなら 0 を返し何もしない', async () => {
		const count = await recoverLocalOrphans(notes);
		expect(count).toBe(0);
		expect(notes.getNoteList().notes).toHaveLength(0);
	});
});

describe('recoverCloudOrphans', () => {
	it('noteList に無いクラウドノートを DL して「不明ノート」へ登録', async () => {
		const orphan = makeNote({ id: 'cloud-orphan', title: 'Lost Cloud Note' });
		cloud.setCloudNote(orphan);
		// noteList には入れない（= 孤立状態）

		const count = await recoverCloudOrphans(
			cloud as unknown as DriveSyncService,
			notes,
		);
		expect(count).toBe(1);
		const list = notes.getNoteList();
		const folder = list.folders.find((f) => f.name === '不明ノート');
		expect(folder).toBeDefined();
		expect(list.notes[0]).toMatchObject({
			id: 'cloud-orphan',
			folderId: folder!.id,
		});
	});

	it('Conflict Copy タイトルは既存ノートと内容が同じならクラウドから削除', async () => {
		// 既存ノートを local + cloud に入れる（registered 状態）
		const existing = makeNote({ id: 'existing', content: 'payload', language: 'markdown' });
		await notes.saveNote(existing);

		// 孤立として Conflict Copy (同じ content+language) をクラウドに置く
		const copy = makeNote({
			id: 'conflict-copy-1',
			title: 'Conflict Copy of existing',
			content: 'payload',
			language: 'markdown',
		});
		cloud.setCloudNote(copy);

		const count = await recoverCloudOrphans(
			cloud as unknown as DriveSyncService,
			notes,
		);
		// 重複と判定され復元されず、クラウドからも削除される
		expect(count).toBe(0);
		expect(cloud.notes.has('conflict-copy-1')).toBe(false);
	});

	it('Conflict Copy でも内容が違えば復元する', async () => {
		const existing = makeNote({ id: 'existing', content: 'payload', language: 'markdown' });
		await notes.saveNote(existing);
		const copy = makeNote({
			id: 'conflict-copy-1',
			title: 'Conflict Copy of existing',
			content: 'different',
			language: 'markdown',
		});
		cloud.setCloudNote(copy);

		const count = await recoverCloudOrphans(
			cloud as unknown as DriveSyncService,
			notes,
		);
		expect(count).toBe(1);
		expect(cloud.notes.has('conflict-copy-1')).toBe(true);
	});

	it('同じ noteId で複数ファイルがあれば最新以外はクラウドから削除', async () => {
		// 単一 cloud の同じ noteId を複数ファイル ID で用意するのは FakeCloud では簡単にできないので
		// シミュレート用に listNoteFiles をオーバーライドする。
		const latestNote = makeNote({ id: 'dup', content: 'latest' });
		cloud.setCloudNote(latestNote);

		const origList = cloud.listNoteFiles.bind(cloud);
		cloud.listNoteFiles = async () => {
			const base = await origList();
			// 同じ名前の「古いファイル」を差し込む
			return [
				...base,
				{
					id: 'fid-old',
					name: 'dup.json',
					modifiedTime: '2025-01-01T00:00:00.000Z',
				},
			];
		};
		// downloadNoteByFileId は fid-old も返せるように
		const origDl = cloud.downloadNoteByFileId.bind(cloud);
		cloud.downloadNoteByFileId = async (fid) => {
			if (fid === 'fid-old')
				return makeNote({ id: 'dup', content: 'old', modifiedTime: '2025-01-01T00:00:00.000Z' });
			return origDl(fid);
		};
		// deleteNoteByFileId の呼び出しを観測できるよう calls を拡張
		const deleted: string[] = [];
		const origDel = cloud.deleteNoteByFileId.bind(cloud);
		cloud.deleteNoteByFileId = async (fid) => {
			deleted.push(fid);
			return origDel(fid);
		};

		await recoverCloudOrphans(cloud as unknown as DriveSyncService, notes);
		expect(deleted).toContain('fid-old');
	});
});
