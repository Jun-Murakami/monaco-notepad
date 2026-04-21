import { describe, expect, it } from 'vitest';
import {
	deleteAsync,
	readAsStringAsync,
	readDirectoryAsync,
} from 'expo-file-system';
import { makeNote } from '@/test/helpers';
import { backupLocalNote } from '../conflictBackup';
import { CONFLICT_BACKUP_DIR } from '@/services/storage/paths';

describe('conflictBackup', () => {
	it('cloud_wins バックアップを書き込む', async () => {
		await backupLocalNote('cloud_wins', makeNote({ id: 'a', content: 'local' }));
		const entries = await readDirectoryAsync(CONFLICT_BACKUP_DIR);
		expect(entries.length).toBe(1);
		expect(entries[0]).toMatch(/^cloud_wins_.+_a\.json$/);
		const raw = await readAsStringAsync(`${CONFLICT_BACKUP_DIR}${entries[0]}`);
		expect(JSON.parse(raw).content).toBe('local');
	});

	it('cloud_delete バックアップを書き込む', async () => {
		await backupLocalNote('cloud_delete', makeNote({ id: 'a' }));
		const entries = await readDirectoryAsync(CONFLICT_BACKUP_DIR);
		expect(entries[0]).toMatch(/^cloud_delete_.+_a\.json$/);
	});

	it('100 件を超えたら古いものから削除する', async () => {
		for (let i = 0; i < 105; i++) {
			await backupLocalNote('cloud_wins', makeNote({ id: `n${i}`, content: `v${i}` }));
		}
		const entries = await readDirectoryAsync(CONFLICT_BACKUP_DIR);
		expect(entries.length).toBeLessThanOrEqual(100);
	});

	// クリーンアップは afterEach で行われる
	it('cleanup がテスト間で効く', async () => {
		await deleteAsync(CONFLICT_BACKUP_DIR, { idempotent: true });
	});
});
