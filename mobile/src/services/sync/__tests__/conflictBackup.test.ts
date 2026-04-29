import { Directory, File } from 'expo-file-system';
import { describe, expect, it } from 'vitest';
import { CONFLICT_BACKUP_DIR } from '@/services/storage/paths';
import { makeNote } from '@/test/helpers';
import {
	backupLocalNote,
	deleteAllConflictBackups,
	deleteConflictBackup,
	listConflictBackups,
} from '../conflictBackup';

describe('conflictBackup', () => {
	it('cloud_wins バックアップを書き込む', async () => {
		await backupLocalNote(
			'cloud_wins',
			makeNote({ id: 'a', content: 'local' }),
		);
		const entries = new Directory(CONFLICT_BACKUP_DIR)
			.list()
			.map((e) => e.name);
		expect(entries.length).toBe(1);
		expect(entries[0]).toMatch(/^cloud_wins_.+_a\.json$/);
		const raw = await new File(`${CONFLICT_BACKUP_DIR}${entries[0]}`).text();
		expect(JSON.parse(raw).content).toBe('local');
	});

	it('cloud_delete バックアップを書き込む', async () => {
		await backupLocalNote('cloud_delete', makeNote({ id: 'a' }));
		const entries = new Directory(CONFLICT_BACKUP_DIR)
			.list()
			.map((e) => e.name);
		expect(entries[0]).toMatch(/^cloud_delete_.+_a\.json$/);
	});

	it('バックアップを一覧取得して削除できる', async () => {
		await backupLocalNote(
			'cloud_wins',
			makeNote({ id: 'a', content: 'local' }),
		);
		const backups = await listConflictBackups();

		expect(backups).toHaveLength(1);
		expect(backups[0].kind).toBe('cloud_wins');
		expect(backups[0].note.content).toBe('local');

		await deleteConflictBackup(backups[0].filename);
		expect(await listConflictBackups()).toHaveLength(0);
	});

	it('バックアップを全削除できる', async () => {
		await backupLocalNote('cloud_wins', makeNote({ id: 'a' }));
		await backupLocalNote('cloud_delete', makeNote({ id: 'b' }));

		await deleteAllConflictBackups();

		expect(await listConflictBackups()).toHaveLength(0);
	});

	it('100 件を超えたら古いものから削除する', async () => {
		for (let i = 0; i < 105; i++) {
			await backupLocalNote(
				'cloud_wins',
				makeNote({ id: `n${i}`, content: `v${i}` }),
			);
		}
		const entries = new Directory(CONFLICT_BACKUP_DIR)
			.list()
			.map((e) => e.name);
		expect(entries.length).toBeLessThanOrEqual(100);
	});

	// クリーンアップは afterEach で行われる
	it('cleanup がテスト間で効く', async () => {
		const dir = new Directory(CONFLICT_BACKUP_DIR);
		if (dir.exists) dir.delete();
	});
});
