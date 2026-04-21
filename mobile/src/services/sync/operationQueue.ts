import { ensureDir, readString, writeAtomic } from '../storage/atomicFile';
import { APP_DATA_DIR, OP_QUEUE_PATH } from '../storage/paths';
import { AsyncLock } from './asyncLock';
import { sleep } from './retry';

/**
 * Drive 操作キュー（JSON ファイル永続化）。
 *
 * デスクトップ版 drive_operations_queue.go を移植しつつ、モバイル特有の要件
 * （アプリ kill 耐性）に応えるため atomicFile で永続化する。
 *
 * 以前は SQLite を使っていたが、pending 件数は通常 0〜数十・最大 <1000 の小規模で
 * SQL クエリの恩恵が薄く、依存を増やすだけだったため JSON に切り替えた。
 * 他の永続状態 (`noteList.json` / `sync_state.json`) と統一されるメリットもある。
 *
 * 振る舞い：
 * - FIFO（単一 worker が scheduledAt 順に処理）
 * - UPDATE は 3 秒デバウンス（同じ mapKey の新しい UPDATE が来たら古いのを捨てる）
 * - DELETE は同じ mapKey の未実行 CREATE/UPDATE を全てキャンセル
 * - CREATE → UPDATE の順序保証（同じ mapKey）
 * - 閉じると worker が止まるが、ファイルに残った項目は次回起動で再生
 */

export type OpType =
	| 'CREATE'
	| 'UPDATE'
	| 'DELETE'
	| 'DOWNLOAD'
	| 'LIST'
	| 'GET_FILE';

export interface OpItem {
	id: number;
	opType: OpType;
	mapKey: string;
	payload: unknown;
	createdAt: number;
	scheduledAt: number;
}

interface QueueSnapshot {
	version: 1;
	nextId: number;
	items: OpItem[];
}

export type OpExecutor = (item: Omit<OpItem, 'id'>) => Promise<unknown>;

const UPDATE_DEBOUNCE_MS = 3000;
const EMPTY_SNAPSHOT: QueueSnapshot = { version: 1, nextId: 1, items: [] };

export class OperationQueue {
	private items: OpItem[] = [];
	private nextId = 1;
	private initialized = false;
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
		const raw = await readString(OP_QUEUE_PATH);
		if (raw) {
			try {
				const parsed = JSON.parse(raw) as Partial<QueueSnapshot>;
				this.items = Array.isArray(parsed.items) ? [...parsed.items] : [];
				this.nextId =
					typeof parsed.nextId === 'number' && parsed.nextId >= 1
						? parsed.nextId
						: this.items.reduce((m, i) => Math.max(m, i.id), 0) + 1;
			} catch (e) {
				console.warn(
					'[OperationQueue] failed to parse op_queue.json, resetting',
					e,
				);
				this.items = [];
				this.nextId = 1;
			}
		}
		this.initialized = true;
	}

	async enqueue(op: OpType, mapKey: string, payload: unknown): Promise<void> {
		if (!this.initialized) throw new Error('OperationQueue not initialized');
		const now = Date.now();
		const scheduledAt = op === 'UPDATE' ? now + UPDATE_DEBOUNCE_MS : now;

		await this.lock.run(async () => {
			if (op === 'DELETE') {
				// DELETE: 同じ mapKey の CREATE/UPDATE/DOWNLOAD を取り消す
				this.items = this.items.filter(
					(i) =>
						!(
							i.mapKey === mapKey &&
							(i.opType === 'CREATE' ||
								i.opType === 'UPDATE' ||
								i.opType === 'DOWNLOAD')
						),
				);
			} else if (op === 'UPDATE') {
				// UPDATE: 同じ mapKey の古い UPDATE を削除（最新 UPDATE のみ生かす）
				this.items = this.items.filter(
					(i) => !(i.mapKey === mapKey && i.opType === 'UPDATE'),
				);
			}
			this.items.push({
				id: this.nextId++,
				opType: op,
				mapKey,
				payload,
				createdAt: now,
				scheduledAt,
			});
			await this.persist();
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
		await this.lock.run(async () => {
			this.items = [];
			await this.persist();
		});
	}

	/** テスト/UI 表示用。 */
	async pendingCount(): Promise<number> {
		return this.items.length;
	}

	private async runLoop(): Promise<void> {
		while (!this.stopFlag) {
			const item = this.nextItem();
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

	/** scheduledAt ASC, id ASC で先頭を返す（現在時刻で実行可否は判定しない）。 */
	private nextItem(): OpItem | null {
		if (this.items.length === 0) return null;
		let best = this.items[0];
		for (let i = 1; i < this.items.length; i++) {
			const it = this.items[i];
			if (
				it.scheduledAt < best.scheduledAt ||
				(it.scheduledAt === best.scheduledAt && it.id < best.id)
			) {
				best = it;
			}
		}
		return best;
	}

	private async process(item: OpItem): Promise<void> {
		if (!this.executor) return;
		try {
			await this.executor({
				opType: item.opType,
				mapKey: item.mapKey,
				payload: item.payload,
				createdAt: item.createdAt,
				scheduledAt: item.scheduledAt,
			});
			await this.lock.run(async () => {
				this.items = this.items.filter((i) => i.id !== item.id);
				await this.persist();
			});
		} catch (e) {
			// 失敗時は残したまま一定時間後に再試行させる（scheduledAt を後ろへ）
			console.warn(
				`[OperationQueue] ${item.opType} ${item.mapKey} failed, rescheduling:`,
				e,
			);
			const retryAt = Date.now() + 15000;
			await this.lock.run(async () => {
				const target = this.items.find((i) => i.id === item.id);
				if (target) target.scheduledAt = retryAt;
				await this.persist();
			});
			// エラー継続を防ぐため短めに待つ
			await sleep(1000);
		}
	}

	private async persist(): Promise<void> {
		const snapshot: QueueSnapshot = {
			...EMPTY_SNAPSHOT,
			nextId: this.nextId,
			items: this.items,
		};
		await writeAtomic(OP_QUEUE_PATH, JSON.stringify(snapshot));
	}
}

export const operationQueue = new OperationQueue();
