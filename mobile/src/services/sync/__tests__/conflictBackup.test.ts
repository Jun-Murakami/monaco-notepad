import { Directory, File } from 'expo-file-system';
import { describe, expect, it, vi } from 'vitest';
import { ensureDir, writeAtomic } from '@/services/storage/atomicFile';
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

	it('local_wins（負けた他端末の版）のバックアップも一覧に出る', async () => {
		await backupLocalNote(
			'local_wins',
			makeNote({ id: 'a', content: 'other device version' }),
		);
		const backups = await listConflictBackups();
		expect(backups).toHaveLength(1);
		expect(backups[0].kind).toBe('local_wins');
		expect(backups[0].note.content).toBe('other device version');
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

	it('上限を超えたら種類に関係なく古い順に削除する（新しいバックアップを消さない）', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const start = Date.parse('2026-01-01T00:00:00.000Z');
			for (let i = 0; i < 100; i++) {
				vi.setSystemTime(start + i * 60_000);
				await backupLocalNote('local_wins', makeNote({ id: `old${i}` }));
			}
			vi.setSystemTime(Date.parse('2026-09-01T00:00:00.000Z'));
			await backupLocalNote(
				'cloud_delete',
				makeNote({ id: 'latest', content: 'just lost' }),
			);
		} finally {
			vi.useRealTimers();
		}

		const backups = await listConflictBackups();
		expect(backups).toHaveLength(100);
		expect(backups[0].note.id).toBe('latest');
		const ids = new Set(backups.map((b) => b.note.id));
		expect(ids.has('old0')).toBe(false); // 最古が消える
		expect(ids.has('old1')).toBe(true);
	});

	it('バックアップ以外のファイルは上限の計算にも削除にも含めない', async () => {
		await ensureDir(CONFLICT_BACKUP_DIR);
		await writeAtomic(`${CONFLICT_BACKUP_DIR}notes.txt`, 'keep me');
		for (let i = 0; i < 101; i++) {
			await backupLocalNote('cloud_wins', makeNote({ id: `n${i}` }));
		}
		expect(await listConflictBackups()).toHaveLength(100);
		expect(new File(`${CONFLICT_BACKUP_DIR}notes.txt`).exists).toBe(true);
	});

	// クリーンアップは afterEach で行われる
	it('cleanup がテスト間で効く', async () => {
		const dir = new Directory(CONFLICT_BACKUP_DIR);
		if (dir.exists) dir.delete();
	});
});
