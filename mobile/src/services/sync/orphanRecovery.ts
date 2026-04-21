import type { NoteService } from '../notes/noteService';
import type { DriveSyncService } from './driveSyncService';
import { syncEvents } from './events';
import { computeConflictCopyDedupHash, isConflictCopyTitle } from './hash';
import type { Note } from './types';

/**
 * 起動時・初回同期時に走る孤立ファイル復元。
 *
 * - ローカル側: notes/ にあるが noteList に無いファイルを「不明ノート」フォルダへ登録。
 * - クラウド側: Drive notes/ にあるが noteList に無いファイルをダウンロード＆登録。
 *   Conflict Copy (タイトル) は (content, language) ハッシュで重複判定してクラウドから削除。
 *
 * デスクトップ版 drive_service.go:1880-1893 の挙動を移植。
 */

export async function recoverLocalOrphans(
	noteService: NoteService,
): Promise<number> {
	const orphans = await noteService.scanOrphans();
	for (const note of orphans) {
		await noteService.recoverOrphanNote(note);
	}
	if (orphans.length > 0) {
		syncEvents.emit('integrity:issues', { count: orphans.length });
		syncEvents.emit('notes:reload', undefined);
	}
	return orphans.length;
}

export async function recoverCloudOrphans(
	driveSync: DriveSyncService,
	noteService: NoteService,
): Promise<number> {
	// ❗ cloud orphan の定義は「Drive notes/ にファイルがあるのに **cloud の noteList** に登録が無い」。
	// ローカル noteList で判定すると、新規インストール / 長期オフライン等でローカルが空 or 古い時に
	// 正常な cloud ノートを全部 orphan と誤判定し、不明ノートへ移動してしまう（pullCloudChanges
	// で list は正常化されるが note file のディスク上 folderId は戻らず、編集→保存で伝搬する事故になる）。
	const cloudList = await driveSync.downloadNoteList();
	const files = await driveSync.listNoteFiles();
	const registered = new Set(cloudList.notes.map((n) => n.id));

	// 既存ノート（ローカル側）のハッシュ集合（Conflict Copy 重複判定用）
	const localList = noteService.getNoteList();
	const existingDedupHashes = new Set<string>();
	for (const meta of localList.notes) {
		const local = await noteService.readNote(meta.id);
		if (local) {
			existingDedupHashes.add(await computeConflictCopyDedupHash(local));
		}
	}

	// 同じ noteId のファイルが複数あれば、最新の ModifiedTime 以外を削除
	const byId = new Map<string, typeof files>();
	for (const f of files) {
		if (!f.name.endsWith('.json')) continue;
		const id = f.name.slice(0, -5);
		const arr = byId.get(id) ?? [];
		arr.push(f);
		byId.set(id, arr);
	}

	let recovered = 0;
	for (const [id, group] of byId) {
		if (registered.has(id)) continue;
		// 最新のみ残す
		group.sort((a, b) =>
			(b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''),
		);
		const latest = group[0];
		for (let i = 1; i < group.length; i++) {
			await driveSync.deleteNoteByFileId(group[i].id).catch(() => {});
		}

		const note = await driveSync.downloadNoteByFileId(latest.id);
		if (!note) continue;

		// Conflict Copy 重複判定
		if (isConflictCopyTitle(note.title)) {
			const hash = await computeConflictCopyDedupHash(note);
			if (existingDedupHashes.has(hash)) {
				await driveSync.deleteNoteByFileId(latest.id).catch(() => {});
				continue;
			}
			existingDedupHashes.add(hash);
		}

		await noteService.recoverOrphanNote(note);
		recovered++;
	}

	if (recovered > 0) {
		syncEvents.emit('integrity:issues', { count: recovered });
		syncEvents.emit('notes:reload', undefined);
	}
	return recovered;
}

export type CloudOrphan = Note;
