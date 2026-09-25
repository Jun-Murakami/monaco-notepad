import { deleteIfExists, readString, writeAtomic } from '../storage/atomicFile';
import { DEFAULT_STORAGE_PATHS } from '../storage/paths';
import type { NoteList } from './types';

/**
 * 最後に同期が確定した時点の状態（docs/sync-engine-v3.md §4, sync_base.json）。
 * 3-way マージの base と、ノートごとの「前回同期時の本文 hash / Drive 本体 md5」を持つ。
 *
 * base は Drive（アカウント）に紐づく。rootFolderId / noteListFileId が現在と違えば無効。
 */
export interface SyncBase {
	version: 1;
	rootFolderId: string;
	noteListFileId: string;
	noteListMd5: string;
	/** 最後に確定したクラウドの noteList（null = 未確定）。 */
	noteList: NoteList | null;
	/**
	 * noteId -> 前回同期時の本文 hash と Drive 本体の md5 / ファイル ID / 版番号（移行直後などで欠けうる）。
	 * ファイル ID が変わっていれば、ノートは一度削除されて作り直されている。版番号は、他端末の書き込みが
	 * この版を見た上でのものか（syncParentVersion と比べる）の判定に使う。
	 */
	notes: Record<
		string,
		{ hash: string; md5?: string; fileId?: string; version?: number }
	>;
}

export function emptySyncBase(): SyncBase {
	return {
		version: 1,
		rootFolderId: '',
		noteListFileId: '',
		noteListMd5: '',
		noteList: null,
		notes: {},
	};
}

export class SyncBaseStore {
	constructor(
		private readonly path: string = DEFAULT_STORAGE_PATHS.syncBasePath,
	) {}

	async load(): Promise<SyncBase | null> {
		const raw = await readString(this.path);
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw) as Partial<SyncBase>;
			if (parsed.version !== 1) return null;
			return {
				...emptySyncBase(),
				...parsed,
				notes: { ...(parsed.notes ?? {}) },
			} as SyncBase;
		} catch (e) {
			console.warn('[SyncBase] failed to parse sync_base.json, ignoring', e);
			return null;
		}
	}

	async save(base: SyncBase): Promise<void> {
		await writeAtomic(this.path, JSON.stringify(base));
	}

	async clear(): Promise<void> {
		await deleteIfExists(this.path);
	}
}

export const syncBaseStore = new SyncBaseStore();
