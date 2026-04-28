import type { NoteList, TopLevelItem } from '@/services/sync/types';

/**
 * NoteList を deep clone する。注意点:
 *
 * - notes / folders 配列は **同一 id の重複を取り除く** (先勝ち)。万が一 race や
 *   過去ロジックの残滓で重複が混入した場合に、UI 描画 (key 重複) や DnD ロジックが
 *   壊れないようにする防御層。
 * - topLevelOrder / archivedTopLevelOrder も `(type, id)` の組で重複除去する。
 */
export function cloneNoteList(list: NoteList): NoteList {
	const seenNotes = new Set<string>();
	const notes = list.notes
		.filter((n) => {
			if (seenNotes.has(n.id)) return false;
			seenNotes.add(n.id);
			return true;
		})
		.map((note) => ({ ...note }));

	const seenFolders = new Set<string>();
	const folders = list.folders
		.filter((f) => {
			if (seenFolders.has(f.id)) return false;
			seenFolders.add(f.id);
			return true;
		})
		.map((folder) => ({ ...folder }));

	return {
		version: list.version,
		notes,
		folders,
		topLevelOrder: dedupOrder(list.topLevelOrder),
		archivedTopLevelOrder: dedupOrder(list.archivedTopLevelOrder),
		collapsedFolderIds: [...list.collapsedFolderIds],
	};
}

function dedupOrder(order: TopLevelItem[]): TopLevelItem[] {
	const seen = new Set<string>();
	const out: TopLevelItem[] = [];
	for (const item of order) {
		const key = `${item.type}:${item.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ ...item });
	}
	return out;
}
