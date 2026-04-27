import { describe, expect, it } from 'vitest';
import type {
	Folder,
	NoteList,
	NoteMetadata,
	TopLevelItem,
} from '@/services/sync/types';
import {
	applyReorder,
	type FlatRow,
	flattenNoteList,
	moveNoteToFolder,
} from '../flatTree';

function meta(
	id: string,
	overrides: Partial<NoteMetadata> = {},
): NoteMetadata {
	return {
		id,
		title: overrides.title ?? id,
		contentHeader: overrides.contentHeader ?? '',
		language: overrides.language ?? 'plaintext',
		modifiedTime: overrides.modifiedTime ?? '2026-01-01T00:00:00.000Z',
		archived: overrides.archived ?? false,
		folderId: overrides.folderId ?? '',
		contentHash: overrides.contentHash ?? `hash-${id}`,
	};
}

function folder(id: string, name = id, archived = false): Folder {
	return { id, name, archived };
}

function buildList(
	notes: NoteMetadata[],
	folders: Folder[],
	topLevelOrder: TopLevelItem[],
	collapsedFolderIds: string[] = [],
): NoteList {
	return {
		version: 'v2',
		notes,
		folders,
		topLevelOrder,
		archivedTopLevelOrder: [],
		collapsedFolderIds,
	};
}

describe('flattenNoteList', () => {
	it('トップレベルのノートを順序通りに出す', () => {
		const list = buildList(
			[meta('a'), meta('b'), meta('c')],
			[],
			[
				{ type: 'note', id: 'a' },
				{ type: 'note', id: 'b' },
				{ type: 'note', id: 'c' },
			],
		);
		const rows = flattenNoteList(list);
		expect(rows.map((r) => r.kind)).toEqual([
			'topLevel-note',
			'topLevel-note',
			'topLevel-note',
		]);
		expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
	});

	it('フォルダと配下ノート（展開）を順序通りに展開する', () => {
		const list = buildList(
			[meta('a'), meta('n1', { folderId: 'f1' }), meta('n2', { folderId: 'f1' })],
			[folder('f1', 'Work')],
			[
				{ type: 'note', id: 'a' },
				{ type: 'folder', id: 'f1' },
			],
		);
		const rows = flattenNoteList(list);
		expect(rows.map((r) => `${r.kind}:${r.id}`)).toEqual([
			'topLevel-note:a',
			'folder-header:f1',
			'folder-child:n1',
			'folder-child:n2',
		]);
	});

	it('折りたたみフォルダの子は出さない', () => {
		const list = buildList(
			[meta('n1', { folderId: 'f1' })],
			[folder('f1')],
			[{ type: 'folder', id: 'f1' }],
			['f1'],
		);
		const rows = flattenNoteList(list);
		expect(rows.map((r) => r.kind)).toEqual(['folder-header']);
		const header = rows[0];
		if (header.kind !== 'folder-header') throw new Error('expected header');
		expect(header.collapsed).toBe(true);
		expect(header.noteCount).toBe(1); // 子はカウントには含まれる
	});

	it('archived=true のビューはアクティブノートを出さない', () => {
		const list = buildList(
			[meta('a', { archived: false }), meta('b', { archived: true })],
			[],
			[{ type: 'note', id: 'a' }],
		);
		list.archivedTopLevelOrder = [{ type: 'note', id: 'b' }];
		const rows = flattenNoteList(list, { archived: true });
		expect(rows.map((r) => r.id)).toEqual(['b']);
	});

	it('inGroupEnd は最後の子だけ true', () => {
		const list = buildList(
			[meta('n1', { folderId: 'f1' }), meta('n2', { folderId: 'f1' })],
			[folder('f1')],
			[{ type: 'folder', id: 'f1' }],
		);
		const rows = flattenNoteList(list);
		const children = rows.filter((r) => r.kind === 'folder-child');
		expect(children).toHaveLength(2);
		// type narrow
		const c0 = children[0] as Extract<FlatRow, { kind: 'folder-child' }>;
		const c1 = children[1] as Extract<FlatRow, { kind: 'folder-child' }>;
		expect(c0.inGroupEnd).toBe(false);
		expect(c1.inGroupEnd).toBe(true);
	});

	// ★ desktop が `archived,omitempty` で false を省略した JSON を mobile が読み込むと
	// folder.archived は undefined になる。`folder.archived !== false` が true 評価され
	// すべての通常フォルダがスキップされ、配下ノートも非表示になる現象を再現する。
	it('folder.archived が undefined (desktop の omitempty 由来) でも非アーカイブビューに表示される', () => {
		const f1 = { id: 'f1', name: 'Project A' } as unknown as Folder; // archived 欠落
		const list = buildList(
			[
				meta('n1', { folderId: 'f1' }),
				meta('n2', { folderId: 'f1' }),
				meta('top', { folderId: '' }),
			],
			[f1],
			[
				{ type: 'folder', id: 'f1' },
				{ type: 'note', id: 'top' },
			],
		);
		const rows = flattenNoteList(list, { archived: false });
		const kinds = rows.map((r) => r.kind);
		// folder-header が出ていること、folder-child も出ていること
		expect(kinds).toContain('folder-header');
		expect(kinds).toContain('folder-child');
		expect(kinds).toContain('topLevel-note');
	});

	it('topLevelOrder に無いノート/フォルダはフォールバックで末尾に出す', () => {
		const list = buildList(
			[meta('a'), meta('b')],
			[folder('f1')],
			[],
			[],
		);
		const rows = flattenNoteList(list);
		// 順序は問わないが、両方含まれる
		const ids = rows.map((r) => `${r.kind}:${r.id}`);
		expect(ids).toContain('topLevel-note:a');
		expect(ids).toContain('topLevel-note:b');
		expect(ids).toContain('folder-header:f1');
	});
});

describe('applyReorder', () => {
	it('トップレベル内の単純な並べ替え', () => {
		const list = buildList(
			[meta('a'), meta('b'), meta('c')],
			[],
			[
				{ type: 'note', id: 'a' },
				{ type: 'note', id: 'b' },
				{ type: 'note', id: 'c' },
			],
		);
		const original = flattenNoteList(list);
		// b を先頭に
		const reordered: FlatRow[] = [original[1], original[0], original[2]];
		const { list: result, movedNoteIds } = applyReorder(list, reordered);

		expect(result.topLevelOrder.map((i) => i.id)).toEqual(['b', 'a', 'c']);
		// folderId 変更は無いので movedNoteIds は空
		expect(movedNoteIds).toEqual([]);
		// notes 配列も並び替え順に
		expect(result.notes.map((n) => n.id)).toEqual(['b', 'a', 'c']);
	});

	it('フォルダ内のノートの並べ替え', () => {
		const list = buildList(
			[meta('n1', { folderId: 'f1' }), meta('n2', { folderId: 'f1' })],
			[folder('f1')],
			[{ type: 'folder', id: 'f1' }],
		);
		const rows = flattenNoteList(list);
		// header, child(n1), child(n2) の順 → header, child(n2), child(n1) に
		const newRows: FlatRow[] = [rows[0], rows[2], rows[1]];
		const { list: result, movedNoteIds } = applyReorder(list, newRows);

		expect(movedNoteIds).toEqual([]); // どちらも folderId は変わらない
		// notes 配列で folderId='f1' の順序が n2 → n1 に
		const f1Notes = result.notes
			.filter((n) => n.folderId === 'f1')
			.map((n) => n.id);
		expect(f1Notes).toEqual(['n2', 'n1']);
	});

	it('DnD では folderId は変わらない（kind を不変として扱う）', () => {
		const list = buildList(
			[meta('a'), meta('n1', { folderId: 'f1' })],
			[folder('f1')],
			[
				{ type: 'note', id: 'a' },
				{ type: 'folder', id: 'f1' },
			],
		);
		const rows = flattenNoteList(list);
		// 元: [topLevel(a), folder(f1), child(n1)]
		// 新: [topLevel(a), child(n1), folder(f1)] — child を視覚的にフォルダの外へ
		const newRows: FlatRow[] = [rows[0], rows[2], rows[1]];
		const { list: result, movedNoteIds } = applyReorder(list, newRows);

		// folderId は変わらない（クロスフォルダ移動はメニュー経由のみ）
		expect(movedNoteIds).toEqual([]);
		expect(result.notes.find((n) => n.id === 'n1')?.folderId).toBe('f1');
		// top-level はそのまま：a, folder f1
		expect(result.topLevelOrder.map((i) => `${i.type}:${i.id}`)).toEqual([
			'note:a',
			'folder:f1',
		]);
	});

	it('top-level note を展開フォルダの内部視覚位置にドロップしても folder には入らない', () => {
		const list = buildList(
			[meta('a'), meta('n1', { folderId: 'f1' })],
			[folder('f1')],
			[
				{ type: 'note', id: 'a' },
				{ type: 'folder', id: 'f1' },
			],
		);
		const rows = flattenNoteList(list);
		// 新: [folder(f1), topLevel-note(a), child(n1)]
		const newRows: FlatRow[] = [rows[1], rows[0], rows[2]];
		const { list: result } = applyReorder(list, newRows);

		// a は依然として top-level
		expect(result.notes.find((n) => n.id === 'a')?.folderId).toBe('');
		expect(result.topLevelOrder).toEqual([
			{ type: 'folder', id: 'f1' },
			{ type: 'note', id: 'a' },
		]);
	});

	it('折りたたみフォルダ直下にドロップしてもトップレベル扱い', () => {
		const list = buildList(
			[meta('a')],
			[folder('f1')],
			[
				{ type: 'folder', id: 'f1' },
				{ type: 'note', id: 'a' },
			],
			['f1'], // f1 collapsed
		);
		const rows = flattenNoteList(list);
		const { list: result } = applyReorder(list, rows);
		expect(result.notes.find((n) => n.id === 'a')?.folderId).toBe('');
	});

	it('archived ビューでも同じロジックが効く', () => {
		const list = buildList(
			[meta('a', { archived: true }), meta('b', { archived: true })],
			[],
			[],
		);
		list.archivedTopLevelOrder = [
			{ type: 'note', id: 'a' },
			{ type: 'note', id: 'b' },
		];
		const rows = flattenNoteList(list, { archived: true });
		// b を前に
		const newRows: FlatRow[] = [rows[1], rows[0]];
		const { list: result } = applyReorder(list, newRows, { archived: true });
		expect(result.archivedTopLevelOrder.map((i) => i.id)).toEqual(['b', 'a']);
		// アクティブ topLevelOrder は影響を受けない
		expect(result.topLevelOrder).toEqual([]);
	});
});

describe('moveNoteToFolder', () => {
	it('トップレベル → フォルダ', () => {
		const list = buildList(
			[meta('a')],
			[folder('f1')],
			[
				{ type: 'note', id: 'a' },
				{ type: 'folder', id: 'f1' },
			],
		);
		const next = moveNoteToFolder(list, 'a', 'f1');
		expect(next.notes.find((n) => n.id === 'a')?.folderId).toBe('f1');
		// topLevelOrder からは外れる
		expect(
			next.topLevelOrder.some((i) => i.type === 'note' && i.id === 'a'),
		).toBe(false);
	});

	it('フォルダ → トップレベル', () => {
		const list = buildList(
			[meta('n1', { folderId: 'f1' })],
			[folder('f1')],
			[{ type: 'folder', id: 'f1' }],
		);
		const next = moveNoteToFolder(list, 'n1', '');
		expect(next.notes.find((n) => n.id === 'n1')?.folderId).toBe('');
		expect(next.topLevelOrder).toContainEqual({ type: 'note', id: 'n1' });
	});

	it('別フォルダへ移動', () => {
		const list = buildList(
			[meta('n1', { folderId: 'f1' })],
			[folder('f1'), folder('f2')],
			[
				{ type: 'folder', id: 'f1' },
				{ type: 'folder', id: 'f2' },
			],
		);
		const next = moveNoteToFolder(list, 'n1', 'f2');
		expect(next.notes.find((n) => n.id === 'n1')?.folderId).toBe('f2');
	});

	it('同じフォルダへの移動は no-op（参照は新しいが同じ内容）', () => {
		const list = buildList(
			[meta('n1', { folderId: 'f1' })],
			[folder('f1')],
			[{ type: 'folder', id: 'f1' }],
		);
		const next = moveNoteToFolder(list, 'n1', 'f1');
		expect(next.notes.find((n) => n.id === 'n1')?.folderId).toBe('f1');
		expect(next.topLevelOrder).toEqual([{ type: 'folder', id: 'f1' }]);
	});

	it('存在しない note ID は変更なし', () => {
		const list = buildList([meta('a')], [], [{ type: 'note', id: 'a' }]);
		const next = moveNoteToFolder(list, 'missing', 'f1');
		expect(next).toEqual(list);
	});
});

describe('flatten → reorder → flatten round-trip', () => {
	it('変更なしなら同じ flat 配列が返る', () => {
		const list = buildList(
			[meta('a'), meta('n1', { folderId: 'f1' }), meta('n2', { folderId: 'f1' })],
			[folder('f1')],
			[
				{ type: 'note', id: 'a' },
				{ type: 'folder', id: 'f1' },
			],
		);
		const r1 = flattenNoteList(list);
		const { list: applied } = applyReorder(list, r1);
		const r2 = flattenNoteList(applied);
		expect(r1.map((r) => `${r.kind}:${r.id}`)).toEqual(
			r2.map((r) => `${r.kind}:${r.id}`),
		);
	});
});
