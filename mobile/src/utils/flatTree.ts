import type {
	Folder,
	NoteList,
	NoteMetadata,
	TopLevelItem,
} from '@/services/sync/types';
import { cloneNoteList } from '@/utils/noteListClone';

/**
 * ノート一覧を DraggableFlatList が扱える「平坦な行配列」に変換する。
 * デスクトップ版の pragmatic-drag-and-drop tree pattern と同じ思想。
 *
 * 行の種類：
 * - `topLevel-note`: トップレベルのノート（depth 0）
 * - `folder-header`: フォルダの見出し
 * - `folder-child`: 展開されたフォルダ配下のノート（depth 1）
 *
 * 折りたたみ時は子は出さない（visual に隠れる）。DnD 中は常に折りたたみ状態を尊重し、
 * クロスフォルダ移動は別途「長押し → bottom sheet ピッカー」を用意する想定。
 */

export type FlatRow =
	| {
			kind: 'topLevel-note';
			key: string;
			id: string;
			note: NoteMetadata;
	  }
	| {
			kind: 'folder-header';
			key: string;
			id: string;
			folder: Folder;
			noteCount: number;
			collapsed: boolean;
			inGroupEnd: boolean;
	  }
	| {
			kind: 'folder-child';
			key: string;
			id: string;
			note: NoteMetadata;
			folderId: string;
			inGroupEnd: boolean;
			parentCollapsed?: boolean;
	  };

/**
 * 「アクティブビュー」（archived=false）または「アーカイブビュー」（archived=true）の
 * いずれかを平坦化する。両ビューを同時にレンダーするのは現状サポートしない。
 */
export interface FlattenOptions {
	archived?: boolean;
	includeCollapsedChildren?: boolean;
}

export function flattenNoteList(
	list: NoteList,
	opts: FlattenOptions = {},
): FlatRow[] {
	const archived = opts.archived ?? false;
	const includeCollapsedChildren = opts.includeCollapsedChildren ?? false;
	const order = archived ? list.archivedTopLevelOrder : list.topLevelOrder;
	const folderById = new Map(list.folders.map((f) => [f.id, f]));
	const collapsedSet = new Set(list.collapsedFolderIds);
	const notesById = new Map(list.notes.map((n) => [n.id, n]));

	// folder ごとの子ノートを `notes` 配列の順序を保ったまま集める。
	// `list.notes` に同じ id が複数入っているケース (race / 過去のバグの残滓 etc.) でも
	// 同一フォルダで重複しないようガードする。
	const notesByFolder = new Map<string, NoteMetadata[]>();
	const seenInByFolder = new Set<string>();
	for (const n of list.notes) {
		if ((n.archived ?? false) !== archived) continue;
		if (!n.folderId) continue;
		if (seenInByFolder.has(n.id)) continue;
		seenInByFolder.add(n.id);
		const arr = notesByFolder.get(n.folderId) ?? [];
		arr.push(n);
		notesByFolder.set(n.folderId, arr);
	}

	const out: FlatRow[] = [];
	const seenNotes = new Set<string>();
	const seenFolders = new Set<string>();

	for (const item of order) {
		if (item.type === 'note') {
			if (seenNotes.has(item.id)) continue; // order 重複ガード
			const note = notesById.get(item.id);
			if (!note || (note.archived ?? false) !== archived) continue;
			if (note.folderId) continue; // フォルダ配下のノートは folder-child として後で出す
			out.push({
				kind: 'topLevel-note',
				key: `t:${note.id}`,
				id: note.id,
				note,
			});
			seenNotes.add(note.id);
		} else if (item.type === 'folder') {
			if (seenFolders.has(item.id)) continue; // order 重複ガード
			const folder = folderById.get(item.id);
			if (!folder || (folder.archived ?? false) !== archived) continue;
			seenFolders.add(folder.id);
			const children = notesByFolder.get(folder.id) ?? [];
			const isCollapsed = collapsedSet.has(folder.id);
			const headerIsEnd = isCollapsed || children.length === 0;
			out.push({
				kind: 'folder-header',
				key: `f:${folder.id}`,
				id: folder.id,
				folder,
				noteCount: children.length,
				collapsed: isCollapsed,
				inGroupEnd: headerIsEnd,
			});
			if (!isCollapsed || includeCollapsedChildren) {
				children.forEach((child, idx) => {
					if (seenNotes.has(child.id)) return; // notes 配列重複ガード
					out.push({
						kind: 'folder-child',
						key: `c:${child.id}`,
						id: child.id,
						note: child,
						folderId: folder.id,
						inGroupEnd: idx === children.length - 1,
						parentCollapsed: isCollapsed,
					});
					seenNotes.add(child.id);
				});
			}
		}
	}

	// topLevelOrder に現れていない要素のフォールバック（データ破損保険）。
	// 過度に挿入すると DnD で順序が壊れるので末尾に最小限追加する。
	for (const folder of list.folders) {
		if ((folder.archived ?? false) !== archived) continue;
		if (seenFolders.has(folder.id)) continue;
		const children = notesByFolder.get(folder.id) ?? [];
		const isCollapsed = collapsedSet.has(folder.id);
		const headerIsEnd = isCollapsed || children.length === 0;
		out.push({
			kind: 'folder-header',
			key: `f:${folder.id}`,
			id: folder.id,
			folder,
			noteCount: children.length,
			collapsed: isCollapsed,
			inGroupEnd: headerIsEnd,
		});
		if (!isCollapsed || includeCollapsedChildren) {
			children.forEach((child, idx) => {
				if (seenNotes.has(child.id)) return;
				out.push({
					kind: 'folder-child',
					key: `c:${child.id}`,
					id: child.id,
					note: child,
					folderId: folder.id,
					inGroupEnd: idx === children.length - 1,
					parentCollapsed: isCollapsed,
				});
				seenNotes.add(child.id);
			});
		}
	}
	for (const n of list.notes) {
		if ((n.archived ?? false) !== archived) continue;
		if (seenNotes.has(n.id)) continue;
		// フォルダに属するが、そのフォルダがまだ未表示な場合は親が下に出るのでここでスキップ。
		// 完全に親不在ならトップレベルへ落とす。
		if (n.folderId && folderById.has(n.folderId)) continue;
		out.push({
			kind: 'topLevel-note',
			key: `t:${n.id}`,
			id: n.id,
			note: n,
		});
	}

	return out;
}

/**
 * DnD 後の新しい行配列を NoteList へ反映する。
 *
 * 方針：
 * - **動いた 1 アイテムだけ folderId を再分類する**。他のアイテムは元の folderId を
 *   そのまま保持する。これにより「フォルダの後ろにある top-level ノートまで
 *   一緒にフォルダに吸い込まれる」事故を防ぐ。
 * - 動いたアイテムの新 folderId は、新 flat 配列上で **その上にある最も近い
 *   展開済み folder-header** で決まる。無ければ top-level。
 * - 折り畳み中 folder-header は body 無いので folder context に入らない (= 直下の
 *   ノートは top-level 扱い)。
 * - フォルダ自体はネストしない (folder-header は常に top-level)。
 *
 * @param opts.movedIndex drax の onReorder が返す toIndex。指定しない場合は
 *   どのアイテムも再分類しない (= 単なる順序変更扱い)。
 *
 * 入力 `newRows` は flattenNoteList が返す形（または UI で並び替えた後の同じ形）であること。
 */
export interface ReorderOptions extends FlattenOptions {
	/** 動いたアイテムの新位置 (drax の onReorder.toIndex)。
	 *  指定された場合、そのアイテムだけ位置に応じて folderId を再計算する。 */
	movedIndex?: number;
}

export interface ReorderResult {
	list: NoteList;
	/** クロスフォルダ移動で folderId が変化したノート ID。
	 *  呼出側で本文ファイルの folderId 書き戻し + markNoteDirty に使う。 */
	movedNoteIds: string[];
}

export type DropIntent =
	| {
			type: 'top-level';
			/** topLevelOrder 上の挿入位置。移動元が手前にある場合は内部で補正する。 */
			index: number;
	  }
	| {
			type: 'folder-child';
			folderId: string;
			/** フォルダ内の挿入位置。移動元が同じフォルダ内の手前にある場合は内部で補正する。 */
			index: number;
	  };

export function applyReorder(
	original: NoteList,
	newRows: FlatRow[],
	opts: ReorderOptions = {},
): ReorderResult {
	const archived = opts.archived ?? false;
	const movedIndex = opts.movedIndex ?? -1;
	const list = cloneNoteList(original);
	const orderField = archived ? 'archivedTopLevelOrder' : 'topLevelOrder';
	const notesById = new Map(list.notes.map((note) => [note.id, note]));

	// 1. 動いたアイテムの「新 folderId」を、それより上の (展開済み) folder-header から決める。
	//    folder-header に出会うたびに context を更新するが、folder-header 以外の行 (note 系) は
	//    context を変えない (= folder の後ろに並ぶ note を「フォルダ外」と区別できないため、
	//    動いたアイテム以外には新 folderId を適用しない方針で吸収事故を防ぐ)。
	let newFolderForMoved = '';
	if (movedIndex >= 0 && movedIndex < newRows.length) {
		const movedRow = newRows[movedIndex];
		// 動いたのが note の場合のみ folderId 再計算する (folder-header の移動は
		// folder の position 変更のみで folderId は無関係)。
		if (movedRow && movedRow.kind !== 'folder-header') {
			for (let i = 0; i < movedIndex; i++) {
				const row = newRows[i];
				if (row.kind === 'folder-header') {
					newFolderForMoved = row.collapsed ? '' : row.id;
				}
			}
		}
	}

	// 2. newRows を順番に処理し、newTopLevelOrder と folderChildOrder を構築する。
	//    動いたアイテム (= newRows[movedIndex]) だけ新 folderId を、それ以外は
	//    行が持つ元の folderId をそのまま使う。
	const newTopLevelOrder: TopLevelItem[] = [];
	const folderChildOrder = new Map<string, string[]>();
	const movedNoteIds: string[] = [];

	for (let i = 0; i < newRows.length; i++) {
		const row = newRows[i];
		if (row.kind === 'folder-header') {
			newTopLevelOrder.push({ type: 'folder', id: row.id });
			continue;
		}
		// note 系 (topLevel-note / folder-child)
		const noteId = row.id;
		const originalFolderId = row.kind === 'folder-child' ? row.folderId : '';
		const folderId = i === movedIndex ? newFolderForMoved : originalFolderId;

		if (folderId === '') {
			newTopLevelOrder.push({ type: 'note', id: noteId });
		} else {
			const arr = folderChildOrder.get(folderId) ?? [];
			arr.push(noteId);
			folderChildOrder.set(folderId, arr);
		}

		if (i === movedIndex && folderId !== originalFolderId) {
			movedNoteIds.push(noteId);
		}
	}

	// 3. metadata の folderId を反映 (movedNoteIds に挙がったノートだけ更新が必要)。
	for (const noteId of movedNoteIds) {
		const note = notesById.get(noteId);
		if (note) note.folderId = newFolderForMoved;
	}

	// 4. notes 配列を新順序で並べ替える
	//    - top-level notes は newTopLevelOrder の登場順
	//    - folder-children はフォルダ ID ごとに集めた順序で連続配置
	//    - その他（archived ビューや破損データ等）は末尾に維持
	const inViewIds = new Set<string>();
	for (const item of newTopLevelOrder) {
		if (item.type === 'note') inViewIds.add(item.id);
	}
	for (const ids of folderChildOrder.values()) {
		for (const id of ids) inViewIds.add(id);
	}

	const reordered: NoteMetadata[] = [];
	for (const item of newTopLevelOrder) {
		if (item.type !== 'note') continue;
		const meta = notesById.get(item.id);
		if (meta) reordered.push(meta);
	}
	for (const [, ids] of folderChildOrder) {
		for (const id of ids) {
			const meta = notesById.get(id);
			if (meta) reordered.push(meta);
		}
	}
	const others = list.notes.filter((n) => !inViewIds.has(n.id));
	list.notes = [...reordered, ...others];

	list[orderField] = newTopLevelOrder;
	return { list, movedNoteIds };
}

export function applyDropIntent(
	original: NoteList,
	rowsAtDragStart: FlatRow[],
	fromIndex: number,
	intent: DropIntent,
	opts: FlattenOptions = {},
): ReorderResult {
	const archived = opts.archived ?? false;
	const movedRow = rowsAtDragStart[fromIndex];
	const list = cloneNoteList(original);
	const orderField = archived ? 'archivedTopLevelOrder' : 'topLevelOrder';

	if (!movedRow) return { list, movedNoteIds: [] };

	if (movedRow.kind === 'folder-header') {
		if (intent.type !== 'top-level') return { list, movedNoteIds: [] };
		list[orderField] = insertTopLevelItem(
			list[orderField],
			'folder',
			movedRow.id,
			intent.index,
		);
		return { list, movedNoteIds: [] };
	}

	const notesById = new Map(list.notes.map((note) => [note.id, note]));
	const movedNote = notesById.get(movedRow.id);
	if (!movedNote) return { list, movedNoteIds: [] };

	const sourceFolderId = movedNote.folderId || '';
	const targetFolderId = intent.type === 'folder-child' ? intent.folderId : '';
	const movedNoteIds = sourceFolderId === targetFolderId ? [] : [movedNote.id];

	if (intent.type === 'top-level') {
		list[orderField] = insertTopLevelItem(
			list[orderField],
			'note',
			movedNote.id,
			intent.index,
		);
	} else {
		list[orderField] = removeTopLevelItem(
			list[orderField],
			'note',
			movedNote.id,
		);
	}

	const sourceFolderChildren = collectFolderChildIds(
		list.notes,
		sourceFolderId,
		archived,
	);
	const sourceFolderChildIndex = sourceFolderChildren.indexOf(movedNote.id);
	const folderChildOrder = buildFolderChildOrder(
		list.notes,
		archived,
		movedNote.id,
	);

	movedNote.folderId = targetFolderId;
	if (intent.type === 'folder-child') {
		const children = folderChildOrder.get(intent.folderId) ?? [];
		let insertAt = intent.index;
		if (
			sourceFolderId === intent.folderId &&
			sourceFolderChildIndex !== -1 &&
			sourceFolderChildIndex < insertAt
		) {
			insertAt -= 1;
		}
		insertAt = clamp(insertAt, 0, children.length);
		children.splice(insertAt, 0, movedNote.id);
		folderChildOrder.set(intent.folderId, children);
	}

	rebuildNotesForView(list, orderField, folderChildOrder, archived);
	return { list, movedNoteIds };
}

/**
 * note を別フォルダ（空文字 = トップレベル）に移動した結果の NoteList を返す。
 * UI の long-press → folder picker から呼ばれる想定。
 */
export function moveNoteToFolder(
	original: NoteList,
	noteId: string,
	targetFolderId: string,
): NoteList {
	const list = cloneNoteList(original);
	const note = list.notes.find((n) => n.id === noteId);
	if (!note) return list;
	const archived = note.archived;

	if (note.folderId === targetFolderId) return list;
	const wasTopLevel = !note.folderId;
	note.folderId = targetFolderId;

	const orderField = archived ? 'archivedTopLevelOrder' : 'topLevelOrder';

	if (wasTopLevel) {
		// トップから落とす
		list[orderField] = list[orderField].filter(
			(i) => !(i.type === 'note' && i.id === noteId),
		);
	}
	if (!targetFolderId) {
		// トップレベルに浮上
		if (!list[orderField].some((i) => i.type === 'note' && i.id === noteId)) {
			list[orderField].push({ type: 'note', id: noteId });
		}
	}
	// `notes` 配列内では note を移動先フォルダの末尾近くに寄せる（同じ folderId のグループ末尾）。
	// これにより flattenNoteList が並べる時に「最後に追加された」感じになる。
	const others = list.notes.filter((n) => n.id !== noteId);
	const lastIdxOfFolder = lastIndexInFolder(others, targetFolderId);
	if (lastIdxOfFolder >= 0) {
		others.splice(lastIdxOfFolder + 1, 0, note);
	} else {
		others.push(note);
	}
	list.notes = others;
	return list;
}

function lastIndexInFolder(notes: NoteMetadata[], folderId: string): number {
	let last = -1;
	for (let i = 0; i < notes.length; i++) {
		if (notes[i].folderId === folderId) last = i;
	}
	return last;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function insertTopLevelItem(
	order: TopLevelItem[],
	itemType: TopLevelItem['type'],
	itemId: string,
	index: number,
): TopLevelItem[] {
	const currentIndex = order.findIndex(
		(item) => item.type === itemType && item.id === itemId,
	);
	const without = removeTopLevelItem(order, itemType, itemId);
	let insertAt = index;
	if (currentIndex !== -1 && currentIndex < insertAt) {
		insertAt -= 1;
	}
	insertAt = clamp(insertAt, 0, without.length);
	without.splice(insertAt, 0, { type: itemType, id: itemId });
	return without;
}

function removeTopLevelItem(
	order: TopLevelItem[],
	itemType: TopLevelItem['type'],
	itemId: string,
): TopLevelItem[] {
	return order.filter(
		(item) => !(item.type === itemType && item.id === itemId),
	);
}

function collectFolderChildIds(
	notes: NoteMetadata[],
	folderId: string,
	archived: boolean,
): string[] {
	if (!folderId) return [];
	return notes
		.filter(
			(note) =>
				(note.archived ?? false) === archived && note.folderId === folderId,
		)
		.map((note) => note.id);
}

function buildFolderChildOrder(
	notes: NoteMetadata[],
	archived: boolean,
	excludeNoteId: string,
): Map<string, string[]> {
	const order = new Map<string, string[]>();
	const seen = new Set<string>();
	for (const note of notes) {
		if ((note.archived ?? false) !== archived) continue;
		if (!note.folderId || note.id === excludeNoteId) continue;
		// 同じ id を持つ note 重複を防ぐ。先勝ちで「最初に出会った folder」へ入れる。
		if (seen.has(note.id)) continue;
		seen.add(note.id);
		const children = order.get(note.folderId) ?? [];
		children.push(note.id);
		order.set(note.folderId, children);
	}
	return order;
}

function rebuildNotesForView(
	list: NoteList,
	orderField: 'topLevelOrder' | 'archivedTopLevelOrder',
	folderChildOrder: Map<string, string[]>,
	archived: boolean,
) {
	const notesById = new Map(list.notes.map((note) => [note.id, note]));
	const usedIds = new Set<string>();
	const reordered: NoteMetadata[] = [];

	for (const item of list[orderField]) {
		if (item.type === 'note') {
			if (usedIds.has(item.id)) continue;
			const note = notesById.get(item.id);
			if (note && (note.archived ?? false) === archived) {
				reordered.push(note);
				usedIds.add(note.id);
			}
			continue;
		}

		const children = folderChildOrder.get(item.id) ?? [];
		for (const noteId of children) {
			if (usedIds.has(noteId)) continue;
			const note = notesById.get(noteId);
			if (note && (note.archived ?? false) === archived) {
				reordered.push(note);
				usedIds.add(note.id);
			}
		}
	}

	for (const [, children] of folderChildOrder) {
		for (const noteId of children) {
			if (usedIds.has(noteId)) continue;
			const note = notesById.get(noteId);
			if (note && (note.archived ?? false) === archived) {
				reordered.push(note);
				usedIds.add(note.id);
			}
		}
	}

	const others = list.notes.filter((note) => !usedIds.has(note.id));
	list.notes = [...reordered, ...others];
}
