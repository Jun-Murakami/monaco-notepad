import * as SQLite from 'expo-sqlite';
import { ensureDir } from '../storage/atomicFile';
import { APP_DATA_DIR } from '../storage/paths';
import { AsyncLock } from './asyncLock';
import { sleep } from './retry';

/**
 * Drive 操作キュー（SQLite 永続化）。
 *
 * デスクトップ版 drive_operations_queue.go を移植しつつ、
 * モバイル特有の要件（アプリ kill 耐性）に応えるため SQLite で永続化する。
 *
 * 振る舞い：
 * - FIFO（単一 worker が scheduledAt 順に処理）
 * - UPDATE は 3 秒デバウンス（同じ mapKey の新しい UPDATE が来たら古いのを捨てる）
 * - DELETE は同じ mapKey の未実行 CREATE/UPDATE を全てキャンセル
 * - CREATE → UPDATE の順序保証（同じ mapKey）
 * - 閉じると worker が止まるが、DB に残った項目は次回起動で再生
 */

export type OpType = 'CREATE' | 'UPDATE' | 'DELETE' | 'DOWNLOAD' | 'LIST' | 'GET_FILE';

export interface OpItem {
	id: number;
	opType: OpType;
	mapKey: string;
	payload: unknown;
	createdAt: number;
	scheduledAt: number;
}

export type OpExecutor = (item: Omit<OpItem, 'id'>) => Promise<unknown>;

const UPDATE_DEBOUNCE_MS = 3000;

export class OperationQueue {
	private db: SQLite.SQLiteDatabase | null = null;
	private running = false;
	private workerPromise: Promise<void> | null = null;
	private stopFlag = false;
	private readonly lock = new AsyncLock();
	private executor: OpExecutor | null = null;
	private notify: (() => void) | null = null;
	private wakeUp = new Promise<void>((resolve) => {
		this.notify = resolve;
	});

	async init(executor: OpExecutor): Promise<void> {
		await ensureDir(APP_DATA_DIR);
		this.executor = executor;
		this.db = await SQLite.openDatabaseAsync('op_queue.db');
		await this.db.execAsync(`
			CREATE TABLE IF NOT EXISTS op_queue (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				op_type TEXT NOT NULL,
				map_key TEXT NOT NULL,
				payload TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				scheduled_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_op_queue_scheduled ON op_queue(scheduled_at);
			CREATE INDEX IF NOT EXISTS idx_op_queue_mapkey ON op_queue(map_key);
		`);
	}

	async enqueue(op: OpType, mapKey: string, payload: unknown): Promise<void> {
		if (!this.db) throw new Error('OperationQueue not initialized');
		const now = Date.now();
		const scheduledAt = op === 'UPDATE' ? now + UPDATE_DEBOUNCE_MS : now;

		await this.lock.run(async () => {
			const db = this.db!;
			await db.withTransactionAsync(async () => {
				if (op === 'DELETE') {
					// DELETE: 同じ mapKey の CREATE/UPDATE/DOWNLOAD を取り消す
					await db.runAsync(
						`DELETE FROM op_queue WHERE map_key = ? AND op_type IN ('CREATE','UPDATE','DOWNLOAD')`,
						[mapKey],
					);
				} else if (op === 'UPDATE') {
					// UPDATE: 同じ mapKey の古い UPDATE を削除（最新 UPDATE のみ生かす）
					await db.runAsync(
						`DELETE FROM op_queue WHERE map_key = ? AND op_type = 'UPDATE'`,
						[mapKey],
					);
				}
				await db.runAsync(
					`INSERT INTO op_queue (op_type, map_key, payload, created_at, scheduled_at) VALUES (?, ?, ?, ?, ?)`,
					[op, mapKey, JSON.stringify(payload ?? null), now, scheduledAt],
				);
			});
		});
		this.wake();
	}

	/** 同期側から「今すぐ kick」したいとき用。 */
	wake(): void {
		const n = this.notify;
		this.wakeUp = new Promise<void>((resolve) => {
			this.notify = resolve;
		});
		n?.();
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.stopFlag = false;
		this.workerPromise = this.runLoop();
	}

	async stop(): Promise<void> {
		this.stopFlag = true;
		this.wake();
		if (this.workerPromise) {
			await this.workerPromise.catch(() => {});
		}
		this.running = false;
	}

	async cleanupAll(): Promise<void> {
		await this.stop();
		const db = this.db;
		if (db) {
			await db.runAsync(`DELETE FROM op_queue`);
		}
	}

	/** テスト/UI 表示用。 */
	async pendingCount(): Promise<number> {
		if (!this.db) return 0;
		const row = await this.db.getFirstAsync<{ c: number }>(
			`SELECT COUNT(*) as c FROM op_queue`,
		);
		return row?.c ?? 0;
	}

	private async runLoop(): Promise<void> {
		while (!this.stopFlag) {
			const item = await this.nextItem();
			if (!item) {
				// 空なら wake を待つ
				await Promise.race([this.wakeUp, sleep(5000)]);
				continue;
			}
			if (item.scheduledAt > Date.now()) {
				// 未来の scheduledAt (UPDATE debounce 待ち)
				const waitMs = item.scheduledAt - Date.now();
				await Promise.race([this.wakeUp, sleep(waitMs)]);
				continue;
			}
			await this.process(item);
		}
	}

	private async nextItem(): Promise<OpItem | null> {
		if (!this.db) return null;
		const row = await this.db.getFirstAsync<{
			id: number;
			op_type: string;
			map_key: string;
			payload: string;
			created_at: number;
			scheduled_at: number;
		}>(`SELECT * FROM op_queue ORDER BY scheduled_at ASC, id ASC LIMIT 1`);
		if (!row) return null;
		return {
			id: row.id,
			opType: row.op_type as OpType,
			mapKey: row.map_key,
			payload: JSON.parse(row.payload),
			createdAt: row.created_at,
			scheduledAt: row.scheduled_at,
		};
	}

	private async process(item: OpItem): Promise<void> {
		if (!this.executor || !this.db) return;
		try {
			await this.executor({
				opType: item.opType,
				mapKey: item.mapKey,
				payload: item.payload,
				createdAt: item.createdAt,
				scheduledAt: item.scheduledAt,
			});
			await this.db.runAsync(`DELETE FROM op_queue WHERE id = ?`, [item.id]);
		} catch (e) {
			// 失敗時は DB に残したまま一定時間後に再試行させる（scheduledAt を後ろへ）
			console.warn(`[OperationQueue] ${item.opType} ${item.mapKey} failed, rescheduling:`, e);
			const retryAt = Date.now() + 15000;
			await this.db.runAsync(`UPDATE op_queue SET scheduled_at = ? WHERE id = ?`, [
				retryAt,
				item.id,
			]);
			// エラー継続を防ぐため短めに待つ
			await sleep(1000);
		}
	}
}

export const operationQueue = new OperationQueue();
