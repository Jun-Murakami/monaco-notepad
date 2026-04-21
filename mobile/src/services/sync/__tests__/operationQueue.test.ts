import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationQueue, type OpItem } from '../operationQueue';

/**
 * OperationQueue の挙動テスト。
 * FIFO / UPDATE 3秒デバウンス / DELETE による CREATE/UPDATE キャンセル / 失敗時のリスケジュール。
 */

afterEach(() => {
	vi.useRealTimers();
});

async function flush(ms = 0): Promise<void> {
	// マイクロタスクと setTimeout を進める
	await vi.advanceTimersByTimeAsync(ms);
}

describe('OperationQueue', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it('enqueue した操作を executor が順に受け取る', async () => {
		const q = new OperationQueue();
		const seen: OpItem[] = [];
		await q.init(async (item) => {
			seen.push(item as OpItem);
		});
		await q.start();

		await q.enqueue('CREATE', 'note:a', { noteId: 'a' });
		await q.enqueue('DELETE', 'note:b', { noteId: 'b' });

		await flush(10);
		await flush(10);
		await q.stop();

		expect(seen.map((i) => i.opType)).toEqual(['CREATE', 'DELETE']);
		expect(seen.map((i) => i.mapKey)).toEqual(['note:a', 'note:b']);
	});

	it('UPDATE は 3 秒デバウンスされる（直ちに実行されない）', async () => {
		const q = new OperationQueue();
		const seen: OpItem[] = [];
		await q.init(async (item) => {
			seen.push(item as OpItem);
		});
		await q.start();

		await q.enqueue('UPDATE', 'note:a', { noteId: 'a' });
		await flush(1000);
		expect(seen.length).toBe(0);
		await flush(2500);
		// 合計 3500ms 経過。実行済
		expect(seen.length).toBe(1);
		await q.stop();
	});

	it('同じ mapKey の UPDATE が連続で来たら古い方は捨てられ、新しい方だけ実行される', async () => {
		const q = new OperationQueue();
		const seen: OpItem[] = [];
		await q.init(async (item) => {
			seen.push(item as OpItem);
		});
		await q.start();

		await q.enqueue('UPDATE', 'note:a', { v: 1 });
		await flush(1000);
		await q.enqueue('UPDATE', 'note:a', { v: 2 });
		await flush(5000);

		expect(seen.length).toBe(1);
		expect(seen[0].payload).toEqual({ v: 2 });
		await q.stop();
	});

	it('DELETE は同じ mapKey の pending CREATE/UPDATE をキャンセルする', async () => {
		const q = new OperationQueue();
		const seen: OpItem[] = [];
		await q.init(async (item) => {
			seen.push(item as OpItem);
		});
		await q.start();

		await q.enqueue('UPDATE', 'note:a', { v: 1 });
		await q.enqueue('DELETE', 'note:a', { noteId: 'a' });
		await flush(5000);

		expect(seen.map((i) => i.opType)).toEqual(['DELETE']);
		await q.stop();
	});

	it('DELETE は CREATE も取り消す', async () => {
		const q = new OperationQueue();
		const seen: OpItem[] = [];
		await q.init(async (item) => {
			seen.push(item as OpItem);
		});
		// まだ start しない状態で enqueue
		await q.enqueue('CREATE', 'note:a', { v: 1 });
		await q.enqueue('DELETE', 'note:a', { noteId: 'a' });
		await q.start();
		await flush(100);

		expect(seen.map((i) => i.opType)).toEqual(['DELETE']);
		await q.stop();
	});

	it('executor が失敗したら 15 秒後に再試行する', async () => {
		const q = new OperationQueue();
		let attempts = 0;
		await q.init(async () => {
			attempts++;
			if (attempts < 2) throw new Error('flaky');
		});
		await q.start();

		await q.enqueue('DELETE', 'note:a', { noteId: 'a' });
		await flush(100);
		expect(attempts).toBe(1);
		// 少し経過しても再試行されない
		await flush(5000);
		expect(attempts).toBe(1);
		// 15 秒経てば再試行
		await flush(16000);
		expect(attempts).toBe(2);

		await q.stop();
	});

	it('pendingCount は enqueue 数を反映し、成功で減る', async () => {
		const q = new OperationQueue();
		let allow = false;
		await q.init(async () => {
			if (!allow) throw new Error('wait');
		});
		await q.start();

		await q.enqueue('DELETE', 'note:a', {});
		await q.enqueue('DELETE', 'note:b', {});
		expect(await q.pendingCount()).toBeGreaterThanOrEqual(2);
		allow = true;
		await flush(20000);
		expect(await q.pendingCount()).toBe(0);
		await q.stop();
	});

	it('cleanupAll で全削除', async () => {
		const q = new OperationQueue();
		await q.init(async () => {});
		await q.enqueue('DELETE', 'note:a', {});
		await q.enqueue('DELETE', 'note:b', {});
		await q.cleanupAll();
		expect(await q.pendingCount()).toBe(0);
	});
});
