import type { NoteList } from '@/services/sync/types';

/**
 * 「ノート 1 件のアーカイブ状態を切り替えた後の NoteList」を即時計算する。
 * UI を実 IO の完了を待たずに即更新するための楽観的更新ヘルパ。
 *
 * - notes 配列のメタデータの archived フラグを切り替える
 * - フォルダ配下のノートでなければ topLevelOrder / archivedTopLevelOrder の
 *   付け替えも行う
 *
 * 戻り値は新しい NoteList オブジェクト (元の入力は触らない)。
 */
export function optimisticToggleNoteArchived(
	list: NoteList,
	noteId: string,
	archived: boolean,
): NoteList {
	const note = list.notes.find((n) => n.id === noteId);
	if (!note) return list;

	const newNotes = list.notes.map((n) =>
		n.id === noteId ? { ...n, archived } : n,
	);

	// フォルダ配下のノートは topLevelOrder に居ないので order 操作は不要
	if (note.folderId) {
		return { ...list, notes: newNotes };
	}

	let newTopLevelOrder = list.topLevelOrder;
	let newArchivedTopLevelOrder = list.archivedTopLevelOrder;

	if (archived) {
		newTopLevelOrder = list.topLevelOrder.filter(
			(i) => !(i.type === 'note' && i.id === noteId),
		);
		if (
			!list.archivedTopLevelOrder.some(
				(i) => i.type === 'note' && i.id === noteId,
			)
		) {
			newArchivedTopLevelOrder = [
				...list.archivedTopLevelOrder,
				{ type: 'note', id: noteId },
			];
		}
	} else {
		newArchivedTopLevelOrder = list.archivedTopLevelOrder.filter(
			(i) => !(i.type === 'note' && i.id === noteId),
		);
		if (!list.topLevelOrder.some((i) => i.type === 'note' && i.id === noteId)) {
			newTopLevelOrder = [...list.topLevelOrder, { type: 'note', id: noteId }];
		}
	}

	return {
		...list,
		notes: newNotes,
		topLevelOrder: newTopLevelOrder,
		archivedTopLevelOrder: newArchivedTopLevelOrder,
	};
}

/**
 * 「ノート 1 件を完全削除した後の NoteList」を即時計算する。
 * notes 配列・両方の order からエントリを除去するだけ。
 */
export function optimisticDeleteNote(list: NoteList, noteId: string): NoteList {
	return {
		...list,
		notes: list.notes.filter((n) => n.id !== noteId),
		topLevelOrder: list.topLevelOrder.filter(
			(i) => !(i.type === 'note' && i.id === noteId),
		),
		archivedTopLevelOrder: list.archivedTopLevelOrder.filter(
			(i) => !(i.type === 'note' && i.id === noteId),
		),
	};
}
