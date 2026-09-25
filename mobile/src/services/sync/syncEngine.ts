import { generateContentHeader, type NoteService } from '../notes/noteService';
import { AsyncLock } from './asyncLock';
import { sameNoteList } from './codec';
import { backupLocalNote } from './conflictBackup';
import {
	type DecideNoteInput,
	decideNote,
	type NoteDecision,
} from './core/decideNote';
import { type FinalNoteMeta, mergeNoteList } from './core/mergeNoteList';
import {
	knownSkippedVersions,
	type VersionRange,
} from './core/skippedVersions';
import type {
	DriveGateway,
	DriveLayoutIds,
	RemoteFileRef,
} from './driveGateway';
import { syncEvents } from './events';
import { computeContentHash } from './hash';
import { AuthError } from './retry';
import { emptySyncBase, type SyncBase, type SyncBaseStore } from './syncBase';
import type { SyncStateManager } from './syncState';
import {
	type ConflictBackupKind,
	MessageCode,
	type Note,
	type NoteList,
	type NoteMetadata,
} from './types';

/**
 * 同期エンジン v3（docs/sync-engine-v3.md §5）。デスクトップ版 backend/sync_engine.go と同じ手順。
 *
 * 1 サイクル:
 *   リモート読み取り → ローカルのスナップショット → ノート判定（decideNote）→ ダウンロード →
 *   本体のアップロード / 削除 → ローカルコミット（ロック内で現在のローカルと再マージ）→
 *   noteList アップロード（直前に再確認し、他端末の書き込みがあればやり直し）→ base 更新
 *
 * 失敗したノートは base を進めない（次サイクルで必ず再試行される）。
 */

export interface SyncEngineOptions {
	/** 競合で負けた / リモートで削除されたローカル版をバックアップするか（既定 true）。 */
	enableConflictBackup?: () => boolean;
	backup?: (kind: ConflictBackupKind, note: Note) => Promise<void>;
	/** noteList の書き込みが他端末と競合したときの最大試行回数（既定 3）。 */
	maxAttempts?: number;
}

export interface SyncReport {
	uploaded: number;
	downloaded: number;
	deletedLocal: number;
	deletedRemote: number;
	failures: number;
	listUploaded: boolean;
	attempts: number;
}

type EngineDecision = NoteDecision | { kind: 'skip' };

interface CycleResult {
	retry: boolean;
	report: SyncReport;
}

export class SyncEngine {
	private readonly lock = new AsyncLock();
	private baseCache: SyncBase | null | undefined;

	constructor(
		private readonly gateway: DriveGateway,
		private readonly notes: NoteService,
		private readonly state: SyncStateManager,
		private readonly baseStore: SyncBaseStore,
		private readonly options: SyncEngineOptions = {},
	) {}

	/** 同期を 1 回実行する（端末内で直列化される）。 */
	async sync(): Promise<SyncReport> {
		return this.lock.run(async () => {
			const maxAttempts = this.options.maxAttempts ?? 3;
			let report = emptyReport();
			try {
				for (let attempt = 1; attempt <= maxAttempts; attempt++) {
					const result = await this.runCycle();
					report = { ...result.report, attempts: attempt };
					if (!result.retry) break;
				}
			} finally {
				syncEvents.emit('sync:progress', { current: 0, total: 0 });
				syncEvents.emit('sync:phase', { phase: null });
			}
			return report;
		});
	}

	/** 同期しないと解消しない状態か（未送信のローカル変更がある / 一度も同期していない）。 */
	async hasPendingWork(): Promise<boolean> {
		if (this.state.isDirty()) return true;
		return (await this.loadBaseCached()) === null;
	}

	/** サインアウト / Drive 全削除時に base を破棄する。 */
	async resetBase(): Promise<void> {
		await this.lock.run(async () => {
			await this.baseStore.clear();
			this.baseCache = null;
			this.gateway.invalidateLayout();
		});
	}

	private async runCycle(): Promise<CycleResult> {
		const report = emptyReport();
		syncEvents.emit('drive:status', { status: 'pulling' });
		syncEvents.emit('sync:phase', { phase: 'fetching-notelist' });

		// ---- 1. リモート読み取り ----
		let layout = await this.gateway.resolveLayout();
		let listRef = await this.gateway.findNoteList(layout);
		if (!listRef) {
			// noteList が無い = 初回、または別端末が Drive のデータを全削除した。
			// 後者だとキャッシュしたフォルダ ID が消えているので、解決し直す。
			this.gateway.invalidateLayout();
			layout = await this.gateway.resolveLayout();
			listRef = await this.gateway.findNoteList(layout);
		}
		const remoteFiles = await this.gateway.listNoteFiles(layout);
		const base = await this.effectiveBase(layout, listRef);
		let remoteList: NoteList | null = null;
		if (listRef) {
			remoteList =
				base.noteList &&
				base.noteListFileId === listRef.fileId &&
				base.noteListMd5 !== '' &&
				base.noteListMd5 === listRef.md5
					? base.noteList
					: await this.gateway.downloadNoteList(listRef.fileId);
		}

		// ---- 2. ローカルのスナップショット ----
		const snap = await this.state.getDirtySnapshotWithRevision();
		const deleted = new Set(snap.deletedIds);
		const dirty = new Set(snap.dirtyIds);
		const localList = this.notes.getNoteList();
		const localMeta = new Map(localList.notes.map((n) => [n.id, n]));
		const localState = new Map<
			string,
			{ hash: string; modifiedTime: string }
		>();
		for (const meta of localList.notes) {
			if (dirty.has(meta.id) || !meta.contentHash) {
				const note = await this.notes.readNote(meta.id);
				if (!note) continue;
				localState.set(meta.id, {
					hash: await computeContentHash(note),
					modifiedTime: note.modifiedTime,
				});
			} else {
				localState.set(meta.id, {
					hash: meta.contentHash,
					modifiedTime: meta.modifiedTime,
				});
			}
		}

		// ---- 3. ノート判定フェーズ1 → ダウンロード → フェーズ2 ----
		const ids = new Set<string>([
			...localState.keys(),
			...remoteFiles.byNoteId.keys(),
			...Object.keys(base.notes),
			...deleted,
		]);
		const inputs = new Map<string, DecideNoteInput>();
		const decisions = new Map<string, EngineDecision>();
		const toDownload: string[] = [];
		for (const id of ids) {
			const remote = remoteFiles.byNoteId.get(id);
			const input: DecideNoteInput = {
				local: localState.get(id),
				localDeleted: deleted.has(id),
				base: base.notes[id],
				remote: remote
					? { md5: remote.md5, fileId: remote.fileId, version: remote.version }
					: undefined,
			};
			inputs.set(id, input);
			const decision = decideNote(input);
			decisions.set(id, decision);
			if (decision.kind === 'download') toDownload.push(id);
		}

		const downloaded = new Map<
			string,
			{
				note: Note;
				hash: string;
				parentVersion?: number;
				skipped?: VersionRange[];
			}
		>();
		if (toDownload.length > 0) {
			syncEvents.emit('sync:phase', { phase: 'downloading-notes' });
		}
		for (let i = 0; i < toDownload.length; i++) {
			const id = toDownload[i];
			const ref = remoteFiles.byNoteId.get(id) as RemoteFileRef;
			syncEvents.emit('sync:progress', {
				current: i + 1,
				total: toDownload.length,
			});
			syncEvents.emit('sync:message', {
				code: MessageCode.DriveSyncDownloadNote,
				args: { noteId: id, current: i + 1, total: toDownload.length },
			});
			try {
				const remote = await this.gateway.downloadNote(ref.fileId, id);
				if (remote) {
					const { note, parentVersion, skipped } = remote;
					downloaded.set(id, {
						note,
						hash: await computeContentHash(note),
						parentVersion,
						skipped,
					});
					report.downloaded++;
				} else {
					report.failures++;
				}
			} catch (e) {
				if (e instanceof AuthError) throw e;
				console.warn(`[SyncEngine] download failed: ${id}`, e);
				report.failures++;
			}
		}
		for (const id of toDownload) {
			const dl = downloaded.get(id);
			decisions.set(
				id,
				dl
					? decideNote({
							...(inputs.get(id) as DecideNoteInput),
							downloaded: {
								hash: dl.hash,
								modifiedTime: dl.note.modifiedTime,
								parentVersion: dl.parentVersion,
								skipped: dl.skipped,
							},
						})
					: { kind: 'skip' },
			);
		}

		const backupEnabled = this.options.enableConflictBackup?.() ?? true;
		const backup = this.options.backup ?? backupLocalNote;

		// ---- 4. 本体のアップロード / 削除 ----
		const uploadIds = [...decisions]
			.filter(([, d]) => d.kind === 'upload')
			.map(([id]) => id);
		/**
		 * 置き換えた版の「履歴の中で見ずに上書きされた版番号」。このサイクルで落とした版はその系譜から、
		 * 落とさずに書く（Drive が base のまま）なら base に覚えている値を引き継ぐ。
		 */
		const skippedOf = (id: string): VersionRange[] => {
			const remote = remoteFiles.byNoteId.get(id);
			if (!remote) return [];
			const dl = downloaded.get(id);
			return dl
				? knownSkippedVersions(
						dl.skipped ?? [],
						dl.parentVersion ?? 0,
						remote.version,
					)
				: (base.notes[id]?.skipped ?? []);
		};
		const uploaded = new Map<
			string,
			{
				ref: RemoteFileRef;
				note: Note;
				hash: string;
				parentVersion: number;
				skipped: VersionRange[];
			}
		>();
		if (uploadIds.length > 0) {
			syncEvents.emit('drive:status', { status: 'pushing' });
			syncEvents.emit('sync:phase', { phase: 'uploading-notes' });
		}
		for (let i = 0; i < uploadIds.length; i++) {
			const id = uploadIds[i];
			syncEvents.emit('sync:progress', {
				current: i + 1,
				total: uploadIds.length,
			});
			syncEvents.emit('sync:message', {
				code: MessageCode.DriveSyncUploadNote,
				args: { noteId: id, current: i + 1, total: uploadIds.length },
			});
			// 真の競合でローカルが勝った: 上書きする前に、負けたリモートの版をこの端末に残す
			const decision = decisions.get(id);
			const loser = downloaded.get(id);
			if (
				decision?.kind === 'upload' &&
				decision.backupRemote &&
				backupEnabled &&
				loser
			) {
				await backup('local_wins', loser.note).catch((e) =>
					console.warn(`[SyncEngine] backup failed: ${id}`, e),
				);
				syncEvents.emit('sync:message', {
					code: MessageCode.DriveConflictKeepLocal,
					args: { noteId: id },
				});
			}
			const note = await this.notes.readNote(id);
			if (!note) {
				report.failures++;
				continue;
			}
			try {
				const remote = remoteFiles.byNoteId.get(id);
				const parentVersion = remote?.version ?? 0;
				const skipped = skippedOf(id);
				const ref = await this.gateway.uploadNote(
					layout,
					note,
					remote?.fileId ?? null,
					{ parentVersion, skipped },
				);
				uploaded.set(id, {
					ref,
					note,
					hash: await computeContentHash(note),
					parentVersion,
					skipped,
				});
				report.uploaded++;
			} catch (e) {
				if (e instanceof AuthError) throw e;
				console.warn(`[SyncEngine] upload failed: ${id}`, e);
				report.failures++;
			}
		}

		const remoteDeleted = new Set<string>();
		for (const [id, d] of decisions) {
			if (d.kind !== 'deleteRemote') continue;
			const ref = remoteFiles.byNoteId.get(id);
			if (!ref) continue;
			syncEvents.emit('sync:message', {
				code: MessageCode.DriveSyncDeleteNote,
				args: { noteId: id },
			});
			try {
				await this.gateway.deleteFile(ref.fileId);
				remoteDeleted.add(id);
				report.deletedRemote++;
			} catch (e) {
				if (e instanceof AuthError) throw e;
				console.warn(`[SyncEngine] remote delete failed: ${id}`, e);
				report.failures++;
			}
		}
		for (const fileId of remoteFiles.duplicateFileIds) {
			await this.gateway.deleteFile(fileId).catch(() => {});
		}

		// ---- 5. ローカルコミット（UI の保存と排他。ネットワーク I/O なし） ----
		syncEvents.emit('drive:status', { status: 'merging' });
		syncEvents.emit('sync:phase', { phase: 'merging' });
		const remoteMetaById = new Map(
			(remoteList?.notes ?? []).map((n) => [n.id, n]),
		);
		const applied = new Set<string>();
		const removedLocally = new Set<string>();
		let localChanged = false;

		const cloudList = await this.notes.transact(async (tx) => {
			const current = tx.list();
			const currentMeta = new Map(current.notes.map((n) => [n.id, n]));
			// スナップショット以降にユーザーが触ったノートは、このサイクルでは上書き・削除しない
			const untouched = (id: string) =>
				(currentMeta.get(id)?.contentHash ?? null) ===
				(localMeta.get(id)?.contentHash ?? null);

			for (const [id, d] of decisions) {
				if (d.kind === 'applyRemote') {
					if (!untouched(id)) continue;
					const dl = downloaded.get(id) as { note: Note; hash: string };
					if (d.backupLocal && backupEnabled) {
						const localNote = await tx.readNote(id);
						if (localNote) await backup('cloud_wins', localNote);
						syncEvents.emit('sync:message', {
							code: MessageCode.DriveConflictKeepCloud,
							args: { noteId: id },
						});
					}
					await tx.writeNoteFile({
						...dl.note,
						contentHeader:
							dl.note.contentHeader || generateContentHeader(dl.note.content),
						folderId: currentMeta.get(id)?.folderId ?? '',
					});
					applied.add(id);
					localChanged = true;
				} else if (d.kind === 'deleteLocal') {
					if (!untouched(id)) continue;
					if (d.backupLocal && backupEnabled) {
						const localNote = await tx.readNote(id);
						if (localNote) await backup('cloud_delete', localNote);
					}
					await tx.removeNoteFile(id);
					removedLocally.add(id);
					report.deletedLocal++;
					localChanged = true;
				}
			}

			// マージ後にこの端末に存在するノート
			const finals = new Map<string, FinalNoteMeta>();
			for (const meta of current.notes) {
				if (removedLocally.has(meta.id)) continue;
				const dl = applied.has(meta.id) ? downloaded.get(meta.id) : undefined;
				finals.set(meta.id, dl ? metaOf(dl.note, dl.hash) : stripFolder(meta));
			}
			for (const id of applied) {
				const dl = downloaded.get(id);
				if (dl && !finals.has(id)) finals.set(id, metaOf(dl.note, dl.hash));
			}
			// Drive には本体があるがローカルに無いノート（ダウンロード失敗など）はクラウドの記載を保つ
			const passThrough = new Map<string, FinalNoteMeta>();
			for (const id of remoteFiles.byNoteId.keys()) {
				if (remoteDeleted.has(id) || finals.has(id)) continue;
				const dl = downloaded.get(id);
				const remoteMeta = remoteMetaById.get(id);
				const meta = remoteMeta
					? stripFolder(remoteMeta)
					: dl
						? metaOf(dl.note, dl.hash)
						: null;
				if (meta) passThrough.set(id, meta);
			}

			const merged = mergeNoteList({
				base: base.noteList,
				local: current,
				remote: remoteList,
				notes: [...finals.values(), ...passThrough.values()],
			});

			const localResult = withoutNotes(merged, new Set(passThrough.keys()));
			if (!sameNoteList(localResult, current)) {
				await tx.setNoteList(localResult);
				localChanged = true;
			}

			// クラウド用: 本体が Drive に確定しているノートだけ。メタは Drive 上の本体に合わせる。
			const onDrive = (id: string) =>
				uploaded.has(id) ||
				(remoteFiles.byNoteId.has(id) && !remoteDeleted.has(id));
			const driveMetaOf = (
				id: string,
				fallback: NoteMetadata,
			): FinalNoteMeta => {
				const up = uploaded.get(id);
				if (up) return metaOf(up.note, up.hash);
				const dl = downloaded.get(id);
				if (dl) return metaOf(dl.note, dl.hash);
				if (decisions.get(id)?.kind === 'none') {
					const snapMeta = localMeta.get(id);
					if (snapMeta) return stripFolder(snapMeta);
				}
				const remoteMeta = remoteMetaById.get(id);
				return stripFolder(remoteMeta ?? fallback);
			};
			const pending = new Set(
				merged.notes.filter((n) => !onDrive(n.id)).map((n) => n.id),
			);
			const cloud = withoutNotes(merged, pending);
			cloud.notes = cloud.notes.map((n) => ({
				...driveMetaOf(n.id, n),
				folderId: n.folderId,
			}));
			return cloud;
		});

		// ---- 6. ノート単位の base（このサイクルで確定した事実）----
		const baseNotes = { ...base.notes };
		const resolvedDeletions: string[] = [];
		for (const [id, d] of decisions) {
			const remote = remoteFiles.byNoteId.get(id);
			switch (d.kind) {
				case 'none': {
					const local = localState.get(id);
					if (local && remote)
						baseNotes[id] = {
							hash: local.hash,
							md5: remote.md5,
							fileId: remote.fileId,
							version: remote.version,
							skipped: skippedOf(id),
						};
					break;
				}
				case 'upload': {
					const up = uploaded.get(id);
					if (up)
						baseNotes[id] = {
							hash: up.hash,
							md5: up.ref.md5,
							fileId: up.ref.fileId,
							version: up.ref.version,
							// 書き込みまでの間に見ずに上書きした版も含める（他端末が読むときと同じ計算）
							skipped: knownSkippedVersions(
								up.skipped,
								up.parentVersion,
								up.ref.version,
							),
						};
					break;
				}
				case 'applyRemote': {
					const dl = downloaded.get(id);
					if (applied.has(id) && dl && remote) {
						baseNotes[id] = {
							hash: dl.hash,
							md5: remote.md5,
							fileId: remote.fileId,
							version: remote.version,
							skipped: skippedOf(id),
						};
						if (deleted.has(id)) resolvedDeletions.push(id); // 削除の取り消し
					}
					break;
				}
				case 'deleteLocal':
					if (removedLocally.has(id)) delete baseNotes[id];
					break;
				case 'deleteRemote':
					if (remoteDeleted.has(id)) {
						delete baseNotes[id];
						resolvedDeletions.push(id);
					}
					break;
				case 'forget':
					delete baseNotes[id];
					if (deleted.has(id)) resolvedDeletions.push(id);
					break;
				default:
					break;
			}
		}

		// 削除意図の対象がローカルに存在する（同期で復元された等）なら、その意図はもう無効
		for (const id of deleted) {
			if (localState.has(id) && !resolvedDeletions.includes(id)) {
				resolvedDeletions.push(id);
			}
		}

		// このサイクルで確定した事実（ノート単位の base・処理済みの削除意図）を保存する。
		// やり直し・中断のときに使う。noteList の base は「ローカルに取り込み済みのクラウドの版」。
		const checkpoint = async (listBase: {
			ref: RemoteFileRef | null;
			list: NoteList | null;
		}) => {
			await this.saveBase({
				version: 1,
				rootFolderId: layout.rootFolderId,
				noteListFileId: listBase.ref?.fileId ?? '',
				noteListMd5: listBase.ref?.md5 ?? '',
				noteList: listBase.list,
				notes: baseNotes,
			});
			await this.state.completeSync(snap.revision, resolvedDeletions, false);
			if (localChanged) syncEvents.emit('notes:reload', undefined);
		};

		// ---- 7. noteList のアップロード ----
		let newListRef = listRef;
		let newBaseList = remoteList;
		if (!remoteList || !sameNoteList(cloudList, remoteList)) {
			try {
				const latest = await this.gateway.findNoteList(layout);
				if (
					(latest?.fileId ?? '') !== (listRef?.fileId ?? '') ||
					(latest?.md5 ?? '') !== (listRef?.md5 ?? '')
				) {
					// 読み取り後に他端末が noteList を書いた。ローカルは remoteList を取り込み済みなので
					// それを base として確定し、最初からやり直す（相手の書き込みを上書きしない）。
					await checkpoint({ ref: listRef, list: remoteList });
					return { retry: true, report };
				}
				const uploadedRef = await this.gateway.uploadNoteList(
					layout,
					listRef?.fileId ?? null,
					cloudList,
				);
				newListRef = uploadedRef;
				newBaseList = cloudList;
				report.listUploaded = true;
				// 確認から書き込みまでの間に他端末が書いていた（版が 2 以上進んだ）場合は相手の noteList を
				// 上書きしている。相手のノート本体は Drive に残っているので、すぐにもう一度同期して取り戻す。
				if (
					listRef &&
					listRef.version > 0 &&
					uploadedRef.version > listRef.version + 1
				) {
					await checkpoint({ ref: uploadedRef, list: cloudList });
					return { retry: true, report };
				}
				// noteList を新規作成した場合、同時に別端末も作っていないか確認する（最古が正）。
				// 自分のものが最古でなければ削除し、最古の noteList を相手にやり直す。
				if (!listRef) {
					const oldest = await this.gateway.findNoteList(layout);
					if (oldest && oldest.fileId !== uploadedRef.fileId) {
						await this.gateway.deleteFile(uploadedRef.fileId).catch(() => {});
						await checkpoint({ ref: null, list: null });
						return { retry: true, report };
					}
				}
			} catch (e) {
				// noteList の書き込みに失敗しても、ノート単位で確定した事実は失わない
				await checkpoint({ ref: listRef, list: remoteList });
				throw e;
			}
		}

		// ---- 8. base 更新と後始末 ----
		await this.saveBase({
			version: 1,
			rootFolderId: layout.rootFolderId,
			noteListFileId: newListRef?.fileId ?? '',
			noteListMd5: newListRef?.md5 ?? '',
			noteList: newBaseList,
			notes: baseNotes,
		});
		await this.state.completeSync(
			snap.revision,
			resolvedDeletions,
			report.failures === 0,
		);
		if (localChanged) syncEvents.emit('notes:reload', undefined);
		syncEvents.emit('drive:status', { status: 'idle' });
		return { retry: false, report };
	}

	/**
	 * 今回のサイクルで使う base。Drive（アカウント）が変わった / noteList が消えた場合は
	 * 破棄して「和集合」で安全に同期し直す。v2 からの移行時は旧 lastSyncedNoteHash を使う。
	 */
	private async effectiveBase(
		layout: DriveLayoutIds,
		listRef: RemoteFileRef | null,
	): Promise<SyncBase> {
		const stored = await this.loadBaseCached();
		const fresh = { ...emptySyncBase(), rootFolderId: layout.rootFolderId };
		if (!stored) {
			const legacy = this.state.legacyNoteHashes();
			if (!listRef) return fresh;
			for (const [id, hash] of Object.entries(legacy))
				fresh.notes[id] = { hash };
			return fresh;
		}
		if (stored.rootFolderId !== layout.rootFolderId || !listRef) return fresh;
		if (stored.noteListFileId && stored.noteListFileId !== listRef.fileId) {
			return { ...stored, noteList: null, noteListFileId: '', noteListMd5: '' };
		}
		return stored;
	}

	private async loadBaseCached(): Promise<SyncBase | null> {
		if (this.baseCache === undefined) {
			this.baseCache = await this.baseStore.load();
		}
		return this.baseCache;
	}

	private async saveBase(base: SyncBase): Promise<void> {
		await this.baseStore.save(base);
		this.baseCache = base;
	}
}

function emptyReport(): SyncReport {
	return {
		uploaded: 0,
		downloaded: 0,
		deletedLocal: 0,
		deletedRemote: 0,
		failures: 0,
		listUploaded: false,
		attempts: 0,
	};
}

function metaOf(note: Note, hash: string): FinalNoteMeta {
	return {
		id: note.id,
		title: note.title,
		contentHeader: note.contentHeader || generateContentHeader(note.content),
		language: note.language,
		modifiedTime: note.modifiedTime,
		archived: note.archived,
		contentHash: hash,
	};
}

function stripFolder(meta: NoteMetadata): FinalNoteMeta {
	const { folderId: _f, ...rest } = meta;
	return rest;
}

/** noteList からノートを取り除く（残りの相対順序は変えない）。 */
function withoutNotes(list: NoteList, ids: Set<string>): NoteList {
	if (ids.size === 0) return { ...list, notes: [...list.notes] };
	const keep = (i: { type: string; id: string }) =>
		!(i.type === 'note' && ids.has(i.id));
	return {
		...list,
		notes: list.notes.filter((n) => !ids.has(n.id)),
		topLevelOrder: list.topLevelOrder.filter(keep),
		archivedTopLevelOrder: list.archivedTopLevelOrder.filter(keep),
	};
}
