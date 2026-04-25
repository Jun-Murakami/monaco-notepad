import type {
	Folder,
	NoteList,
	NoteMetadata,
	TopLevelItem,
} from '@/services/sync/types';

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
	  };

/**
 * 「アクティブビュー」（archived=false）または「アーカイブビュー」（archived=true）の
 * いずれかを平坦化する。両ビューを同時にレンダーするのは現状サポートしない。
 */
export interface FlattenOptions {
	archived?: boolean;
}

export function flattenNoteList(
	list: NoteList,
	opts: FlattenOptions = {},
): FlatRow[] {
	const archived = opts.archived ?? false;
	const order = archived ? list.archivedTopLevelOrder : list.topLevelOrder;
	const folderById = new Map(list.folders.map((f) => [f.id, f]));
	const collapsedSet = new Set(list.collapsedFolderIds);
	const notesById = new Map(list.notes.map((n) => [n.id, n]));

	// folder ごとの子ノートを `notes` 配列の順序を保ったまま集める。
	const notesByFolder = new Map<string, NoteMetadata[]>();
	for (const n of list.notes) {
		if (n.archived !== archived) continue;
		if (!n.folderId) continue;
		const arr = notesByFolder.get(n.folderId) ?? [];
		arr.push(n);
		notesByFolder.set(n.folderId, arr);
	}

	const out: FlatRow[] = [];
	const seenNotes = new Set<string>();
	const seenFolders = new Set<string>();

	for (const item of order) {
		if (item.type === 'note') {
			const note = notesById.get(item.id);
			if (!note || note.archived !== archived) continue;
			if (note.folderId) continue; // フォルダ配下のノートは folder-child として後で出す
			out.push({
				kind: 'topLevel-note',
				key: `t:${note.id}`,
				id: note.id,
				note,
			});
			seenNotes.add(note.id);
		} else if (item.type === 'folder') {
			const folder = folderById.get(item.id);
			if (!folder || folder.archived !== archived) continue;
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
			if (!isCollapsed) {
				children.forEach((child, idx) => {
					out.push({
						kind: 'folder-child',
						key: `c:${child.id}`,
						id: child.id,
						note: child,
						folderId: folder.id,
						inGroupEnd: idx === children.length - 1,
					});
					seenNotes.add(child.id);
				});
			}
		}
	}

	// topLevelOrder に現れていない要素のフォールバック（データ破損保険）。
	// 過度に挿入すると DnD で順序が壊れるので末尾に最小限追加する。
	for (const folder of list.folders) {
		if (folder.archived !== archived) continue;
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
		if (!isCollapsed) {
			children.forEach((child, idx) => {
				out.push({
					kind: 'folder-child',
					key: `c:${child.id}`,
					id: child.id,
					note: child,
					folderId: folder.id,
					inGroupEnd: idx === children.length - 1,
				});
				seenNotes.add(child.id);
			});
		}
	}
	for (const n of list.notes) {
		if (n.archived !== archived) continue;
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
 * シンプル方針：
 * - **folderId は DnD では変えない**（行の `kind` を不変としてそのまま保つ）。
 *   クロスフォルダ移動は別 UI（長押しメニュー → folder picker）で行う。
 * - top-level の並びと、各フォルダ内の子順序のみ DnD で変える。
 * - フォルダはトップレベル限定（ネストなし）。
 *
 * これによりユーザーの誤操作（ドラッグで意図せず別フォルダに入ってしまう）を防ぐ。
 *
 * 入力 `newRows` は flattenNoteList が返す形（または UI で並び替えた後の同じ形）であること。
 */
export interface ReorderResult {
	list: NoteList;
	/** DnD では folderId を変えないため常に空配列。後方互換のため残す。 */
	movedNoteIds: string[];
}

export function applyReorder(
	original: NoteList,
	newRows: FlatRow[],
	opts: FlattenOptions = {},
): ReorderResult {
	const archived = opts.archived ?? false;
	const list = cloneNoteList(original);
	const orderField = archived ? 'archivedTopLevelOrder' : 'topLevelOrder';

	// 1. newRows を kind 単位で分類する
	const newTopLevelOrder: TopLevelItem[] = [];
	const folderChildOrder = new Map<string, string[]>();
	for (const row of newRows) {
		if (row.kind === 'folder-header') {
			newTopLevelOrder.push({ type: 'folder', id: row.id });
		} else if (row.kind === 'topLevel-note') {
			newTopLevelOrder.push({ type: 'note', id: row.id });
		} else {
			// folder-child
			const arr = folderChildOrder.get(row.folderId) ?? [];
			arr.push(row.id);
			folderChildOrder.set(row.folderId, arr);
		}
	}

	// 2. notes 配列を新順序で並べ替える
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
		const meta = list.notes.find((n) => n.id === item.id);
		if (meta) reordered.push(meta);
	}
	for (const [, ids] of folderChildOrder) {
		for (const id of ids) {
			const meta = list.notes.find((n) => n.id === id);
			if (meta) reordered.push(meta);
		}
	}
	const others = list.notes.filter((n) => !inViewIds.has(n.id));
	list.notes = [...reordered, ...others];

	list[orderField] = newTopLevelOrder;
	return { list, movedNoteIds: [] };
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

function cloneNoteList(list: NoteList): NoteList {
	return JSON.parse(JSON.stringify(list)) as NoteList;
}
