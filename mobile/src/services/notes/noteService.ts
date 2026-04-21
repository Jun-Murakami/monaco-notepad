import * as FileSystem from 'expo-file-system';
import { deleteIfExists, ensureDir, readString, writeAtomic } from '../storage/atomicFile';
import { NOTES_DIR, NOTE_LIST_PATH, noteFilePath } from '../storage/paths';
import { computeContentHash } from '../sync/hash';
import {
	EMPTY_NOTE_LIST,
	type Folder,
	type Note,
	type NoteList,
	type NoteMetadata,
	ORPHAN_FOLDER_NAME,
} from '../sync/types';
import { uuidv4 } from '@/utils/uuid';

function cloneDeep<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * ローカルノートの CRUD とメタデータ管理。
 *
 * デスクトップ版 note_service.go を移植。
 * - 個別ノートは notes/{id}.json（full Note）
 * - noteList.json はメタデータのみ（content なし）
 */
export class NoteService {
	private list: NoteList = cloneDeep(EMPTY_NOTE_LIST);
	private loaded = false;

	async load(): Promise<void> {
		if (this.loaded) return;
		await ensureDir(NOTES_DIR);
		const raw = await readString(NOTE_LIST_PATH);
		if (raw) {
			try {
				const parsed = JSON.parse(raw) as NoteList;
				if (parsed.version === 'v2') {
					this.list = {
						...EMPTY_NOTE_LIST,
						...parsed,
					};
				}
			} catch (e) {
				console.warn('[NoteService] failed to parse noteList.json, resetting', e);
			}
		}
		this.loaded = true;
	}

	getNoteList(): NoteList {
		return cloneDeep(this.list);
	}

	replaceNoteList(list: NoteList): Promise<void> {
		this.list = cloneDeep(list);
		return this.persistList();
	}

	async readNote(noteId: string): Promise<Note | null> {
		const raw = await readString(noteFilePath(noteId));
		if (!raw) return null;
		try {
			return JSON.parse(raw) as Note;
		} catch {
			return null;
		}
	}

	async saveNote(note: Note): Promise<void> {
		await ensureDir(NOTES_DIR);
		const { syncing: _s, ...persist } = note;
		await writeAtomic(noteFilePath(note.id), JSON.stringify(persist));
		await this.upsertMetadata(note);
	}

	/** クラウドから降ってきたノートをローカルへ上書き保存（dirty にはしない）。 */
	async saveNoteFromSync(note: Note): Promise<void> {
		await this.saveNote(note);
	}

	async deleteNote(noteId: string): Promise<void> {
		await deleteIfExists(noteFilePath(noteId));
		this.list.notes = this.list.notes.filter((n) => n.id !== noteId);
		this.list.topLevelOrder = this.list.topLevelOrder.filter(
			(i) => !(i.type === 'note' && i.id === noteId),
		);
		this.list.archivedTopLevelOrder = this.list.archivedTopLevelOrder.filter(
			(i) => !(i.type === 'note' && i.id === noteId),
		);
		await this.persistList();
	}

	async createFolder(name: string, archived = false): Promise<Folder> {
		const id = uuidv4();
		const folder: Folder = { id, name, archived };
		this.list.folders.push(folder);
		const order = archived ? this.list.archivedTopLevelOrder : this.list.topLevelOrder;
		order.push({ type: 'folder', id });
		await this.persistList();
		return folder;
	}

	async deleteFolder(folderId: string): Promise<void> {
		this.list.folders = this.list.folders.filter((f) => f.id !== folderId);
		// フォルダ内のノートはトップレベルへ繰り上げる（同期で整合させる）
		for (const n of this.list.notes) {
			if (n.folderId === folderId) n.folderId = '';
		}
		this.list.topLevelOrder = this.list.topLevelOrder.filter(
			(i) => !(i.type === 'folder' && i.id === folderId),
		);
		this.list.archivedTopLevelOrder = this.list.archivedTopLevelOrder.filter(
			(i) => !(i.type === 'folder' && i.id === folderId),
		);
		await this.persistList();
	}

	/** 孤立ノートを「不明ノート」フォルダへ復元する。 */
	async recoverOrphanNote(note: Note): Promise<void> {
		await this.saveNote(note);
		const folderId = await this.ensureFolder(ORPHAN_FOLDER_NAME);
		const existing = this.list.notes.find((n) => n.id === note.id);
		const metadata = await this.buildMetadata(note, folderId);
		if (existing) {
			Object.assign(existing, metadata);
		} else {
			this.list.notes.push(metadata);
			this.list.topLevelOrder.push({ type: 'note', id: note.id });
		}
		await this.persistList();
	}

	async ensureFolder(name: string): Promise<string> {
		const existing = this.list.folders.find((f) => f.name === name && !f.archived);
		if (existing) return existing.id;
		const folder = await this.createFolder(name, false);
		return folder.id;
	}

	/** notes/ ディレクトリを走査し、noteList に無いファイルを孤立として返す。 */
	async scanOrphans(): Promise<Note[]> {
		const list = new Set(this.list.notes.map((n) => n.id));
		const orphans: Note[] = [];
		const info = await FileSystem.getInfoAsync(NOTES_DIR);
		if (!info.exists) return orphans;
		const entries = await FileSystem.readDirectoryAsync(NOTES_DIR);
		for (const entry of entries) {
			if (!entry.endsWith('.json')) continue;
			const id = entry.slice(0, -5);
			if (list.has(id)) continue;
			const note = await this.readNote(id);
			if (note) orphans.push(note);
		}
		return orphans;
	}

	private async upsertMetadata(note: Note): Promise<void> {
		const metadata = await this.buildMetadata(note, note.folderId);
		const index = this.list.notes.findIndex((n) => n.id === note.id);
		if (index >= 0) {
			this.list.notes[index] = metadata;
		} else {
			this.list.notes.push(metadata);
			const order = note.archived ? this.list.archivedTopLevelOrder : this.list.topLevelOrder;
			if (!order.some((i) => i.type === 'note' && i.id === note.id)) {
				order.push({ type: 'note', id: note.id });
			}
		}
		await this.persistList();
	}

	private async buildMetadata(note: Note, folderId: string): Promise<NoteMetadata> {
		return {
			id: note.id,
			title: note.title,
			contentHeader: note.contentHeader,
			language: note.language,
			modifiedTime: note.modifiedTime,
			archived: note.archived,
			folderId,
			contentHash: await computeContentHash(note),
		};
	}

	private async persistList(): Promise<void> {
		await writeAtomic(NOTE_LIST_PATH, JSON.stringify(this.list, null, 2));
	}
}

export const noteService = new NoteService();
