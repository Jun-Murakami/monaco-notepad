import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeContentHash } from '../../hash';
import type {
	Folder,
	Note,
	NoteList,
	NoteMetadata,
	TopLevelItem,
} from '../../types';
import { type DecideNoteInput, decideNote } from '../decideNote';
import { type FinalNoteMeta, mergeNoteList } from '../mergeNoteList';
import { mergeSequence } from '../mergeSequence';

/**
 * 共有仕様ベクター（sync-spec/vectors/*.json）の検証。
 * 同じファイルを Go 側（backend/sync_core_vectors_test.go）も読み、両実装の出力一致を保証する。
 */

// リポジトリ直下の sync-spec/vectors（実行ディレクトリに依存しないよう、このファイル基準で解決）
const VECTOR_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../../../../sync-spec/vectors',
);

function loadVectors<T>(name: string): T {
	return JSON.parse(readFileSync(path.join(VECTOR_DIR, name), 'utf8')) as T;
}

// ---- ベクター形式 → ドメイン型 ----

interface VNoteMeta {
	id: string;
	title?: string;
	contentHeader?: string;
	language?: string;
	modifiedTime?: string;
	archived?: boolean;
	contentHash?: string;
	folderId?: string;
}

interface VFolder {
	id: string;
	name?: string;
	archived?: boolean;
}

interface VNoteList {
	notes?: VNoteMeta[];
	folders?: VFolder[];
	topLevelOrder?: string[];
	archivedTopLevelOrder?: string[];
	collapsedFolderIds?: string[];
}

function toMeta(v: VNoteMeta): NoteMetadata {
	return {
		id: v.id,
		title: v.title ?? '',
		contentHeader: v.contentHeader ?? '',
		language: v.language ?? '',
		modifiedTime: v.modifiedTime ?? '',
		archived: v.archived ?? false,
		contentHash: v.contentHash ?? '',
		folderId: v.folderId ?? '',
	};
}

function toFolder(v: VFolder): Folder {
	return { id: v.id, name: v.name ?? '', archived: v.archived ?? false };
}

function toItem(key: string): TopLevelItem {
	const [prefix, ...rest] = key.split(':');
	return { type: prefix === 'f' ? 'folder' : 'note', id: rest.join(':') };
}

function toList(v: VNoteList): NoteList {
	return {
		version: 'v2',
		notes: (v.notes ?? []).map(toMeta),
		folders: (v.folders ?? []).map(toFolder),
		topLevelOrder: (v.topLevelOrder ?? []).map(toItem),
		archivedTopLevelOrder: (v.archivedTopLevelOrder ?? []).map(toItem),
		collapsedFolderIds: v.collapsedFolderIds ?? [],
	};
}

function toFinal(v: VNoteMeta): FinalNoteMeta {
	const { folderId: _f, ...rest } = toMeta(v);
	return rest;
}

// ---- テスト ----

describe('sync-spec: content-hash', () => {
	const { cases } = loadVectors<{
		cases: Array<{
			name: string;
			note: Omit<Note, 'contentHeader' | 'modifiedTime' | 'folderId'>;
			expected: string;
		}>;
	}>('content-hash.json');
	it.each(cases)('$name', async ({ note, expected }) => {
		const hash = await computeContentHash({
			...note,
			contentHeader: 'ignored',
			modifiedTime: '2026-01-01T00:00:00Z',
			folderId: 'ignored',
		});
		expect(hash).toBe(expected);
	});
});

describe('sync-spec: merge-sequence', () => {
	const { cases } = loadVectors<{
		cases: Array<{
			name: string;
			base: string[] | null;
			local: string[];
			remote: string[];
			expected: string[];
		}>;
	}>('merge-sequence.json');
	it.each(cases)('$name', ({ base, local, remote, expected }) => {
		expect(mergeSequence(base, local, remote)).toEqual(expected);
	});
});

describe('sync-spec: decide-note', () => {
	const { cases } = loadVectors<{
		cases: Array<{
			name: string;
			input: DecideNoteInput;
			expected: { kind: string; backupLocal?: boolean };
		}>;
	}>('decide-note.json');
	it.each(cases)('$name', ({ input, expected }) => {
		const decision = decideNote(input);
		expect(decision.kind).toBe(expected.kind);
		if (expected.kind === 'applyRemote' || expected.kind === 'deleteLocal') {
			expect(decision).toMatchObject({ backupLocal: expected.backupLocal });
		}
	});
});

describe('sync-spec: merge-notelist', () => {
	const { cases } = loadVectors<{
		cases: Array<{
			name: string;
			base: VNoteList | null;
			local: VNoteList;
			remote: VNoteList | null;
			notes: VNoteMeta[];
			expected: VNoteList;
		}>;
	}>('merge-notelist.json');
	it.each(cases)('$name', ({ base, local, remote, notes, expected }) => {
		const finals = notes.map(toFinal);
		const byId = new Map(finals.map((n) => [n.id, n]));
		const merged = mergeNoteList({
			base: base ? toList(base) : null,
			local: toList(local),
			remote: remote ? toList(remote) : null,
			notes: finals,
		});
		const want = toList(expected);
		want.notes = (expected.notes ?? []).map((n) => {
			const final = byId.get(n.id);
			if (!final) throw new Error(`vector error: ${n.id} not in notes`);
			return { ...final, folderId: n.folderId ?? '' };
		});
		const { version: _v1, ...got } = merged;
		const { version: _v2, ...exp } = want;
		expect(got).toEqual(exp);
	});
});
