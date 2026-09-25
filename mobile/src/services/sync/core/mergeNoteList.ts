import type { Folder, NoteList, NoteMetadata, TopLevelItem } from '../types';
import { isModifiedTimeAfter } from './decideNote';
import { mergeSequence } from './mergeSequence';

/**
 * 構造（フォルダ・所属・並び順・折りたたみ）の 3-way マージ（docs/sync-engine-v3.md §7）。純粋関数。
 *
 * `notes` はマージ後に存在するノートの最終メタ（本文由来）。folderId と各系列の位置はここで決める。
 * base が null（移行直後など）のときは「両側にある項目はローカルでは変更されていない」とみなす。
 *
 * Go 版 backend/sync_core.go の mergeNoteList と完全一致させること（共有ベクターで検証）。
 */

export type FinalNoteMeta = Omit<NoteMetadata, 'folderId'>;

export interface MergeNoteListInput {
	base: NoteList | null;
	local: NoteList;
	remote: NoteList | null;
	notes: FinalNoteMeta[];
}

export function mergeNoteList(input: MergeNoteListInput): NoteList {
	const { base, local } = input;
	const remote = input.remote ?? emptyNoteList();

	const finals: FinalNoteMeta[] = [];
	const finalById = new Map<string, FinalNoteMeta>();
	for (const n of input.notes) {
		if (finalById.has(n.id)) continue;
		finalById.set(n.id, n);
		finals.push(n);
	}

	// ---- フォルダ（候補と属性） ----
	const baseFolders = byId(base?.folders ?? []);
	const localFolders = byId(local.folders);
	const remoteFolders = byId(remote.folders);
	const baseFolderOf = (id: string): Folder | undefined => {
		if (base) return baseFolders.get(id);
		return remoteFolders.has(id) ? localFolders.get(id) : undefined;
	};

	const candidateIds = uniqueStrings([
		...remote.folders.map((f) => f.id),
		...local.folders.map((f) => f.id),
		...(base?.folders ?? []).map((f) => f.id),
	]);
	const candidates: Array<{ folder: Folder; present: boolean }> = [];
	for (const id of candidateIds) {
		const b = baseFolderOf(id);
		const l = localFolders.get(id);
		const r = remoteFolders.get(id);
		const folder: Folder = {
			id,
			name: pick3(b?.name, l?.name, r?.name) ?? '',
			archived: pick3(b?.archived, l?.archived, r?.archived) ?? false,
		};
		let present: boolean;
		if (l && r) {
			present = true;
		} else if (l) {
			present = !b || l.name !== b.name || l.archived !== b.archived;
		} else if (r) {
			present = !b;
		} else {
			present = false;
		}
		candidates.push({ folder, present });
	}

	// ---- ノートの所属 ----
	const baseNotes = byId(base?.notes ?? []);
	const localNotes = byId(local.notes);
	const remoteNotes = byId(remote.notes);
	const folderIdOf = new Map<string, string>();
	for (const n of finals) {
		const l = localNotes.get(n.id)?.folderId;
		const r = remoteNotes.get(n.id)?.folderId;
		const b = base ? baseNotes.get(n.id)?.folderId : l;
		const chosen =
			l !== undefined && (b === undefined || l !== b) ? l : (r ?? l ?? b ?? '');
		folderIdOf.set(n.id, chosen);
	}

	// 最終ノートが所属しているフォルダは復活させる（編集は削除に勝つ）
	const referenced = new Set(
		[...folderIdOf.values()].filter((id) => id !== ''),
	);
	const folders = candidates
		.filter((c) => c.present || referenced.has(c.folder.id))
		.map((c) => c.folder);
	const folderById = byId(folders);

	for (const n of finals) {
		let fid = folderIdOf.get(n.id) ?? '';
		const folder = fid ? folderById.get(fid) : undefined;
		if (fid && !folder) fid = '';
		if (fid && n.archived && folder && !folder.archived) fid = '';
		folderIdOf.set(n.id, fid);
	}

	// ---- notes 配列（フォルダ内の表示順） ----
	const noteSeq = mergeSequence(
		base ? base.notes.map((n) => n.id) : null,
		local.notes.map((n) => n.id),
		remote.notes.map((n) => n.id),
	).filter((id) => finalById.has(id));
	const placedNotes = new Set(noteSeq);
	const noteIds = [
		...sortNewestFirst(finals.filter((n) => !placedNotes.has(n.id))).map(
			(n) => n.id,
		),
		...noteSeq,
	];
	const notes: NoteMetadata[] = noteIds.map((id) => ({
		...(finalById.get(id) as FinalNoteMeta),
		folderId: folderIdOf.get(id) ?? '',
	}));

	// ---- トップレベル順序（アクティブ / アーカイブ） ----
	const buildOrder = (
		archived: boolean,
		pick: (l: NoteList) => TopLevelItem[],
	) => {
		const isValid = (key: string): boolean => {
			const { type, id } = fromKey(key);
			if (type === 'folder') {
				const f = folderById.get(id);
				return !!f && f.archived === archived;
			}
			const n = finalById.get(id);
			return (
				!!n && n.archived === archived && (folderIdOf.get(id) ?? '') === ''
			);
		};
		const merged = mergeSequence(
			base ? pick(base).map(toKey) : null,
			pick(local).map(toKey),
			pick(remote).map(toKey),
		).filter(isValid);
		const placed = new Set(merged);
		const missingFolders = folders
			.filter((f) => f.archived === archived && !placed.has(`f:${f.id}`))
			.map((f) => f.id)
			.sort(compareStrings)
			.map((id) => `f:${id}`);
		const missingNotes = sortNewestFirst(
			finals.filter(
				(n) =>
					n.archived === archived &&
					(folderIdOf.get(n.id) ?? '') === '' &&
					!placed.has(`n:${n.id}`),
			),
		).map((n) => `n:${n.id}`);
		return [...missingFolders, ...missingNotes, ...merged].map(fromKey);
	};
	const topLevelOrder = buildOrder(false, (l) => l.topLevelOrder);
	const archivedTopLevelOrder = buildOrder(
		true,
		(l) => l.archivedTopLevelOrder,
	);

	// ---- 折りたたみ状態（集合の 3-way） ----
	const localCollapsed = uniqueStrings(local.collapsedFolderIds);
	const remoteCollapsed = uniqueStrings(remote.collapsedFolderIds);
	const baseCollapsed = new Set(
		base
			? base.collapsedFolderIds
			: localCollapsed.filter((id) => remoteCollapsed.includes(id)),
	);
	const localSet = new Set(localCollapsed);
	const removedLocally = new Set(
		[...baseCollapsed].filter((id) => !localSet.has(id)),
	);
	const collapsedFolderIds = uniqueStrings([
		...remoteCollapsed.filter((id) => !removedLocally.has(id)),
		...localCollapsed.filter((id) => !baseCollapsed.has(id)),
	]).filter((id) => folderById.has(id));

	return {
		version: 'v2',
		notes,
		folders,
		topLevelOrder,
		archivedTopLevelOrder,
		collapsedFolderIds,
	};
}

export function emptyNoteList(): NoteList {
	return {
		version: 'v2',
		notes: [],
		folders: [],
		topLevelOrder: [],
		archivedTopLevelOrder: [],
		collapsedFolderIds: [],
	};
}

/** local が base から変わっていれば local、そうでなければ remote（無ければ local → base）。 */
function pick3<T>(
	b: T | undefined,
	l: T | undefined,
	r: T | undefined,
): T | undefined {
	if (l !== undefined && (b === undefined || l !== b)) return l;
	return r ?? l ?? b;
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
	const map = new Map<string, T>();
	for (const item of items) {
		if (!map.has(item.id)) map.set(item.id, item);
	}
	return map;
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function toKey(item: TopLevelItem): string {
	return `${item.type === 'folder' ? 'f' : 'n'}:${item.id}`;
}

function fromKey(key: string): TopLevelItem {
	return { type: key.startsWith('f:') ? 'folder' : 'note', id: key.slice(2) };
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** modifiedTime の新しい順、同時刻は id 昇順。 */
function sortNewestFirst<T extends { id: string; modifiedTime: string }>(
	items: T[],
): T[] {
	return [...items].sort((a, b) => {
		if (isModifiedTimeAfter(a.modifiedTime, b.modifiedTime)) return -1;
		if (isModifiedTimeAfter(b.modifiedTime, a.modifiedTime)) return 1;
		return compareStrings(a.id, b.id);
	});
}
