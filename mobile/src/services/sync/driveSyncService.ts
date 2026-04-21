import type { DriveClient, DriveFile } from './driveClient';
import type { DriveLayout } from './driveLayout';
import { RETRY_DEFAULTS, RETRY_DOWNLOAD, RETRY_LIST, RETRY_UPLOAD, withRetry } from './retry';
import type { Note, NoteList } from './types';

/**
 * Drive に対する中レベル操作（ノート単位の CRUD + noteList の操作）。
 * 低レベル DriveClient + Layout を保持し、ファイル ID の解決もここで行う。
 *
 * デスクトップ版 drive_sync_service.go に対応。
 */
export class DriveSyncService {
	/** noteId -> driveFileId のキャッシュ（listNoteFiles で構築）。 */
	private fileIdCache = new Map<string, string>();

	constructor(
		private readonly client: DriveClient,
		private readonly layout: DriveLayout,
	) {}

	updateLayout(layout: DriveLayout): void {
		Object.assign(this.layout, layout);
	}

	/** キャッシュをリセット（再接続時など）。 */
	clearCache(): void {
		this.fileIdCache.clear();
	}

	/** notes フォルダ以下の全ファイル ID を一括取得してキャッシュする。 */
	async listNoteFiles(): Promise<DriveFile[]> {
		const files = await withRetry(
			() =>
				this.client.listFiles(
					`'${this.layout.notesFolderId}' in parents and trashed=false`,
					500,
				),
			'listNoteFiles',
			RETRY_LIST,
		);
		for (const f of files) {
			const noteId = stripJsonExt(f.name);
			if (noteId) this.fileIdCache.set(noteId, f.id);
		}
		return files;
	}

	async resolveNoteFileId(noteId: string): Promise<string | null> {
		const cached = this.fileIdCache.get(noteId);
		if (cached) return cached;
		const name = `${noteId}.json`;
		const files = await withRetry(
			() =>
				this.client.listFiles(
					`name='${name}' and '${this.layout.notesFolderId}' in parents and trashed=false`,
					2,
				),
			'resolveNoteFileId',
			RETRY_LIST,
		);
		const id = files[0]?.id ?? null;
		if (id) this.fileIdCache.set(noteId, id);
		return id;
	}

	async createNote(note: Note): Promise<DriveFile> {
		const body = serializeNote(note);
		const file = await withRetry(
			() =>
				this.client.createFile(`${note.id}.json`, [this.layout.notesFolderId], body),
			'createNote',
			RETRY_UPLOAD,
		);
		this.fileIdCache.set(note.id, file.id);
		return file;
	}

	async updateNote(note: Note): Promise<DriveFile> {
		const fileId = await this.resolveNoteFileId(note.id);
		if (!fileId) {
			// 存在しなければ create にフォールバック
			return this.createNote(note);
		}
		const body = serializeNote(note);
		return withRetry(() => this.client.updateFile(fileId, body), 'updateNote', RETRY_UPLOAD);
	}

	async deleteNote(noteId: string): Promise<void> {
		const fileId = await this.resolveNoteFileId(noteId);
		if (!fileId) return;
		await withRetry(() => this.client.deleteFile(fileId), 'deleteNote', RETRY_DEFAULTS);
		this.fileIdCache.delete(noteId);
	}

	async deleteNoteByFileId(fileId: string): Promise<void> {
		await withRetry(() => this.client.deleteFile(fileId), 'deleteNoteByFileId', RETRY_DEFAULTS);
		for (const [noteId, cached] of this.fileIdCache) {
			if (cached === fileId) {
				this.fileIdCache.delete(noteId);
				break;
			}
		}
	}

	async downloadNote(noteId: string): Promise<Note | null> {
		const fileId = await this.resolveNoteFileId(noteId);
		if (!fileId) return null;
		const text = await withRetry(
			() => this.client.downloadText(fileId),
			'downloadNote',
			RETRY_DOWNLOAD,
		);
		return parseNote(text);
	}

	async downloadNoteByFileId(fileId: string): Promise<Note | null> {
		const text = await withRetry(
			() => this.client.downloadText(fileId),
			'downloadNoteByFileId',
			RETRY_DOWNLOAD,
		);
		return parseNote(text);
	}

	async downloadNoteList(): Promise<NoteList> {
		const text = await withRetry(
			() => this.client.downloadText(this.layout.noteListFileId),
			'downloadNoteList',
			RETRY_DOWNLOAD,
		);
		return JSON.parse(text) as NoteList;
	}

	async updateNoteList(list: NoteList): Promise<DriveFile> {
		const body = JSON.stringify(list);
		return withRetry(
			() => this.client.updateFile(this.layout.noteListFileId, body),
			'updateNoteList',
			RETRY_UPLOAD,
		);
	}

	async getNoteListMetadata(): Promise<DriveFile> {
		return withRetry(
			() => this.client.getFileMetadata(this.layout.noteListFileId),
			'getNoteListMetadata',
			RETRY_LIST,
		);
	}
}

function serializeNote(note: Note): string {
	// syncing は永続化しない
	const { syncing: _s, ...persist } = note;
	return JSON.stringify(persist);
}

function parseNote(text: string): Note | null {
	try {
		const parsed = JSON.parse(text) as Partial<Note>;
		if (!parsed.id || typeof parsed.id !== 'string') return null;
		return {
			id: parsed.id,
			title: parsed.title ?? '',
			content: parsed.content ?? '',
			contentHeader: parsed.contentHeader ?? '',
			language: parsed.language ?? 'plaintext',
			modifiedTime: parsed.modifiedTime ?? new Date().toISOString(),
			archived: parsed.archived ?? false,
			folderId: parsed.folderId ?? '',
		};
	} catch {
		return null;
	}
}

function stripJsonExt(name: string): string | null {
	if (!name.endsWith('.json')) return null;
	return name.slice(0, -5);
}
