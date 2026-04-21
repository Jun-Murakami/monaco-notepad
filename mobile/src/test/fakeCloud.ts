import type { DriveFile } from '@/services/sync/driveClient';
import type { DriveSyncService } from '@/services/sync/driveSyncService';
import { computeContentHash } from '@/services/sync/hash';
import type { Note, NoteList } from '@/services/sync/types';
import { makeNoteList } from './helpers';

/**
 * DriveSyncService と同じ API 形状を持つ in-memory 偽クラウド。
 * orchestrator/polling/orphanRecovery のテストで driveSync の代わりに注入する。
 */
export class FakeCloud implements Pick<
	DriveSyncService,
	| 'listNoteFiles'
	| 'resolveNoteFileId'
	| 'createNote'
	| 'updateNote'
	| 'deleteNote'
	| 'deleteNoteByFileId'
	| 'downloadNote'
	| 'downloadNoteByFileId'
	| 'downloadNoteList'
	| 'updateNoteList'
	| 'getNoteListMetadata'
	| 'clearCache'
	| 'updateLayout'
> {
	/** noteId -> Note */
	notes = new Map<string, Note>();
	/** noteId -> modifiedTime on cloud */
	noteModifiedTimes = new Map<string, string>();
	/** noteList file contents */
	noteList: NoteList = makeNoteList();
	/** noteList の ModifiedTime */
	noteListModifiedTime = '2026-01-01T00:00:00.000Z';
	/** 呼び出しカウンタ（挙動検証用）。 */
	calls = {
		create: 0,
		update: 0,
		delete: 0,
		download: 0,
		updateNoteList: 0,
		listNoteFiles: 0,
	};
	/** 失敗注入: 特定操作を一回だけ失敗させたい場合に使う。 */
	nextUpdateNoteListError: Error | null = null;

	private fileIdSeq = 1;
	private fileIds = new Map<string, string>();

	/** テスト中に「クラウド側だけ」更新したい場合に使う。noteList の ModifiedTime も進める。 */
	setCloudNote(note: Note, modifiedTime?: string): void {
		this.notes.set(note.id, { ...note });
		const mt = modifiedTime ?? note.modifiedTime;
		this.noteModifiedTimes.set(note.id, mt);
		if (!this.fileIds.has(note.id)) {
			this.fileIds.set(note.id, `fid-${this.fileIdSeq++}`);
		}
	}

	/** クラウドの noteList を人工的に設定する。ts も進める。 */
	setCloudNoteList(list: NoteList, modifiedTime: string): void {
		this.noteList = structuredClone(list);
		this.noteListModifiedTime = modifiedTime;
	}

	/** noteList の notes を、現在 cloud に入っているノートから再構築する（contentHash 付き）。 */
	async rebuildNoteListFromCloud(modifiedTime: string): Promise<void> {
		this.noteList.notes = [];
		for (const note of this.notes.values()) {
			this.noteList.notes.push({
				id: note.id,
				title: note.title,
				contentHeader: note.contentHeader,
				language: note.language,
				modifiedTime: note.modifiedTime,
				archived: note.archived,
				folderId: note.folderId,
				contentHash: await computeContentHash(note),
			});
		}
		this.noteListModifiedTime = modifiedTime;
	}

	// ---- DriveSyncService 互換 API ----

	async listNoteFiles(): Promise<DriveFile[]> {
		this.calls.listNoteFiles++;
		const out: DriveFile[] = [];
		for (const [id, note] of this.notes) {
			if (!this.fileIds.has(id)) this.fileIds.set(id, `fid-${this.fileIdSeq++}`);
			out.push({
				id: this.fileIds.get(id)!,
				name: `${id}.json`,
				modifiedTime: this.noteModifiedTimes.get(id) ?? note.modifiedTime,
			});
		}
		return out;
	}

	async resolveNoteFileId(noteId: string): Promise<string | null> {
		return this.fileIds.get(noteId) ?? null;
	}

	async createNote(note: Note): Promise<DriveFile> {
		this.calls.create++;
		const fid = `fid-${this.fileIdSeq++}`;
		this.fileIds.set(note.id, fid);
		this.notes.set(note.id, { ...note });
		const mt = new Date().toISOString();
		this.noteModifiedTimes.set(note.id, mt);
		return { id: fid, name: `${note.id}.json`, modifiedTime: mt };
	}

	async updateNote(note: Note): Promise<DriveFile> {
		this.calls.update++;
		const fid = this.fileIds.get(note.id) ?? `fid-${this.fileIdSeq++}`;
		this.fileIds.set(note.id, fid);
		this.notes.set(note.id, { ...note });
		const mt = new Date().toISOString();
		this.noteModifiedTimes.set(note.id, mt);
		return { id: fid, name: `${note.id}.json`, modifiedTime: mt };
	}

	async deleteNote(noteId: string): Promise<void> {
		this.calls.delete++;
		this.notes.delete(noteId);
		this.noteModifiedTimes.delete(noteId);
		this.fileIds.delete(noteId);
	}

	async deleteNoteByFileId(fileId: string): Promise<void> {
		for (const [noteId, fid] of this.fileIds) {
			if (fid === fileId) return this.deleteNote(noteId);
		}
	}

	async downloadNote(noteId: string): Promise<Note | null> {
		this.calls.download++;
		const n = this.notes.get(noteId);
		return n ? { ...n } : null;
	}

	async downloadNoteByFileId(fileId: string): Promise<Note | null> {
		for (const [noteId, fid] of this.fileIds) {
			if (fid === fileId) return this.downloadNote(noteId);
		}
		return null;
	}

	async downloadNoteList(): Promise<NoteList> {
		return structuredClone(this.noteList);
	}

	async updateNoteList(list: NoteList): Promise<DriveFile> {
		if (this.nextUpdateNoteListError) {
			const err = this.nextUpdateNoteListError;
			this.nextUpdateNoteListError = null;
			throw err;
		}
		this.calls.updateNoteList++;
		this.noteList = structuredClone(list);
		this.noteListModifiedTime = new Date().toISOString();
		return { id: 'note-list-file-id', name: 'noteList_v2.json', modifiedTime: this.noteListModifiedTime };
	}

	async getNoteListMetadata(): Promise<DriveFile> {
		return {
			id: 'note-list-file-id',
			name: 'noteList_v2.json',
			modifiedTime: this.noteListModifiedTime,
		};
	}

	clearCache(): void {
		// no-op
	}

	updateLayout(): void {
		// no-op
	}
}
