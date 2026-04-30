import { Directory, File } from 'expo-file-system';
import { cloneNoteList } from '@/utils/noteListClone';
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
	private list: NoteList = cloneNoteList(EMPTY_NOTE_LIST);
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

	/** 内部共通処理: 実際に contentHeader を生成して list 更新。返り値は修正件数。
	 *
	 * 注: ループ中に `this.list` が外部から置き換えられる (UI 楽観更新の merge 等) 可能性があるため、
	 * meta 参照を保持せず、各 await 後に ID で取り直して書き戻す。
	 */
	private async runContentHeaderRepair(): Promise<number> {
		let repaired = 0;
		// 開始時点での「修復対象 ID リスト」を確定。await 中に this.list が
		// merge されても、ID ベースで同じ対象を順に処理する。
		const targets = this.list.notes
			.filter((n) => !n.contentHeader)
			.map((n) => n.id);
		for (const id of targets) {
			const note = await this.readNote(id);
			if (!note?.content) continue;
			const generated = generateContentHeader(note.content);
			if (!generated) continue;
			// await 後に this.list が置換されている可能性があるので再 lookup
			const currentMeta = this.list.notes.find((n) => n.id === id);
			if (!currentMeta || currentMeta.contentHeader) continue;
			currentMeta.contentHeader = generated;
			repaired++;
		}
		if (repaired > 0) {
			await this.persistList();
		}
		return repaired;
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
	 * preserveExtras=true: 同期 pull が並行して upsertMetadata した notes/folders を
	 * 失わないよう、incoming に存在しないものは末尾に保持して merge する。
	 * UI 楽観更新の baseline が古い場合の race（pull 中ドラッグでフォルダ配下が消える等）
	 * を防ぐためのもの。orchestrator は authoritative 置換のため preserveExtras なしで呼ぶ。
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
		this.list = opts?.preserveExtras
			? this.mergeNoteListPreservingExtras(list)
			: cloneNoteList(list);
		await this.persistList();
		// cloud の noteList に contentHeader が未設定のエントリが含まれていても、
		// ローカル notes/ 上の本文ファイルから補完する。
		// （サーバ側を汚さず表示のためだけにローカルで補修する方針）
		await this.repairMissingContentHeaders();
	}

	/**
	 * incoming を主とし、現在の this.list にしか存在しない notes/folders を
	 * 末尾に保持して返す。topLevelOrder / archivedTopLevelOrder にも extra を
	 * 末尾追加する（孤立メタ防止）。
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
		merged.notes = [...merged.notes, ...extraNotes];
		merged.folders = [...merged.folders, ...extraFolders];

		const inTop = new Set(merged.topLevelOrder.map((i) => `${i.type}:${i.id}`));
		const inArch = new Set(
			merged.archivedTopLevelOrder.map((i) => `${i.type}:${i.id}`),
		);
		const appendOrder = (
			archived: boolean,
			type: 'note' | 'folder',
			id: string,
		) => {
			const set = archived ? inArch : inTop;
			const order = archived
				? merged.archivedTopLevelOrder
				: merged.topLevelOrder;
			const key = `${type}:${id}`;
			if (!set.has(key)) {
				order.push({ type, id });
				set.add(key);
			}
		};
		for (const f of extraFolders) {
			appendOrder(f.archived, 'folder', f.id);
		}
		for (const n of extraNotes) {
			// folderId 付きノートは topLevelOrder には載せない（data model 整合）
			if (!n.folderId) {
				appendOrder(n.archived, 'note', n.id);
			}
		}
		return merged;
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

	async saveNote(
		note: Note,
		opts?: { prependToOrder?: boolean },
	): Promise<void> {
		await ensureDir(NOTES_DIR);
		const { syncing: _s, ...persist } = note;
		await writeAtomic(noteFilePath(note.id), JSON.stringify(persist));
		await this.upsertMetadata(note, opts?.prependToOrder ?? false);
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
		order.unshift({ type: 'folder', id });
		await this.persistList();
		return folder;
	}

	async deleteFolder(folderId: string): Promise<void> {
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
		// 繰り上げたノートは topLevelOrder に末尾追加（重複避け）
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
	}

	/** フォルダ名を変更する。 */
	async renameFolder(folderId: string, name: string): Promise<void> {
		const folder = this.list.folders.find((f) => f.id === folderId);
		if (!folder) return;
		folder.name = name;
		await this.persistList();
	}

	/**
	 * archived 状態のフォルダを active へ戻す。配下の archived ノートも一緒に
	 * unarchive する。戻り値は復元したノート ID 一覧（呼出側で `markNoteDirty` するため）。
	 */
	async restoreFolder(folderId: string): Promise<string[]> {
		const folder = this.list.folders.find((f) => f.id === folderId);
		if (!folder) return [];

		const targetNoteIds = this.list.notes
			.filter((n) => n.folderId === folderId && n.archived)
			.map((n) => n.id);
		for (const id of targetNoteIds) {
			await this.setNoteArchived(id, false);
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
	}

	/**
	 * archived フォルダを完全削除する。配下の archived ノートも本文ファイルごと
	 * 削除する（同期側のクラウド削除は呼出側で `driveService.deleteNoteAndSync` を
	 * 各 ID に対して回す前提）。
	 *
	 * 戻り値は削除したノート ID 一覧（呼出側でクラウド削除＋ markNoteDeleted する）。
	 */
	async deleteFolderHard(folderId: string): Promise<string[]> {
		const folder = this.list.folders.find((f) => f.id === folderId);
		if (!folder) return [];

		const targetNoteIds = this.list.notes
			.filter((n) => n.folderId === folderId)
			.map((n) => n.id);

		// ノート本文ファイルとメタデータを削除
		for (const id of targetNoteIds) {
			await deleteIfExists(noteFilePath(id));
		}
		this.list.notes = this.list.notes.filter((n) => n.folderId !== folderId);

		// フォルダ自体を削除
		this.list.folders = this.list.folders.filter((f) => f.id !== folderId);
		this.list.topLevelOrder = this.list.topLevelOrder.filter(
			(i) => !(i.type === 'folder' && i.id === folderId),
		);
		this.list.archivedTopLevelOrder = this.list.archivedTopLevelOrder.filter(
			(i) => !(i.type === 'folder' && i.id === folderId),
		);
		// 念のため: ノート ID も order から外す（本来 folder-child は order に
		// 載らないが、データ破損保険）
		const removedIds = new Set(targetNoteIds);
		this.list.topLevelOrder = this.list.topLevelOrder.filter(
			(i) => !(i.type === 'note' && removedIds.has(i.id)),
		);
		this.list.archivedTopLevelOrder = this.list.archivedTopLevelOrder.filter(
			(i) => !(i.type === 'note' && removedIds.has(i.id)),
		);
		await this.persistList();

		return targetNoteIds;
	}

	/**
	 * フォルダごとアーカイブする。フォルダ配下の active なノートを全て archived にし、
	 * フォルダ自体も archived として `archivedTopLevelOrder` へ移す。
	 *
	 * 戻り値は archived にしたノート ID 一覧（呼出側で `markNoteDirty` するため）。
	 */
	async archiveFolder(folderId: string): Promise<string[]> {
		const folder = this.list.folders.find((f) => f.id === folderId);
		if (!folder) return [];

		// 1. 配下の active ノートをアーカイブ。setNoteArchived は本文ファイルも
		//    書き戻すので順次実行する。folder-child のままで archived=true を持つ。
		const targetNoteIds = this.list.notes
			.filter((n) => n.folderId === folderId && !n.archived)
			.map((n) => n.id);
		for (const id of targetNoteIds) {
			await this.setNoteArchived(id, true);
		}

		// 2. フォルダ自体を archived 化し、active 側 order から外す。
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
	}

	/**
	 * note の archived フラグを切り替えてメタデータを更新する。
	 * 本文ファイル (notes/{id}.json) も書き戻す（次回保存待ちにせず即時反映）。
	 */
	async setNoteArchived(noteId: string, archived: boolean): Promise<void> {
		const meta = this.list.notes.find((n) => n.id === noteId);
		if (!meta) return;
		const note = await this.readNote(noteId);
		if (!note) return;

		const wasArchived = meta.archived;
		meta.archived = archived;
		meta.modifiedTime = new Date().toISOString();
		// archived 切替に伴い contentHash も更新
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
					this.list.topLevelOrder.push({ type: 'note', id: noteId });
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
					this.list.archivedTopLevelOrder.push({ type: 'note', id: noteId });
				}
			}
		}

		// 本文側も書き換える
		await writeAtomic(
			noteFilePath(noteId),
			JSON.stringify({
				...note,
				archived,
				modifiedTime: meta.modifiedTime,
			}),
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

	private async upsertMetadata(
		note: Note,
		prependToOrder = false,
	): Promise<void> {
		const metadata = await this.buildMetadata(note, note.folderId);
		const index = this.list.notes.findIndex((n) => n.id === note.id);
		if (index >= 0) {
			this.list.notes[index] = metadata;
		} else {
			// 新規追加: `prependToOrder` が真なら一覧の先頭、そうでなければ末尾。
			if (prependToOrder) {
				this.list.notes.unshift(metadata);
			} else {
				this.list.notes.push(metadata);
			}
			// フォルダに属するノートは topLevelOrder に含めない（data model の整合性）
			if (!note.folderId) {
				const order = note.archived
					? this.list.archivedTopLevelOrder
					: this.list.topLevelOrder;
				if (!order.some((i) => i.type === 'note' && i.id === note.id)) {
					if (prependToOrder) {
						order.unshift({ type: 'note', id: note.id });
					} else {
						order.push({ type: 'note', id: note.id });
					}
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
