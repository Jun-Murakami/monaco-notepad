import type { Note, NoteList, NoteMetadata } from '@/services/sync/types';

/** テストでよく使うノート生成ヘルパー。 */
export function makeNote(overrides: Partial<Note> = {}): Note {
	const id = overrides.id ?? `note-${Math.random().toString(36).slice(2, 10)}`;
	const content = overrides.content ?? 'hello';
	return {
		id,
		title: overrides.title ?? `Title ${id}`,
		content,
		contentHeader: overrides.contentHeader ?? content.slice(0, 100),
		language: overrides.language ?? 'plaintext',
		modifiedTime: overrides.modifiedTime ?? '2026-01-01T00:00:00.000Z',
		archived: overrides.archived ?? false,
		folderId: overrides.folderId ?? '',
	};
}

export function makeMetadata(
	overrides: Partial<NoteMetadata> = {},
): NoteMetadata {
	return {
		id: overrides.id ?? 'm',
		title: overrides.title ?? '',
		contentHeader: overrides.contentHeader ?? '',
		language: overrides.language ?? 'plaintext',
		modifiedTime: overrides.modifiedTime ?? '2026-01-01T00:00:00.000Z',
		archived: overrides.archived ?? false,
		folderId: overrides.folderId ?? '',
		contentHash: overrides.contentHash ?? 'hash',
	};
}

export function makeNoteList(overrides: Partial<NoteList> = {}): NoteList {
	return {
		version: 'v2',
		notes: overrides.notes ?? [],
		folders: overrides.folders ?? [],
		topLevelOrder: overrides.topLevelOrder ?? [],
		archivedTopLevelOrder: overrides.archivedTopLevelOrder ?? [],
		collapsedFolderIds: overrides.collapsedFolderIds ?? [],
	};
}

/** 任意の Date ISO 文字列を作る小ヘルパー。 */
export function iso(offsetMs = 0, base = '2026-01-01T00:00:00.000Z'): string {
	return new Date(Date.parse(base) + offsetMs).toISOString();
}
