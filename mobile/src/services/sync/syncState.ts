import { ensureDir, readString, writeAtomic } from '../storage/atomicFile';
import { APP_DATA_DIR, SYNC_STATE_PATH } from '../storage/paths';
import { AsyncLock } from './asyncLock';
import type { SyncStateSnapshot } from './types';

/**
 * 毎回新しい空スナップショットを生成する。
 * EMPTY_SYNC_STATE を直接スプレッドすると dirtyNoteIds などのネスト Record が
 * 共有参照になり、状態が他インスタンスへ漏れるため必ずこの関数を使う。
 */
function freshSnapshot(): SyncStateSnapshot {
	return {
		dirty: false,
		lastSyncedDriveTs: '',
		dirtyNoteIds: {},
		deletedNoteIds: {},
		deletedFolderIds: {},
		lastSyncedNoteHash: {},
	};
}

/**
 * 同期状態の永続管理。
 *
 * デスクトップ版 sync_state.go を移植。競合を防ぐ revision カウンタと
 * ClearDirtyIfUnchanged パターンを完全に踏襲する。
 *
 * - dirty/dirtyNoteIds/deletedNoteIds/deletedFolderIds/lastSyncedDriveTs/lastSyncedNoteHash は永続化
 * - revision はメモリ上のみ（起動ごとに 0 リセット）
 * - 全書き込みは atomic（tempfile→rename）
 */
export class SyncStateManager {
	private state: SyncStateSnapshot = freshSnapshot();
	private revision = 0;
	private readonly lock = new AsyncLock();
	private loaded = false;

	async load(): Promise<void> {
		if (this.loaded) return;
		await ensureDir(APP_DATA_DIR);
		const raw = await readString(SYNC_STATE_PATH);
		if (raw) {
			try {
				const parsed = JSON.parse(raw) as Partial<SyncStateSnapshot>;
				this.state = {
					...freshSnapshot(),
					...parsed,
					dirtyNoteIds: { ...(parsed.dirtyNoteIds ?? {}) },
					deletedNoteIds: { ...(parsed.deletedNoteIds ?? {}) },
					deletedFolderIds: { ...(parsed.deletedFolderIds ?? {}) },
					lastSyncedNoteHash: { ...(parsed.lastSyncedNoteHash ?? {}) },
				};
			} catch (e) {
				console.warn(
					'[SyncState] failed to parse sync_state.json, resetting',
					e,
				);
				this.state = freshSnapshot();
			}
		}
		this.loaded = true;
	}

	/** 現在の状態のシャローコピーを返す（UI 表示用）。 */
	snapshot(): Readonly<SyncStateSnapshot> {
		return {
			...this.state,
			dirtyNoteIds: { ...this.state.dirtyNoteIds },
			deletedNoteIds: { ...this.state.deletedNoteIds },
			deletedFolderIds: { ...this.state.deletedFolderIds },
			lastSyncedNoteHash: { ...this.state.lastSyncedNoteHash },
		};
	}

	isDirty(): boolean {
		return this.state.dirty;
	}

	lastSyncedDriveTs(): string {
		return this.state.lastSyncedDriveTs;
	}

	lastSyncedHash(noteId: string): string | undefined {
		return this.state.lastSyncedNoteHash[noteId];
	}

	/** ノート編集を dirty として記録する。 */
	async markNoteDirty(noteId: string): Promise<void> {
		await this.mutate(() => {
			this.state.dirty = true;
			this.state.dirtyNoteIds[noteId] = true;
			delete this.state.deletedNoteIds[noteId]; // 編集は削除をキャンセル
		});
	}

	/** ノート削除を記録する。 */
	async markNoteDeleted(noteId: string): Promise<void> {
		await this.mutate(() => {
			this.state.dirty = true;
			this.state.deletedNoteIds[noteId] = true;
			delete this.state.dirtyNoteIds[noteId];
			delete this.state.lastSyncedNoteHash[noteId];
		});
	}

	async markFolderDeleted(folderId: string): Promise<void> {
		await this.mutate(() => {
			this.state.dirty = true;
			this.state.deletedFolderIds[folderId] = true;
		});
	}

	/** 並び替えや折りたたみ状態変更など、ノート単位ではない変更用。 */
	async markDirty(): Promise<void> {
		await this.mutate(() => {
			this.state.dirty = true;
		});
	}

	/**
	 * 同期開始前にスナップショットを取り revision も返す。
	 * 同期完了時に clearDirtyIfUnchanged に渡すことで、
	 * 同期中にユーザー編集があったか検知できる。
	 */
	async getDirtySnapshotWithRevision(): Promise<{
		revision: number;
		dirtyIds: string[];
		deletedIds: string[];
		deletedFolderIds: string[];
	}> {
		return this.lock.run(async () => ({
			revision: this.revision,
			dirtyIds: Object.keys(this.state.dirtyNoteIds),
			deletedIds: Object.keys(this.state.deletedNoteIds),
			deletedFolderIds: Object.keys(this.state.deletedFolderIds),
		}));
	}

	/**
	 * 同期完了時の dirty クリア。revision 不変のときのみクリアする。
	 * 同期中に新しい編集が来て revision が進んでいた場合は false を返し、
	 * dirty を維持する（デスクトップ版 ClearDirtyIfUnchanged と完全互換）。
	 */
	async clearDirtyIfUnchanged(
		snapshotRevision: number,
		driveTs: string,
		noteHashes: Record<string, string>,
	): Promise<boolean> {
		return this.lock.run(async () => {
			if (this.revision !== snapshotRevision) {
				return false;
			}
			this.state.dirty = false;
			this.state.dirtyNoteIds = {};
			this.state.deletedNoteIds = {};
			this.state.deletedFolderIds = {};
			this.state.lastSyncedDriveTs = driveTs;
			for (const [id, hash] of Object.entries(noteHashes)) {
				this.state.lastSyncedNoteHash[id] = hash;
			}
			await this.persist();
			return true;
		});
	}

	/**
	 * clearDirtyIfUnchanged が false の場合のフォールバック。
	 * dirty と dirty IDs は保持したまま、既に確定した hash と driveTs のみ更新する。
	 * 次回同期で「変わっていない既知ノート」を再 resolve しないようにする。
	 */
	async updateSyncedState(
		driveTs: string,
		noteHashes: Record<string, string>,
	): Promise<void> {
		await this.lock.run(async () => {
			this.state.lastSyncedDriveTs = driveTs;
			for (const [id, hash] of Object.entries(noteHashes)) {
				this.state.lastSyncedNoteHash[id] = hash;
			}
			await this.persist();
		});
	}

	/**
	 * 1 ノート分だけ lastSyncedNoteHash を即時永続化する。
	 * 大量アップロード途中でアプリが終了した場合、再起動後に「現在の hash と一致するノート」を
	 * Drive 呼び出しせずスキップして 60 件中 31 件目から再開できるようにする用途。
	 * revision はインクリメントしない（同期側の内部記録で、進行中の clearDirtyIfUnchanged の
	 * revision チェックを破壊してはならないため）。
	 */
	async updateSyncedNoteHash(noteId: string, hash: string): Promise<void> {
		await this.lock.run(async () => {
			this.state.lastSyncedNoteHash[noteId] = hash;
			await this.persist();
		});
	}

	/** 個別ノートのハッシュを削除（ノート完全削除後）。 */
	async forgetNoteHash(noteId: string): Promise<void> {
		await this.lock.run(async () => {
			if (this.state.lastSyncedNoteHash[noteId] !== undefined) {
				delete this.state.lastSyncedNoteHash[noteId];
				await this.persist();
			}
		});
	}

	/** ログアウト時などに全リセット。 */
	async reset(): Promise<void> {
		await this.lock.run(async () => {
			this.state = freshSnapshot();
			this.revision++;
			await this.persist();
		});
	}

	/** 端末データ削除後に、ファイルを書かずメモリ上の同期状態だけ初期化する。 */
	resetInMemory(): void {
		this.state = freshSnapshot();
		this.revision++;
		this.loaded = true;
	}

	/**
	 * 状態を変更し revision をインクリメント、永続化する共通処理。
	 * ユーザー編集トリガーで使う（同期側は別経路）。
	 */
	private async mutate(fn: () => void): Promise<void> {
		await this.lock.run(async () => {
			this.revision++;
			fn();
			await this.persist();
		});
	}

	private async persist(): Promise<void> {
		await writeAtomic(SYNC_STATE_PATH, JSON.stringify(this.state, null, 2));
	}
}

export const syncStateManager = new SyncStateManager();
