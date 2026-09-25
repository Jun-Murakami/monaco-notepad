import { ensureDir, readString, writeAtomic } from '../storage/atomicFile';
import { DEFAULT_STORAGE_PATHS } from '../storage/paths';
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
 * ローカル変更の記録（sync_state.json、デスクトップ版 sync_state.go と同じスキーマ）。
 *
 * v3 での役割（docs/sync-engine-v3.md §4）:
 * - `deletedNoteIds` はユーザーの削除意図の記録。処理が確定した ID だけ個別に消す。
 * - `dirty` / `dirtyNoteIds` / `deletedFolderIds` は「早く同期して」というヒント。
 *   同期の正しさは base（sync_base.json）との差分で決まる。
 * - `lastSyncedNoteHash` / `lastSyncedDriveTs` は v2 の遺物。移行時に base が無ければ
 *   `lastSyncedNoteHash` を base の本文 hash として読むだけで、v3 は更新しない。
 * - revision はメモリ上だけのカウンタ（永続化しない）。同期中にユーザー操作があったかの検知に使う。
 */
export class SyncStateManager {
	private state: SyncStateSnapshot = freshSnapshot();
	private revision = 0;
	private readonly lock = new AsyncLock();
	private loaded = false;

	constructor(
		private readonly path: string = DEFAULT_STORAGE_PATHS.syncStatePath,
	) {}

	async load(): Promise<void> {
		if (this.loaded) return;
		await ensureDir(this.path.slice(0, this.path.lastIndexOf('/') + 1));
		const raw = await readString(this.path);
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

	/** 現在の状態のコピーを返す（UI 表示用）。 */
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
		return (
			this.state.dirty || Object.keys(this.state.deletedNoteIds).length > 0
		);
	}

	/** v2 が記録していた「前回同期時の本文 hash」（base が無い移行直後だけ使う）。 */
	legacyNoteHashes(): Record<string, string> {
		return { ...this.state.lastSyncedNoteHash };
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

	/** 同期開始時のスナップショット（revision 付き）。 */
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
	 * 同期完了時の後始末。
	 * - `resolvedDeletions`: 処理が確定した削除意図（リモート削除済み / 取り消し）は個別に消す。
	 * - `succeeded`: サイクルが失敗なく終わったか。失敗があれば dirty を立て、すぐ再同期させる。
	 * - 成功かつ revision が同期開始時から変わっていなければ（= 同期中にユーザー操作が無い）、
	 *   ヒント系（dirty / dirtyNoteIds / deletedFolderIds）をクリアする。
	 * 戻り値: ヒント系をクリアしたか。
	 */
	async completeSync(
		snapshotRevision: number,
		resolvedDeletions: readonly string[],
		succeeded: boolean,
	): Promise<boolean> {
		return this.lock.run(async () => {
			for (const id of resolvedDeletions) delete this.state.deletedNoteIds[id];
			const cleared = succeeded && this.revision === snapshotRevision;
			if (cleared) {
				this.state.dirty = false;
				this.state.dirtyNoteIds = {};
				this.state.deletedFolderIds = {};
			} else if (!succeeded) {
				this.state.dirty = true;
			}
			// v2 の同期記録は v3 では使わない（移行後は base が正）
			this.state.lastSyncedNoteHash = {};
			this.state.lastSyncedDriveTs = '';
			await this.persist();
			return cleared;
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

	/** 状態を変更し revision をインクリメント、永続化する共通処理（ユーザー操作用）。 */
	private async mutate(fn: () => void): Promise<void> {
		await this.lock.run(async () => {
			this.revision++;
			fn();
			await this.persist();
		});
	}

	private async persist(): Promise<void> {
		await writeAtomic(this.path, JSON.stringify(this.state, null, 2));
	}
}

export const syncStateManager = new SyncStateManager();
