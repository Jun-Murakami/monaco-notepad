import type { FlatRow } from '@/utils/flatTree';

/**
 * 検索ヒット ID セットで FlatRow 配列を絞り込む。
 *
 * - top-level note: ID が一致したら残す
 * - folder-header: 配下に一致する子があるフォルダだけ残す。表示は強制 expanded、
 *   noteCount は 「ヒット件数」に差し替え。
 * - folder-child: ID が一致したら残す。`parentCollapsed` は強制 false にして
 *   折り畳まれているフォルダの中の hit も見えるようにする。
 *
 * `matchingIds` が null の場合 (検索 inactive) は元の rows をそのまま返す。
 */
export function filterRowsBySearch(
	rows: FlatRow[],
	matchingIds: Set<string> | null,
): FlatRow[] {
	if (!matchingIds) return rows;

	const folderMatchCount = new Map<string, number>();
	for (const row of rows) {
		if (row.kind === 'folder-child' && matchingIds.has(row.id)) {
			folderMatchCount.set(
				row.folderId,
				(folderMatchCount.get(row.folderId) ?? 0) + 1,
			);
		}
	}

	const result: FlatRow[] = [];
	for (const row of rows) {
		if (row.kind === 'topLevel-note') {
			if (matchingIds.has(row.id)) result.push(row);
		} else if (row.kind === 'folder-header') {
			const count = folderMatchCount.get(row.id) ?? 0;
			if (count > 0) {
				result.push({
					...row,
					collapsed: false,
					noteCount: count,
				});
			}
		} else if (row.kind === 'folder-child') {
			if (matchingIds.has(row.id)) {
				result.push({
					...row,
					parentCollapsed: false,
				});
			}
		}
	}
	return result;
}
