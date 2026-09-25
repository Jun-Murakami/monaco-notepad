import {
	normalizeNoteList,
	parseNote,
	serializeNote,
	serializeNoteList,
} from './codec';
import type { DriveClient, DriveFile } from './driveClient';
import {
	RETRY_DEFAULTS,
	RETRY_DOWNLOAD,
	RETRY_LIST,
	RETRY_UPLOAD,
	type RetryOptions,
	withRetry,
} from './retry';
import {
	DRIVE_NOTE_LIST_FILENAME,
	DRIVE_NOTES_FOLDER,
	DRIVE_ROOT_FOLDER,
	type Note,
	type NoteList,
} from './types';

/**
 * 同期エンジン v3 が使う Drive 操作（appDataFolder 専用）。
 * 状態を持たない薄い層で、fileId のキャッシュもしない（毎サイクルの一覧が正）。
 *
 * appDataFolder/monaco-notepad/{noteList_v2.json, notes/<id>.json}
 * 同名のフォルダ・ファイルが複数ある場合は createdTime 最古（同値は id 昇順）を使う。
 */

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveLayoutIds {
	rootFolderId: string;
	notesFolderId: string;
}

export interface RemoteFileRef {
	fileId: string;
	md5: string;
	modifiedTime: string;
}

export interface RemoteNoteFiles {
	byNoteId: Map<string, RemoteFileRef>;
	/** 同じノートの重複ファイル（最新以外）。後片付けで削除する。 */
	duplicateFileIds: string[];
}

export interface RetryPolicy {
	list: RetryOptions;
	download: RetryOptions;
	upload: RetryOptions;
	other: RetryOptions;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	list: RETRY_LIST,
	download: RETRY_DOWNLOAD,
	upload: RETRY_UPLOAD,
	other: RETRY_DEFAULTS,
};

export class DriveGateway {
	private layout: DriveLayoutIds | null = null;

	constructor(
		private readonly client: DriveClient,
		private readonly retry: RetryPolicy = DEFAULT_RETRY_POLICY,
	) {}

	/** root / notes フォルダを解決する（無ければ作る）。noteList は作らない（最初の同期で作る）。 */
	async resolveLayout(): Promise<DriveLayoutIds> {
		if (this.layout) return this.layout;
		const rootFolderId =
			(await this.findOldest(
				`name='${DRIVE_ROOT_FOLDER}' and 'appDataFolder' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
			)) ??
			(
				await withRetry(
					() => this.client.createFolder(DRIVE_ROOT_FOLDER, null),
					'createRootFolder',
					this.retry.other,
				)
			).id;
		const notesFolderId =
			(await this.findOldest(
				`name='${DRIVE_NOTES_FOLDER}' and '${rootFolderId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
			)) ??
			(
				await withRetry(
					() => this.client.createFolder(DRIVE_NOTES_FOLDER, [rootFolderId]),
					'createNotesFolder',
					this.retry.other,
				)
			).id;
		this.layout = { rootFolderId, notesFolderId };
		return this.layout;
	}

	/** Drive 側のフォルダ構成が変わった可能性があるとき（全削除後など）に呼ぶ。 */
	invalidateLayout(): void {
		this.layout = null;
	}

	async findNoteList(layout: DriveLayoutIds): Promise<RemoteFileRef | null> {
		const files = await this.list(
			`name='${DRIVE_NOTE_LIST_FILENAME}' and '${layout.rootFolderId}' in parents and trashed=false`,
		);
		const oldest = sortOldestFirst(files)[0];
		return oldest ? toRef(oldest) : null;
	}

	async downloadNoteList(fileId: string): Promise<NoteList> {
		const text = await withRetry(
			() => this.client.downloadText(fileId),
			'downloadNoteList',
			this.retry.download,
		);
		return normalizeNoteList(JSON.parse(text));
	}

	async uploadNoteList(
		layout: DriveLayoutIds,
		fileId: string | null,
		list: NoteList,
	): Promise<RemoteFileRef> {
		const body = serializeNoteList(list);
		const file = await withRetry(
			() =>
				fileId
					? this.client.updateFile(fileId, body)
					: this.client.createFile(
							DRIVE_NOTE_LIST_FILENAME,
							[layout.rootFolderId],
							body,
						),
			'uploadNoteList',
			this.retry.upload,
		);
		return toRef(file);
	}

	/** notes フォルダの本体ファイルを全件列挙する（全ページ）。 */
	async listNoteFiles(layout: DriveLayoutIds): Promise<RemoteNoteFiles> {
		const files = await this.list(
			`'${layout.notesFolderId}' in parents and trashed=false`,
			1000,
		);
		const groups = new Map<string, DriveFile[]>();
		for (const f of files) {
			if (!f.name.endsWith('.json')) continue;
			const noteId = f.name.slice(0, -5);
			const group = groups.get(noteId) ?? [];
			group.push(f);
			groups.set(noteId, group);
		}
		const byNoteId = new Map<string, RemoteFileRef>();
		const duplicateFileIds: string[] = [];
		for (const [noteId, group] of groups) {
			// 最新（modifiedTime 降順、同値は id 降順）を採用
			group.sort((a, b) => {
				const ma = a.modifiedTime ?? '';
				const mb = b.modifiedTime ?? '';
				if (ma !== mb) return ma < mb ? 1 : -1;
				return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
			});
			byNoteId.set(noteId, toRef(group[0]));
			for (const dup of group.slice(1)) duplicateFileIds.push(dup.id);
		}
		return { byNoteId, duplicateFileIds };
	}

	/** 本体をダウンロードする。中身の ID が要求と違う・壊れている場合は null。 */
	async downloadNote(
		fileId: string,
		expectedNoteId: string,
	): Promise<Note | null> {
		const text = await withRetry(
			() => this.client.downloadText(fileId),
			'downloadNote',
			this.retry.download,
		);
		const note = parseNote(text);
		if (!note || note.id !== expectedNoteId) return null;
		return note;
	}

	async uploadNote(
		layout: DriveLayoutIds,
		note: Note,
		fileId: string | null,
	): Promise<RemoteFileRef> {
		const body = serializeNote(note);
		const file = await withRetry(
			() =>
				fileId
					? this.client.updateFile(fileId, body)
					: this.client.createFile(
							`${note.id}.json`,
							[layout.notesFolderId],
							body,
						),
			'uploadNote',
			this.retry.upload,
		);
		return toRef(file);
	}

	/** ファイルを削除する。既に無ければ成功扱い。 */
	async deleteFile(fileId: string): Promise<void> {
		try {
			await withRetry(
				() => this.client.deleteFile(fileId),
				'deleteFile',
				this.retry.other,
			);
		} catch (e) {
			if ((e as { status?: number }).status === 404) return;
			throw e;
		}
	}

	private async list(query: string, pageSize = 200): Promise<DriveFile[]> {
		return withRetry(
			() => this.client.listFiles(query, pageSize),
			'listFiles',
			this.retry.list,
		);
	}

	private async findOldest(query: string): Promise<string | null> {
		return sortOldestFirst(await this.list(query))[0]?.id ?? null;
	}
}

function sortOldestFirst(files: DriveFile[]): DriveFile[] {
	return [...files].sort((a, b) => {
		const ca = a.createdTime ?? '';
		const cb = b.createdTime ?? '';
		if (ca !== cb) return ca < cb ? -1 : 1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}

function toRef(file: DriveFile): RemoteFileRef {
	return {
		fileId: file.id,
		md5: file.md5Checksum ?? '',
		modifiedTime: file.modifiedTime ?? '',
	};
}
