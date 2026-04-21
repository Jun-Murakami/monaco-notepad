import * as FileSystem from 'expo-file-system';
import { ensureDir, writeAtomic } from '../storage/atomicFile';
import { CONFLICT_BACKUP_DIR } from '../storage/paths';
import type { ConflictBackupKind, Note } from './types';

/**
 * 競合バックアップ。クラウドが勝った場合や削除された場合のローカル版を保存する。
 * 最大 100 件まで保持、古いものから削除。
 */

const MAX_BACKUPS = 100;

export async function backupLocalNote(
	kind: ConflictBackupKind,
	note: Note,
): Promise<void> {
	await ensureDir(CONFLICT_BACKUP_DIR);
	const ts = new Date().toISOString().replace(/[:.]/g, '');
	const filename = `${kind}_${ts}_${note.id}.json`;
	await writeAtomic(`${CONFLICT_BACKUP_DIR}${filename}`, JSON.stringify(note, null, 2));
	await trimOld();
}

async function trimOld(): Promise<void> {
	const info = await FileSystem.getInfoAsync(CONFLICT_BACKUP_DIR);
	if (!info.exists) return;
	const names = await FileSystem.readDirectoryAsync(CONFLICT_BACKUP_DIR);
	if (names.length <= MAX_BACKUPS) return;
	names.sort();
	const excess = names.length - MAX_BACKUPS;
	for (let i = 0; i < excess; i++) {
		await FileSystem.deleteAsync(`${CONFLICT_BACKUP_DIR}${names[i]}`, { idempotent: true });
	}
}
