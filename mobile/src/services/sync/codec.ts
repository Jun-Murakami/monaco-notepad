import { isSafeNoteId } from '../storage/paths';
import type { Note, NoteList } from './types';

/**
 * Drive 上の JSON（noteList_v2.json / notes/<id>.json）とドメイン型の相互変換。
 * デスクトップ版が書いた形式（Go の omitempty・collapsedFolderIDs）も読めること。
 */

/** ノート本体の JSON。folderId は noteList が正なので読み手は無視する（書き手は現在値を入れる）。 */
/**
 * Drive に置くノート本体。parentVersion は、この書き込みが置き換える Drive の版番号
 * （= 書いた端末が見ていた版）。他端末が「自分の版が見ずに上書きされたか」を判定し、その版をバックアップに残すのに使う
 * （docs/sync-engine-v3.md §6）。新規作成では付けない。
 */
export function serializeNote(note: Note, parentVersion?: number): string {
	const { syncing: _s, ...persist } = note;
	return JSON.stringify(
		parentVersion && parentVersion > 0
			? { ...persist, syncParentVersion: parentVersion }
			: persist,
	);
}

/** Drive から落としたノート本体と、書いた端末が見ていた版番号（旧クライアントの書き込みには無い）。 */
export function parseRemoteNote(
	text: string,
): { note: Note; parentVersion?: number } | null {
	const note = parseNote(text);
	if (!note) return null;
	try {
		const raw = (JSON.parse(text) as { syncParentVersion?: unknown })
			.syncParentVersion;
		return typeof raw === 'number' && Number.isInteger(raw) && raw > 0
			? { note, parentVersion: raw }
			: { note };
	} catch {
		return { note };
	}
}

export function parseNote(text: string): Note | null {
	try {
		const parsed = JSON.parse(text) as Partial<Note>;
		if (!parsed.id || typeof parsed.id !== 'string') return null;
		// 同期データ由来の ID はパストラバーサルに悪用されうるため取り込み境界で弾く。
		if (!isSafeNoteId(parsed.id)) return null;
		return {
			id: parsed.id,
			title: parsed.title ?? '',
			content: parsed.content ?? '',
			contentHeader: parsed.contentHeader ?? '',
			language: parsed.language ?? 'plaintext',
			modifiedTime: parsed.modifiedTime ?? '',
			archived: parsed.archived ?? false,
			folderId: '',
		};
	} catch {
		return null;
	}
}

export function serializeNoteList(list: NoteList): string {
	return JSON.stringify(list);
}

/**
 * cloud から落ちてきた noteList を正規化する。
 *
 * 重要: デスクトップ版は Folder/NoteMetadata の `archived` を `omitempty` で書くため、
 * `archived=false` の場合 JSON にキー自体が現れない。collapsedFolderIDs (大文字) /
 * collapsedFolderIds (小文字) の interop もここで吸収する。
 */
export function normalizeNoteList(raw: unknown): NoteList {
	const r = (raw ?? {}) as Record<string, unknown>;
	const notes = (Array.isArray(r.notes) ? r.notes : []) as Array<
		Record<string, unknown>
	>;
	const folders = (Array.isArray(r.folders) ? r.folders : []) as Array<
		Record<string, unknown>
	>;
	const orderOf = (value: unknown): NoteList['topLevelOrder'] =>
		(Array.isArray(value) ? value : [])
			.map((item) => item as Record<string, unknown>)
			.filter(
				(item) => (item.type === 'note' || item.type === 'folder') && item.id,
			)
			.map((item) => ({
				type: item.type as 'note' | 'folder',
				id: String(item.id),
			}));
	const collapsedRaw =
		(r.collapsedFolderIds as unknown) ?? (r.collapsedFolderIDs as unknown);
	const collapsedFolderIds = Array.isArray(collapsedRaw)
		? (collapsedRaw as unknown[]).map(String)
		: [];

	return {
		version: 'v2',
		// 改竄された noteList の不正な ID（パストラバーサル）は取り込み時に除外する。
		notes: notes
			.filter((n) => isSafeNoteId(String(n.id ?? '')))
			.map((n) => ({
				id: String(n.id ?? ''),
				title: String(n.title ?? ''),
				contentHeader: String(n.contentHeader ?? ''),
				language: String(n.language ?? 'plaintext'),
				modifiedTime: String(n.modifiedTime ?? ''),
				archived: Boolean(n.archived ?? false),
				contentHash: String(n.contentHash ?? ''),
				folderId: String(n.folderId ?? ''),
			})),
		folders: folders.map((f) => ({
			id: String(f.id ?? ''),
			name: String(f.name ?? ''),
			archived: Boolean(f.archived ?? false),
		})),
		topLevelOrder: orderOf(r.topLevelOrder),
		archivedTopLevelOrder: orderOf(r.archivedTopLevelOrder),
		collapsedFolderIds,
	};
}

/** noteList の内容比較（version は無視）。 */
export function sameNoteList(a: NoteList, b: NoteList): boolean {
	const { version: _a, ...ra } = a;
	const { version: _b, ...rb } = b;
	return JSON.stringify(ra) === JSON.stringify(rb);
}
