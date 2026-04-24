import { Directory, File } from 'expo-file-system';
import { uuidv4 } from '@/utils/uuid';
import {
	deleteIfExists,
	ensureDir,
	readString,
	writeAtomic,
} from '../storage/atomicFile';
import { NOTE_LIST_PATH, NOTES_DIR, noteFilePath } from '../storage/paths';
import { computeContentHash } from '../sync/hash';
import {
	EMPTY_NOTE_LIST,
	type Folder,
	type Note,
	type NoteList,
	type NoteMetadata,
	ORPHAN_FOLDER_NAME,
} from '../sync/types';

function cloneDeep<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * ノート本文から contentHeader を生成する。
 * デスクトップ版 backend/note_service.go の generateContentHeader と同じ挙動：
 * 空でない行を最大 3 行集め、改行区切りで結合、200 文字で切り詰め。
 */
export function generateContentHeader(content: string): string {
	if (!content) return '';
	const lines = content.split('\n');
	const nonEmpty: string[] = [];
	for (const line of lines) {
		if (line.trim() !== '') {
			nonEmpty.push(line);
			if (nonEmpty.length >= 3) break;
		}
	}
	const header = nonEmpty.join('\n');
	return header.length > 200 ? header.slice(0, 200) : header;
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
				console.warn(
					'[NoteService] failed to parse noteList.json, resetting',
					e,
				);
			}
		}
		this.loaded = true;
		// 空 title + 空 contentHeader のノートは一覧で「無題のノート」としか出ないので、
		// 本文ファイルから contentHeader を復旧しておく（デスクトップ版由来の古いノートへの救済）。
		await this.repairMissingContentHeaders();
	}

	/**
	 * metadata.contentHeader が空のノートについて、本文ファイルを読んで contentHeader を再生成する。
	 * title 有無に関わらず実行する（title があってもプレビュー表示に contentHeader が使われるため）。
	 *
	 * ローカルファイルに影響する移行処理なので dirty マークはしない。
	 * クラウド側は次回保存時に desktop / mobile どちらの新実装でも正しい contentHeader を付与して push する。
	 */
	private async repairMissingContentHeaders(): Promise<void> {
		await this.runContentHeaderRepair();
	}

	/**
	 * 一括修復の public 版。orchestrator から呼ばれ、
	 * 変更があった件数を返す（呼出元が dirty マーク → Drive push を判断できるよう）。
	 */
	async bulkRepairContentHeaders(): Promise<number> {
		return this.runContentHeaderRepair();
	}

	/**
	 * 渡された NoteList の中の、contentHeader 空エントリを **in-place で埋める**。
	 * ローカルの note file から content を読み、generateContentHeader で生成。
	 * 主に pullCloudChanges が cloudList を replaceNoteList する前に呼ぶ想定。
	 * 戻り値は修復件数。
	 */
	async fillEmptyContentHeadersInList(list: NoteList): Promise<number> {
		let fixed = 0;
		for (const meta of list.notes) {
			if (meta.contentHeader) continue;
			const note = await this.readNote(meta.id);
			if (!note?.content) continue;
			const generated = generateContentHeader(note.content);
			if (!generated) continue;
			meta.contentHeader = generated;
			fixed++;
		}
		return fixed;
	}

	/** 内部共通処理: 実際に contentHeader を生成して list 更新。返り値は修正件数。 */
	private async runContentHeaderRepair(): Promise<number> {
		let repaired = 0;
		for (const meta of this.list.notes) {
			if (meta.contentHeader) continue;
			const note = await this.readNote(meta.id);
			if (!note?.content) continue;
			const generated = generateContentHeader(note.content);
			if (!generated) continue;
			meta.contentHeader = generated;
			repaired++;
		}
		if (repaired > 0) {
			await this.persistList();
		}
		return repaired;
	}

	getNoteList(): NoteList {
		return cloneDeep(this.list);
	}

	async replaceNoteList(list: NoteList): Promise<void> {
		this.list = cloneDeep(list);
		await this.persistList();
		// cloud の noteList に contentHeader が未設定のエントリが含まれていても、
		// ローカル notes/ 上の本文ファイルから補完する。
		// （サーバ側を汚さず表示のためだけにローカルで補修する方針）
		await this.repairMissingContentHeaders();
	}

	async readNote(noteId: string): Promise<Note | null> {
		const raw = await readString(noteFilePath(noteId));
		if (!raw) return null;
		try {
			// 欠損フィールド対策で明示的に初期値を充てる（古いデータや部分的な JSON でも落ちない）
			const parsed = JSON.parse(raw) as Partial<Note>;
			if (!parsed.id) return null;
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

	/** フォルダの折りたたみ状態を切り替え、noteList.json に永続化する。 */
	async setFolderCollapsed(
		folderId: string,
		collapsed: boolean,
	): Promise<void> {
		const set = new Set(this.list.collapsedFolderIds);
		if (collapsed) set.add(folderId);
		else set.delete(folderId);
		this.list.collapsedFolderIds = [...set];
		await this.persistList();
	}

	async createFolder(name: string, archived = false): Promise<Folder> {
		const id = uuidv4();
		const folder: Folder = { id, name, archived };
		this.list.folders.push(folder);
		const order = archived
			? this.list.archivedTopLevelOrder
			: this.list.topLevelOrder;
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

	/**
	 * 孤立ノートを「不明ノート」フォルダへ復元する。
	 *
	 * ⚠️ note file 本体の folderId は書き換えない（元のまま保存する）。
	 * list metadata だけを不明ノートに紐付ける。
	 *
	 * 理由: 本体の folderId を不明ノートに書き換えてしまうと、後で同期が正常化しても
	 * 編集時にディスクから読んだ note の folderId が不明ノートのままで、保存→同期で伝搬する。
	 * list metadata は pullCloudChanges で cloudList の正しい値にすぐ上書きされるので安全。
	 */
	async recoverOrphanNote(note: Note): Promise<void> {
		await this.saveNote(note);
		const folderId = await this.ensureFolder(ORPHAN_FOLDER_NAME);
		const existing = this.list.notes.find((n) => n.id === note.id);
		if (existing) {
			existing.folderId = folderId;
		}
		// note.folderId が元々空でなければ upsertMetadata 経由で topLevelOrder には入っていない。
		// 空だった場合は topLevelOrder に残るが、不明ノートに再分類したので top から外す。
		this.list.topLevelOrder = this.list.topLevelOrder.filter(
			(i) => !(i.type === 'note' && i.id === note.id),
		);
		this.list.archivedTopLevelOrder = this.list.archivedTopLevelOrder.filter(
			(i) => !(i.type === 'note' && i.id === note.id),
		);
		await this.persistList();
	}

	async ensureFolder(name: string): Promise<string> {
		const existing = this.list.folders.find(
			(f) => f.name === name && !f.archived,
		);
		if (existing) return existing.id;
		const folder = await this.createFolder(name, false);
		return folder.id;
	}

	/** notes/ ディレクトリを走査し、noteList に無いファイルを孤立として返す。 */
	async scanOrphans(): Promise<Note[]> {
		const list = new Set(this.list.notes.map((n) => n.id));
		const orphans: Note[] = [];
		const dir = new Directory(NOTES_DIR);
		if (!dir.exists) return orphans;
		for (const entry of dir.list()) {
			if (!(entry instanceof File)) continue;
			if (!entry.name.endsWith('.json')) continue;
			const id = entry.name.slice(0, -5);
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
			// フォルダに属するノートは topLevelOrder に含めない（data model の整合性）
			if (!note.folderId) {
				const order = note.archived
					? this.list.archivedTopLevelOrder
					: this.list.topLevelOrder;
				if (!order.some((i) => i.type === 'note' && i.id === note.id)) {
					order.push({ type: 'note', id: note.id });
				}
			}
		}
		await this.persistList();
	}

	private async buildMetadata(
		note: Note,
		folderId: string,
	): Promise<NoteMetadata> {
		// contentHeader が未設定なら本文から即生成する（空タイトルノートでも一覧で本文プレビューを出すため）
		const contentHeader =
			note.contentHeader || generateContentHeader(note.content);
		return {
			id: note.id,
			title: note.title,
			contentHeader,
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
