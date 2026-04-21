import { describe, expect, it } from 'vitest';
import { AsyncLock } from '../asyncLock';

describe('AsyncLock', () => {
	it('並行タスクを直列に実行する', async () => {
		const lock = new AsyncLock();
		const log: string[] = [];
		const task = (label: string, delay: number) =>
			lock.run(async () => {
				log.push(`${label}:start`);
				await new Promise((r) => setTimeout(r, delay));
				log.push(`${label}:end`);
			});

		await Promise.all([task('A', 30), task('B', 5), task('C', 5)]);

		// どのタスクも end を出してから次のタスクが start する
		expect(log).toEqual([
			'A:start',
			'A:end',
			'B:start',
			'B:end',
			'C:start',
			'C:end',
		]);
	});

	it('エラーを呼び出し側へ伝播しつつロックは解放する', async () => {
		const lock = new AsyncLock();
		await expect(
			lock.run(async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		// エラー後も新しいタスクが進む
		const result = await lock.run(async () => 42);
		expect(result).toBe(42);
	});

	it('戻り値を返す', async () => {
		const lock = new AsyncLock();
		const result = await lock.run(async () => 'ok');
		expect(result).toBe('ok');
	});

	it('外側のロックが中のロックをデッドロックさせない（独立インスタンス）', async () => {
		const a = new AsyncLock();
		const b = new AsyncLock();
		const result = await a.run(async () => {
			return b.run(async () => 'nested');
		});
		expect(result).toBe('nested');
	});
});
