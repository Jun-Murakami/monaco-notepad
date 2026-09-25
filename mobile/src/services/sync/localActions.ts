import type { NoteService } from '../notes/noteService';
import type { SyncStateManager } from './syncState';
import type { Note } from './types';

/**
 * UI 操作に伴うローカル側の手順（保存 → 変更の記録）。
 * 同期の起動は呼び出し側（driveService）が行う。アプリとテストの端末ファサードが同じ手順を
 * 使うよう、ここに集約する。
 */

/** 既存ノートの保存（エディタの debounce 保存 / 画面離脱時の flush）。 */
export async function saveNoteLocally(
	notes: NoteService,
	state: SyncStateManager,
	note: Note,
): Promise<void> {
	await notes.saveNote(note);
	await state.markNoteDirty(note.id);
}

/** 新規作成（一覧の先頭に置く）。 */
export async function createNoteLocally(
	notes: NoteService,
	state: SyncStateManager,
	note: Note,
): Promise<void> {
	await notes.saveNote(note, { prependToOrder: true });
	await state.markNoteDirty(note.id);
}

export async function deleteNoteLocally(
	notes: NoteService,
	state: SyncStateManager,
	noteId: string,
): Promise<void> {
	await notes.deleteNote(noteId);
	await state.markNoteDeleted(noteId);
}

/** アーカイブ済みフォルダを配下のノートごと完全削除する。 */
export async function deleteFolderHardLocally(
	notes: NoteService,
	state: SyncStateManager,
	folderId: string,
): Promise<void> {
	const deletedNoteIds = await notes.deleteFolderHard(folderId);
	await state.markFolderDeleted(folderId);
	for (const noteId of deletedNoteIds) {
		await state.markNoteDeleted(noteId);
	}
}

/** アーカイブ済みフォルダを配下のノートごと復元する。 */
export async function restoreFolderLocally(
	notes: NoteService,
	state: SyncStateManager,
	folderId: string,
): Promise<void> {
	const restoredNoteIds = await notes.restoreFolder(folderId);
	await state.markDirty();
	for (const noteId of restoredNoteIds) {
		await state.markNoteDirty(noteId);
	}
}
