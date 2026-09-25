import { createHash } from 'node:crypto';
import { type FakeDrive, type FakeFile, FOLDER_MIME } from './fakeDrive';

/**
 * 「プロトコル通りに正しく振る舞うデスクトップ版」を FakeDrive 上で模擬するピア端末。
 *
 * - ファイルはデスクトップ (Go) と同じ形式で書く:
 *   ノート本体は folderId を含まない MarshalIndent 形式、noteList は version "2.0" /
 *   `collapsedFolderIDs` キー / omitempty。
 * - noteList の更新は毎回「最新をダウンロード → 自分の変更だけ適用 → アップロード」する
 *   (理想的な read-modify-write)。本体 → noteList の順でアップロードする。
 *
 * モバイル側のバグを「相手が正しくても壊れる」形で再現するための基準実装であり、
 * デスクトップ実装そのものではない。
 */

export interface PeerNote {
	id: string;
	title: string;
	content: string;
	language: string;
	archived: boolean;
	modifiedTime: string;
}

interface GoNoteMetadata {
	id: string;
	title: string;
	contentHeader: string;
	language: string;
	modifiedTime: string;
	archived: boolean;
	contentHash: string;
	folderId?: string;
}

interface GoFolder {
	id: string;
	name: string;
	archived?: boolean;
}

interface GoTopLevelItem {
	type: 'note' | 'folder';
	id: string;
}

export interface GoNoteList {
	version: string;
	notes: GoNoteMetadata[];
	folders?: GoFolder[];
	topLevelOrder?: GoTopLevelItem[];
	archivedTopLevelOrder?: GoTopLevelItem[];
	collapsedFolderIDs?: string[];
}

export function goContentHash(n: {
	id: string;
	title: string;
	content: string;
	language: string;
	archived: boolean;
}): string {
	return createHash('sha256')
		.update(`${n.id}\n${n.title}\n${n.content}\n${n.language}\n${n.archived}`)
		.digest('hex');
}

function contentHeaderOf(content: string): string {
	const lines = content.split('\n').filter((l) => l.trim() !== '');
	const header = lines.slice(0, 3).join('\n');
	return header.length > 200 ? header.slice(0, 200) : header;
}

export class DesktopPeer {
	constructor(private readonly drive: FakeDrive) {}

	// ---- レイアウト ----

	rootFolder(): FakeFile {
		const root = this.drive
			.list(
				`name='monaco-notepad' and 'appDataFolder' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
			)
			.at(0);
		if (!root) throw new Error('DesktopPeer: root folder not found');
		return root;
	}

	notesFolder(): FakeFile {
		const root = this.rootFolder();
		const notes = this.drive
			.list(
				`name='notes' and '${root.id}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
			)
			.at(0);
		if (!notes) throw new Error('DesktopPeer: notes folder not found');
		return notes;
	}

	/** Drive 上にレイアウト（root / notes / 空 noteList）が無ければデスクトップ形式で作る。 */
	ensureLayout(): void {
		let root = this.drive
			.list(
				`name='monaco-notepad' and 'appDataFolder' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
			)
			.at(0);
		if (!root) {
			root = this.drive.createFile(
				'monaco-notepad',
				['appDataFolder'],
				'',
				FOLDER_MIME,
			);
		}
		const notes = this.drive
			.list(`name='notes' and '${root.id}' in parents and trashed=false`)
			.at(0);
		if (!notes) {
			this.drive.createFile('notes', [root.id], '', FOLDER_MIME);
		}
		if (!this.noteListFile()) {
			this.drive.createFile(
				'noteList_v2.json',
				[root.id],
				goJSON({ version: '2.0', notes: [] }),
			);
		}
	}

	noteListFile(): FakeFile | undefined {
		const root = this.rootFolder();
		return this.drive
			.list(
				`name='noteList_v2.json' and '${root.id}' in parents and trashed=false`,
			)
			.at(0);
	}

	readList(): GoNoteList {
		const f = this.noteListFile();
		if (!f) throw new Error('DesktopPeer: noteList not found');
		const raw = JSON.parse(f.content) as GoNoteList & {
			collapsedFolderIds?: string[];
		};
		return {
			version: raw.version,
			notes: raw.notes ?? [],
			folders: raw.folders ?? [],
			topLevelOrder: raw.topLevelOrder ?? [],
			archivedTopLevelOrder: raw.archivedTopLevelOrder ?? [],
			collapsedFolderIDs:
				raw.collapsedFolderIDs ?? raw.collapsedFolderIds ?? [],
		};
	}

	/** 最新 noteList を読み、mutate を適用して書き戻す（理想的な read-modify-write）。 */
	updateList(mutate: (list: GoNoteList) => void): void {
		const list = this.readList();
		mutate(list);
		const f = this.noteListFile();
		if (!f) throw new Error('DesktopPeer: noteList not found');
		this.drive.updateFile(f.id, goJSON(normalizeGoList(list)));
	}

	readCloudNote(noteId: string): PeerNote | undefined {
		const f = this.noteFile(noteId);
		return f ? (JSON.parse(f.content) as PeerNote) : undefined;
	}

	noteFile(noteId: string): FakeFile | undefined {
		return this.drive
			.list(
				`name='${noteId}.json' and '${this.notesFolder().id}' in parents and trashed=false`,
			)
			.at(0);
	}

	// ---- ノート操作 ----

	/** 本体ファイルだけを書く（noteList はまだ更新しない = アップロード途中の状態）。 */
	uploadNoteFile(note: PeerNote): void {
		const body = goJSON({
			id: note.id,
			title: note.title,
			content: note.content,
			contentHeader: contentHeaderOf(note.content),
			language: note.language,
			modifiedTime: note.modifiedTime,
			archived: note.archived,
		});
		const existing = this.noteFile(note.id);
		if (existing) {
			this.drive.updateFile(existing.id, body);
		} else {
			this.drive.createFile(`${note.id}.json`, [this.notesFolder().id], body);
		}
	}

	/** noteList にメタを反映する。新規なら先頭（デスクトップの新規ノートと同じ）に置く。 */
	publishNoteMeta(note: PeerNote, opts: { folderId?: string } = {}): void {
		this.updateList((list) => {
			const meta: GoNoteMetadata = {
				id: note.id,
				title: note.title,
				contentHeader: contentHeaderOf(note.content),
				language: note.language,
				modifiedTime: note.modifiedTime,
				archived: note.archived,
				contentHash: goContentHash(note),
			};
			const idx = list.notes.findIndex((n) => n.id === note.id);
			if (idx >= 0) {
				meta.folderId = opts.folderId ?? list.notes[idx].folderId;
				list.notes[idx] = meta;
				return;
			}
			if (opts.folderId) meta.folderId = opts.folderId;
			list.notes.unshift(meta);
			if (!opts.folderId && !note.archived) {
				list.topLevelOrder = [
					{ type: 'note', id: note.id },
					...(list.topLevelOrder ?? []),
				];
			}
		});
	}

	/** 新規作成 or 編集を、本体 → noteList の順で反映する。 */
	saveNote(note: PeerNote, opts: { folderId?: string } = {}): void {
		this.uploadNoteFile(note);
		this.publishNoteMeta(note, opts);
	}

	deleteNote(noteId: string): void {
		const f = this.noteFile(noteId);
		if (f) this.drive.deleteFile(f.id);
		this.updateList((list) => {
			list.notes = list.notes.filter((n) => n.id !== noteId);
			list.topLevelOrder = (list.topLevelOrder ?? []).filter(
				(i) => i.id !== noteId,
			);
			list.archivedTopLevelOrder = (list.archivedTopLevelOrder ?? []).filter(
				(i) => i.id !== noteId,
			);
		});
	}

	createFolder(id: string, name: string): void {
		this.updateList((list) => {
			list.folders = [...(list.folders ?? []), { id, name }];
			list.topLevelOrder = [
				{ type: 'folder', id },
				...(list.topLevelOrder ?? []),
			];
		});
	}

	moveNoteToFolder(noteId: string, folderId: string): void {
		this.updateList((list) => {
			const meta = list.notes.find((n) => n.id === noteId);
			if (!meta) throw new Error(`DesktopPeer: note ${noteId} not in list`);
			meta.folderId = folderId;
			list.topLevelOrder = (list.topLevelOrder ?? []).filter(
				(i) => !(i.type === 'note' && i.id === noteId),
			);
		});
	}
}

/** Go の omitempty に合わせて空配列フィールドを落とす。 */
function normalizeGoList(list: GoNoteList): GoNoteList {
	const out: GoNoteList = {
		version: list.version || '2.0',
		notes: list.notes.map((n) => {
			const m: GoNoteMetadata = { ...n };
			if (!m.folderId) delete m.folderId;
			return m;
		}),
	};
	if (list.folders && list.folders.length > 0) {
		out.folders = list.folders.map((f) =>
			f.archived ? f : { id: f.id, name: f.name },
		);
	}
	if (list.topLevelOrder && list.topLevelOrder.length > 0) {
		out.topLevelOrder = list.topLevelOrder;
	}
	if (list.archivedTopLevelOrder && list.archivedTopLevelOrder.length > 0) {
		out.archivedTopLevelOrder = list.archivedTopLevelOrder;
	}
	if (list.collapsedFolderIDs && list.collapsedFolderIDs.length > 0) {
		out.collapsedFolderIDs = list.collapsedFolderIDs;
	}
	return out;
}

/** Go の json.MarshalIndent(v, "", "  ") 相当。 */
function goJSON(v: unknown): string {
	return JSON.stringify(v, null, 2);
}
