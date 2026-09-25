import { Directory, File } from 'expo-file-system';
import { cloneNoteList } from '@/utils/noteListClone';
import { uuidv4 } from '@/utils/uuid';
import {
	deleteIfExists,
	ensureDir,
	readString,
	writeAtomic,
} from '../storage/atomicFile';
import {
	DEFAULT_STORAGE_PATHS,
	noteFilePath,
	type StoragePaths,
} from '../storage/paths';
import { AsyncLock } from '../sync/asyncLock';
import { computeContentHash } from '../sync/hash';
import {
	EMPTY_NOTE_LIST,
	type Folder,
	type Note,
	type NoteList,
	type NoteMetadata,
} from '../sync/types';

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
 * 同期エンジンがローカル状態をまとめて更新するためのハンドル。
 * NoteService.transact の中でだけ有効（UI の保存と排他になる）。
 */
export interface NoteStoreTx {
	/** 現在の noteList（複製）。 */
	list(): NoteList;
	readNote(noteId: string): Promise<Note | null>;
	/** 本体ファイルだけを書く（noteList は触らない）。 */
	writeNoteFile(note: Note): Promise<void>;
	/** 本体ファイルだけを消す（noteList は触らない）。 */
	removeNoteFile(noteId: string): Promise<void>;
	/** noteList を丸ごと差し替えて永続化する。 */
	setNoteList(list: NoteList): Promise<void>;
}

/**
 * ローカルノートの CRUD とメタデータ管理。
 *
 * - 個別ノートは notes/{id}.json（full Note）
 * - noteList.json はメタデータのみ（content なし）。**所属フォルダ (folderId) は noteList が正**で、
 *   本体ファイル側の folderId は読まない（デスクトップ版のファイルには無い）。
 * - すべての書き込みは 1 本のロックで直列化する。同期エンジンのコミット（transact）と
 *   UI の保存が交互に進んで、ユーザーの編集を同期結果で上書きする事故を防ぐ。
 */
export class NoteService {
	private list: NoteList = cloneNoteList(EMPTY_NOTE_LIST);
	private loaded = false;
	private readonly lock = new AsyncLock();

	constructor(private readonly paths: StoragePaths = DEFAULT_STORAGE_PATHS) {}

	async load(): Promise<void> {
		if (this.loaded) return;
		await this.lock.run(async () => {
			if (this.loaded) return;
			await ensureDir(this.paths.notesDir);
			const raw = await readString(this.paths.noteListPath);
			if (raw) {
				try {
					const parsed = JSON.parse(raw) as NoteList;
					if (parsed.version === 'v2') {
						this.list = { ...cloneNoteList(EMPTY_NOTE_LIST), ...parsed };
					}
				} catch (e) {
					console.warn(
						'[NoteService] failed to parse noteList.json, resetting',
						e,
					);
				}
			}
			this.loaded = true;
			// 空 contentHeader のノートは一覧で「無題のノート」としか出ないので、
			// 本文ファイルから contentHeader を復旧しておく（古いデスクトップ版由来のノートの救済）。
			await this.repairMissingContentHeaders();
		});
	}

	getNoteList(): NoteList {
		return cloneNoteList(this.list);
	}

	/** 端末データ削除後に、メモリ上のノート一覧も空状態へ戻す。 */
	resetInMemory(): void {
		this.list = cloneNoteList(EMPTY_NOTE_LIST);
		this.loaded = true;
	}

	/**
	 * UI の楽観的更新用に、メモリ上の noteList だけを先に差し替える。
	 * 呼び出し側は後続で replaceNoteList() を呼び、必ず永続化すること。
	 *
	 * preserveExtras=true: 並行する同期が追加した notes/folders を失わないよう、
	 * incoming に無いものは**先頭**に保持して merge する（新着は先頭が既定の置き場所）。
	 */
	replaceNoteListInMemory(
		list: NoteList,
		opts?: { preserveExtras?: boolean },
	): void {
		this.list = opts?.preserveExtras
			? this.mergeNoteListPreservingExtras(list)
			: cloneNoteList(list);
	}

	async replaceNoteList(
		list: NoteList,
		opts?: { preserveExtras?: boolean },
	): Promise<void> {
		await this.lock.run(async () => {
			this.list = opts?.preserveExtras
				? this.mergeNoteListPreservingExtras(list)
				: cloneNoteList(list);
			await this.persistList();
			await this.repairMissingContentHeaders();
		});
	}

	/**
	 * 本体ファイルを読む。所属フォルダは noteList の値で上書きして返す（noteList が正）。
	 */
	async readNote(noteId: string): Promise<Note | null> {
		const note = await this.readNoteFile(noteId);
		if (!note) return null;
		const meta = this.list.notes.find((n) => n.id === noteId);
		return meta ? { ...note, folderId: meta.folderId } : note;
	}

	/**
	 * ノートを保存する。既存ノートの所属フォルダは noteList の値を維持する
	 * （エディタが古い folderId を持ったまま保存しても、同期で移動された所属を巻き戻さない）。
	 * フォルダ移動は noteList 側の操作（replaceNoteList 等）で行う。
	 */
	async saveNote(
		note: Note,
		opts?: { prependToOrder?: boolean },
	): Promise<void> {
		await this.lock.run(async () => {
			const existing = this.list.notes.find((n) => n.id === note.id);
			const normalized = existing
				? { ...note, folderId: existing.folderId }
				: note;
			await this.writeNoteFile(normalized);
			await this.upsertMetadata(normalized, opts?.prependToOrder ?? false);
		});
	}

	async deleteNote(noteId: string): Promise<void> {
		await this.lock.run(async () => {
			await deleteIfExists(noteFilePath(noteId, this.paths.notesDir));
			this.removeNoteFromList(noteId);
			await this.persistList();
		});
	}

	/** 同期エンジン用: ロックを取った状態でローカルをまとめて更新する。 */
	async transact<T>(fn: (tx: NoteStoreTx) => Promise<T>): Promise<T> {
		return this.lock.run(() =>
			fn({
				list: () => cloneNoteList(this.list),
				readNote: (id) => this.readNote(id),
				writeNoteFile: (note) => this.writeNoteFile(note),
				removeNoteFile: (id) =>
					deleteIfExists(noteFilePath(id, this.paths.notesDir)),
				setNoteList: async (list) => {
					this.list = cloneNoteList(list);
					await this.persistList();
				},
			}),
		);
	}

	/** フォルダの折りたたみ状態を切り替え、noteList.json に永続化する。 */
	async setFolderCollapsed(
		folderId: string,
		collapsed: boolean,
	): Promise<void> {
		await this.lock.run(async () => {
			const set = new Set(this.list.collapsedFolderIds);
			if (collapsed) set.add(folderId);
			else set.delete(folderId);
			this.list.collapsedFolderIds = [...set];
			await this.persistList();
		});
	}

	async createFolder(name: string, archived = false): Promise<Folder> {
		return this.lock.run(async () => {
			const folder: Folder = { id: uuidv4(), name, archived };
			this.list.folders.push(folder);
			const order = archived
				? this.list.archivedTopLevelOrder
				: this.list.topLevelOrder;
			order.unshift({ type: 'folder', id: folder.id });
			await this.persistList();
			return folder;
		});
	}

	async deleteFolder(folderId: string): Promise<void> {
		await this.lock.run(async () => {
			this.list.folders = this.list.folders.filter((f) => f.id !== folderId);
			// フォルダ内のノートはトップレベルへ繰り上げる（同期で整合させる）
			const promotedIds: string[] = [];
			for (const n of this.list.notes) {
				if (n.folderId === folderId) {
					n.folderId = '';
					promotedIds.push(n.id);
				}
			}
			this.list.topLevelOrder = this.list.topLevelOrder.filter(
				(i) => !(i.type === 'folder' && i.id === folderId),
			);
			for (const id of promotedIds) {
				if (
					!this.list.topLevelOrder.some((i) => i.type === 'note' && i.id === id)
				) {
					this.list.topLevelOrder.push({ type: 'note', id });
				}
			}
			this.list.archivedTopLevelOrder = this.list.archivedTopLevelOrder.filter(
				(i) => !(i.type === 'folder' && i.id === folderId),
			);
			await this.persistList();
		});
	}

	/** フォルダ名を変更する。 */
	async renameFolder(folderId: string, name: string): Promise<void> {
		await this.lock.run(async () => {
			const folder = this.list.folders.find((f) => f.id === folderId);
			if (!folder) return;
			folder.name = name;
			await this.persistList();
		});
	}

	/**
	 * archived 状態のフォルダを active へ戻す。配下の archived ノートも一緒に
	 * unarchive する。戻り値は復元したノート ID 一覧（呼出側で `markNoteDirty` するため）。
	 */
	async restoreFolder(folderId: string): Promise<string[]> {
		return this.lock.run(async () => {
			const folder = this.list.folders.find((f) => f.id === folderId);
			if (!folder) return [];
			const targetNoteIds = this.list.notes
				.filter((n) => n.folderId === folderId && n.archived)
				.map((n) => n.id);
			for (const id of targetNoteIds) {
				await this.setNoteArchivedUnlocked(id, false);
			}
			folder.archived = false;
			this.list.archivedTopLevelOrder = this.list.archivedTopLevelOrder.filter(
				(i) => !(i.type === 'folder' && i.id === folderId),
			);
			if (
				!this.list.topLevelOrder.some(
					(i) => i.type === 'folder' && i.id === folderId,
				)
			) {
				this.list.topLevelOrder.push({ type: 'folder', id: folderId });
			}
			await this.persistList();
			return targetNoteIds;
		});
	}

	/**
	 * archived フォルダを完全削除する。配下の archived ノートも本文ファイルごと削除する。
	 * 戻り値は削除したノート ID 一覧（呼出側で markNoteDeleted する）。
	 */
	async deleteFolderHard(folderId: string): Promise<string[]> {
		return this.lock.run(async () => {
			const folder = this.list.folders.find((f) => f.id === folderId);
			if (!folder) return [];
			const targetNoteIds = this.list.notes
				.filter((n) => n.folderId === folderId)
				.map((n) => n.id);
			for (const id of targetNoteIds) {
				await deleteIfExists(noteFilePath(id, this.paths.notesDir));
			}
			this.list.notes = this.list.notes.filter((n) => n.folderId !== folderId);
			this.list.folders = this.list.folders.filter((f) => f.id !== folderId);
			const removedIds = new Set(targetNoteIds);
			const keep = (i: { type: string; id: string }) =>
				!(i.type === 'folder' && i.id === folderId) &&
				!(i.type === 'note' && removedIds.has(i.id));
			this.list.topLevelOrder = this.list.topLevelOrder.filter(keep);
			this.list.archivedTopLevelOrder =
				this.list.archivedTopLevelOrder.filter(keep);
			await this.persistList();
			return targetNoteIds;
		});
	}

	/**
	 * フォルダごとアーカイブする。フォルダ配下の active なノートを全て archived にし、
	 * フォルダ自体も archived として `archivedTopLevelOrder` へ移す。
	 * 戻り値は archived にしたノート ID 一覧（呼出側で `markNoteDirty` するため）。
	 */
	async archiveFolder(folderId: string): Promise<string[]> {
		return this.lock.run(async () => {
			const folder = this.list.folders.find((f) => f.id === folderId);
			if (!folder) return [];
			const targetNoteIds = this.list.notes
				.filter((n) => n.folderId === folderId && !n.archived)
				.map((n) => n.id);
			for (const id of targetNoteIds) {
				await this.setNoteArchivedUnlocked(id, true);
			}
			folder.archived = true;
			this.list.topLevelOrder = this.list.topLevelOrder.filter(
				(i) => !(i.type === 'folder' && i.id === folderId),
			);
			if (
				!this.list.archivedTopLevelOrder.some(
					(i) => i.type === 'folder' && i.id === folderId,
				)
			) {
				this.list.archivedTopLevelOrder.push({ type: 'folder', id: folderId });
			}
			await this.persistList();
			return targetNoteIds;
		});
	}

	/**
	 * note の archived フラグを切り替えてメタデータを更新する。
	 * 本文ファイル (notes/{id}.json) も書き戻す（次回保存待ちにせず即時反映）。
	 */
	async setNoteArchived(noteId: string, archived: boolean): Promise<void> {
		await this.lock.run(async () => {
			await this.setNoteArchivedUnlocked(noteId, archived);
			await this.persistList();
		});
	}

	/**
	 * noteList に載っていない本体ファイル（書き込み途中のクラッシュ等）をトップレベル先頭に登録する。
	 * 不明ノートフォルダは使わない（docs/sync-engine-v3.md P8）。戻り値は登録したノート ID。
	 */
	async adoptOrphanNotes(): Promise<string[]> {
		return this.lock.run(async () => {
			const listed = new Set(this.list.notes.map((n) => n.id));
			const dir = new Directory(this.paths.notesDir);
			if (!dir.exists) return [];
			const adopted: string[] = [];
			for (const entry of dir.list()) {
				if (!(entry instanceof File) || !entry.name.endsWith('.json')) continue;
				const id = entry.name.slice(0, -5);
				if (listed.has(id)) continue;
				const note = await this.readNoteFile(id);
				if (!note) continue;
				await this.upsertMetadata({ ...note, folderId: '' }, true);
				adopted.push(id);
			}
			return adopted;
		});
	}

	// ---- 内部（ロック保持中に呼ぶ） ----

	private async readNoteFile(noteId: string): Promise<Note | null> {
		const raw = await readString(noteFilePath(noteId, this.paths.notesDir));
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

	private async writeNoteFile(note: Note): Promise<void> {
		await ensureDir(this.paths.notesDir);
		const { syncing: _s, ...persist } = note;
		await writeAtomic(
			noteFilePath(note.id, this.paths.notesDir),
			JSON.stringify(persist),
		);
	}

	private removeNoteFromList(noteId: string): void {
		this.list.notes = this.list.notes.filter((n) => n.id !== noteId);
		const keep = (i: { type: string; id: string }) =>
			!(i.type === 'note' && i.id === noteId);
		this.list.topLevelOrder = this.list.topLevelOrder.filter(keep);
		this.list.archivedTopLevelOrder =
			this.list.archivedTopLevelOrder.filter(keep);
	}

	private async setNoteArchivedUnlocked(
		noteId: string,
		archived: boolean,
	): Promise<void> {
		const meta = this.list.notes.find((n) => n.id === noteId);
		if (!meta) return;
		const note = await this.readNoteFile(noteId);
		if (!note) return;

		const wasArchived = meta.archived;
		meta.archived = archived;
		meta.modifiedTime = new Date().toISOString();
		meta.contentHash = await computeContentHash({ ...note, archived });

		// topLevelOrder / archivedTopLevelOrder の付け替え（フォルダ配下なら何もしない）
		if (!meta.folderId) {
			if (wasArchived && !archived) {
				this.list.archivedTopLevelOrder =
					this.list.archivedTopLevelOrder.filter(
						(i) => !(i.type === 'note' && i.id === noteId),
					);
				if (
					!this.list.topLevelOrder.some(
						(i) => i.type === 'note' && i.id === noteId,
					)
				) {
					this.list.topLevelOrder.unshift({ type: 'note', id: noteId });
				}
			} else if (!wasArchived && archived) {
				this.list.topLevelOrder = this.list.topLevelOrder.filter(
					(i) => !(i.type === 'note' && i.id === noteId),
				);
				if (
					!this.list.archivedTopLevelOrder.some(
						(i) => i.type === 'note' && i.id === noteId,
					)
				) {
					this.list.archivedTopLevelOrder.unshift({ type: 'note', id: noteId });
				}
			}
		}

		await this.writeNoteFile({
			...note,
			archived,
			modifiedTime: meta.modifiedTime,
			folderId: meta.folderId,
		});
	}

	private async upsertMetadata(
		note: Note,
		prependToOrder: boolean,
	): Promise<void> {
		const metadata = await this.buildMetadata(note);
		const index = this.list.notes.findIndex((n) => n.id === note.id);
		if (index >= 0) {
			this.list.notes[index] = metadata;
		} else {
			// 新規追加: `prependToOrder` が真なら一覧の先頭、そうでなければ末尾。
			if (prependToOrder) this.list.notes.unshift(metadata);
			else this.list.notes.push(metadata);
			// フォルダに属するノートは topLevelOrder に含めない（data model の整合性）
			if (!note.folderId) {
				const order = note.archived
					? this.list.archivedTopLevelOrder
					: this.list.topLevelOrder;
				if (!order.some((i) => i.type === 'note' && i.id === note.id)) {
					if (prependToOrder) order.unshift({ type: 'note', id: note.id });
					else order.push({ type: 'note', id: note.id });
				}
			}
		}
		await this.persistList();
	}

	private async buildMetadata(note: Note): Promise<NoteMetadata> {
		return {
			id: note.id,
			title: note.title,
			// contentHeader が未設定なら本文から即生成する（空タイトルでも一覧でプレビューを出すため）
			contentHeader: note.contentHeader || generateContentHeader(note.content),
			language: note.language,
			modifiedTime: note.modifiedTime,
			archived: note.archived,
			folderId: note.folderId,
			contentHash: await computeContentHash(note),
		};
	}

	/**
	 * incoming を主とし、現在の this.list にしか存在しない notes/folders を先頭に保持して返す。
	 * 並行する同期が追加した項目は「新着」なので先頭が自然な位置。
	 */
	private mergeNoteListPreservingExtras(incoming: NoteList): NoteList {
		const incomingNoteIds = new Set(incoming.notes.map((n) => n.id));
		const incomingFolderIds = new Set(incoming.folders.map((f) => f.id));
		const extraNotes = this.list.notes.filter(
			(n) => !incomingNoteIds.has(n.id),
		);
		const extraFolders = this.list.folders.filter(
			(f) => !incomingFolderIds.has(f.id),
		);
		if (extraNotes.length === 0 && extraFolders.length === 0) {
			return cloneNoteList(incoming);
		}
		const merged = cloneNoteList(incoming);
		merged.notes = [...extraNotes, ...merged.notes];
		merged.folders = [...extraFolders, ...merged.folders];
		const prependTo = (
			archived: boolean,
			type: 'note' | 'folder',
			id: string,
		) => {
			const order = archived
				? merged.archivedTopLevelOrder
				: merged.topLevelOrder;
			if (!order.some((i) => i.type === type && i.id === id))
				order.unshift({ type, id });
		};
		for (const n of [...extraNotes].reverse()) {
			// folderId 付きノートは topLevelOrder には載せない（data model 整合）
			if (!n.folderId) prependTo(n.archived, 'note', n.id);
		}
		for (const f of [...extraFolders].reverse()) {
			prependTo(f.archived, 'folder', f.id);
		}
		return merged;
	}

	/**
	 * metadata.contentHeader が空のノートについて、本文ファイルを読んで contentHeader を再生成する。
	 * ローカル表示用の修復なので dirty にはしない。
	 */
	private async repairMissingContentHeaders(): Promise<void> {
		let repaired = 0;
		for (const meta of this.list.notes) {
			if (meta.contentHeader) continue;
			const note = await this.readNoteFile(meta.id);
			if (!note?.content) continue;
			const generated = generateContentHeader(note.content);
			if (!generated) continue;
			meta.contentHeader = generated;
			repaired++;
		}
		if (repaired > 0) await this.persistList();
	}

	private async persistList(): Promise<void> {
		await writeAtomic(
			this.paths.noteListPath,
			JSON.stringify(this.list, null, 2),
		);
	}
}

export const noteService = new NoteService();
