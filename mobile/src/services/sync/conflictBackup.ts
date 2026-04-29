import { Directory, File } from 'expo-file-system';
import { ensureDir, readString, writeAtomic } from '../storage/atomicFile';
import { CONFLICT_BACKUP_DIR } from '../storage/paths';
import type { ConflictBackupKind, Note } from './types';

/**
 * 競合バックアップ。クラウドが勝った場合や削除された場合のローカル版を保存する。
 * 最大 100 件まで保持、古いものから削除。
 */

const MAX_BACKUPS = 100;

export interface ConflictBackupEntry {
	id: string;
	filename: string;
	path: string;
	kind: ConflictBackupKind;
	createdAt: string;
	note: Note;
}

export async function backupLocalNote(
	kind: ConflictBackupKind,
	note: Note,
): Promise<void> {
	await ensureDir(CONFLICT_BACKUP_DIR);
	const ts = new Date().toISOString().replace(/[:.]/g, '');
	const filename = `${kind}_${ts}_${note.id}.json`;
	await writeAtomic(
		`${CONFLICT_BACKUP_DIR}${filename}`,
		JSON.stringify(note, null, 2),
	);
	await trimOld();
}

export async function listConflictBackups(): Promise<ConflictBackupEntry[]> {
	const dir = new Directory(CONFLICT_BACKUP_DIR);
	if (!dir.exists) return [];
	const entries: ConflictBackupEntry[] = [];
	for (const file of dir.list()) {
		if (!(file instanceof File)) continue;
		const parsed = parseBackupFilename(file.name);
		if (!parsed) continue;
		const raw = await readString(`${CONFLICT_BACKUP_DIR}${file.name}`);
		if (!raw) continue;
		try {
			const note = normalizeBackupNote(JSON.parse(raw));
			entries.push({
				id: file.name,
				filename: file.name,
				path: `${CONFLICT_BACKUP_DIR}${file.name}`,
				kind: parsed.kind,
				createdAt: parsed.createdAt,
				note,
			});
		} catch (error) {
			console.warn(
				'[ConflictBackup] failed to parse backup:',
				file.name,
				error,
			);
		}
	}
	entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return entries;
}

export async function readConflictBackup(
	filename: string,
): Promise<ConflictBackupEntry | null> {
	const parsed = parseBackupFilename(filename);
	if (!parsed) return null;
	const raw = await readString(`${CONFLICT_BACKUP_DIR}${filename}`);
	if (!raw) return null;
	const note = normalizeBackupNote(JSON.parse(raw));
	return {
		id: filename,
		filename,
		path: `${CONFLICT_BACKUP_DIR}${filename}`,
		kind: parsed.kind,
		createdAt: parsed.createdAt,
		note,
	};
}

export async function deleteConflictBackup(filename: string): Promise<void> {
	const file = new File(`${CONFLICT_BACKUP_DIR}${filename}`);
	if (file.exists) file.delete();
}

export async function deleteAllConflictBackups(): Promise<void> {
	const dir = new Directory(CONFLICT_BACKUP_DIR);
	if (!dir.exists) return;
	for (const entry of dir.list()) {
		if (entry instanceof File && entry.name.endsWith('.json')) {
			entry.delete();
		}
	}
}

async function trimOld(): Promise<void> {
	const dir = new Directory(CONFLICT_BACKUP_DIR);
	if (!dir.exists) return;
	const files = dir.list().filter((e): e is File => e instanceof File);
	if (files.length <= MAX_BACKUPS) return;
	files.sort((a, b) => a.name.localeCompare(b.name));
	const excess = files.length - MAX_BACKUPS;
	for (let i = 0; i < excess; i++) {
		if (files[i].exists) files[i].delete();
	}
}

function parseBackupFilename(
	filename: string,
): { kind: ConflictBackupKind; createdAt: string } | null {
	const match = filename.match(
		/^(cloud_wins|cloud_delete)_(\d{4}-\d{2}-\d{2}T\d{6}\d{3}Z)_.*\.json$/,
	);
	if (!match) return null;
	const raw = match[2];
	const createdAt = `${raw.slice(0, 13)}:${raw.slice(13, 15)}:${raw.slice(15, 17)}.${raw.slice(17, 20)}Z`;
	return { kind: match[1] as ConflictBackupKind, createdAt };
}

function normalizeBackupNote(raw: Partial<Note>): Note {
	if (!raw.id || typeof raw.id !== 'string') {
		throw new Error('backup note is missing id');
	}
	return {
		id: raw.id,
		title: raw.title ?? '',
		content: raw.content ?? '',
		contentHeader: raw.contentHeader ?? '',
		language: raw.language ?? 'plaintext',
		modifiedTime: raw.modifiedTime ?? new Date().toISOString(),
		archived: raw.archived ?? false,
		folderId: raw.folderId ?? '',
	};
}
