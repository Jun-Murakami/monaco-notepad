import type { NoteService } from '../notes/noteService';
import { AsyncLock } from './asyncLock';
import { backupLocalNote } from './conflictBackup';
import type { DriveSyncService } from './driveSyncService';
import { syncEvents } from './events';
import { computeContentHash } from './hash';
import type { SyncStateManager } from './syncState';
import { type Folder, MessageCode, type Note, type NoteList } from './types';

export interface SyncOrchestratorOptions {
	/** 競合時にローカル版をバックアップするか（デフォルト true）。 */
	enableConflictBackup?: boolean;
}

/**
 * 同期オーケストレーション。SyncNotes() のトップレベル分岐、push/pull/resolveConflict を実装。
 *
 * デスクトップ版 drive_service.go の SyncNotes/pushLocalChanges/pullCloudChanges/resolveConflict を
 * TS 流に整理しながら完全移植。
 *
 * 重要: syncLock により SyncNotes と SaveNoteAndUpdateList の排他を実現。
 * デスクトップ版 syncMu と等価の役割。
 */
export class SyncOrchestrator {
	private readonly syncLock = new AsyncLock();
	// ユーザーの明示的なサインイン直後のみ true にする「全ノート contentHeader 検査 & 修復」要求フラグ。
	// 次の pullCloudChanges 時に消費される（見つかった欠落を埋めて markDirty、Drive に push させる）。
	private bulkRepairPending = false;

	constructor(
		private readonly driveSync: DriveSyncService,
		private readonly noteService: NoteService,
		private readonly syncState: SyncStateManager,
		private readonly options: SyncOrchestratorOptions = {},
	) {}

	/** driveService.signIn() から呼ぶ。次の pullCloudChanges で bulk repair を実行する指示。 */
	requestBulkRepair(): void {
		this.bulkRepairPending = true;
	}

	/**
	 * エントリポイント。cloud/local の dirty 状態で 4 分岐する。
	 * - !cloud && !local: 何もしない
	 * - local のみ: push
	 * - cloud のみ: pull
	 * - 両方: resolveConflict
	 */
	async syncNotes(): Promise<void> {
		await this.syncLock.run(async () => {
			syncEvents.emit('drive:status', { status: 'idle' });
			const cloudMeta = await this.driveSync.getNoteListMetadata();
			const cloudTs = cloudMeta.modifiedTime ?? '';
			const cloudChanged = cloudTs !== this.syncState.lastSyncedDriveTs();
			const localDirty = this.syncState.isDirty();

			if (!cloudChanged && !localDirty) return;

			if (!cloudChanged && localDirty) {
				syncEvents.emit('drive:status', { status: 'pushing' });
				syncEvents.emit('sync:message', {
					code: MessageCode.DriveSyncPushLocal,
				});
				await this.pushLocalChanges(cloudTs);
				syncEvents.emit('drive:status', { status: 'idle' });
				return;
			}

			if (cloudChanged && !localDirty) {
				syncEvents.emit('drive:status', { status: 'pulling' });
				syncEvents.emit('sync:message', {
					code: MessageCode.DriveSyncPullCloud,
				});
				await this.pullCloudChanges(cloudTs);
				syncEvents.emit('drive:status', { status: 'idle' });
				return;
			}

			// 両方変更: 競合処理
			syncEvents.emit('drive:status', { status: 'resolving' });
			syncEvents.emit('sync:message', { code: MessageCode.DriveSyncConflict });
			await this.resolveConflict(cloudTs);
			syncEvents.emit('drive:status', { status: 'idle' });
		});
	}

	/**
	 * 単一ノート保存のトリガからも呼ぶ。
	 * SyncNotes と同じ syncLock を取るため直列化される。
	 * dirty フラグは syncState 側で立てる前提（markNoteDirty を呼んだ後にこれを呼ぶ）。
	 *
	 * 引数の `note` だけでなく、**全 dirty ノート・deleted ノートをここで一括 push する**。
	 * そうしないと noteList だけが先に更新され、Drive に実体のないノート参照が残り、
	 * 他クライアント（デスクトップ版等）が整合性エラーを起こす。
	 */
	async saveNoteAndUpdateList(note: Note): Promise<void> {
		await this.syncLock.run(async () => {
			const snap = await this.syncState.getDirtySnapshotWithRevision();
			const hashes: Record<string, string> = {};
			try {
				// dirty な全ノートをアップロード（引数の note 以外の pending 変更も取りこぼさない）
				const dirtyIds = new Set(snap.dirtyIds);
				dirtyIds.add(note.id); // 呼出元の markNoteDirty が race で未反映でも確実に含める

				for (const noteId of dirtyIds) {
					const n =
						noteId === note.id ? note : await this.noteService.readNote(noteId);
					if (!n) continue;
					const existingId = await this.driveSync.resolveNoteFileId(noteId);
					if (existingId) {
						await this.driveSync.updateNote(n);
					} else {
						await this.driveSync.createNote(n);
					}
					hashes[noteId] = await computeContentHash(n);
				}

				// 削除ペンディング分を Drive からも削除
				for (const noteId of snap.deletedIds) {
					await this.driveSync.deleteNote(noteId);
				}

				const list = this.noteService.getNoteList();
				const updated = await this.driveSync.updateNoteList(list);

				const cleared = await this.syncState.clearDirtyIfUnchanged(
					snap.revision,
					updated.modifiedTime ?? '',
					hashes,
				);
				if (!cleared) {
					await this.syncState.updateSyncedState(
						updated.modifiedTime ?? '',
						hashes,
					);
				}
				for (const id of snap.deletedIds)
					await this.syncState.forgetNoteHash(id);
			} catch (e) {
				syncEvents.emit('sync:error', { error: toError(e) });
				throw e;
			}
		});
	}

	// ---- PUSH ----
	private async pushLocalChanges(cloudTs: string): Promise<void> {
		const snap = await this.syncState.getDirtySnapshotWithRevision();
		const list = this.noteService.getNoteList();
		const hashes: Record<string, string> = {};

		// Pass 1: dirty 全件の hash を計算して、実際に Drive へ上げる必要があるノートだけ抽出。
		// ここで件数と順序を確定させることで、Resume 時も進捗メッセージを 1..M の連番で出せる。
		type PendingUpload = { noteId: string; note: Note; hash: string };
		const toUpload: PendingUpload[] = [];
		for (const noteId of snap.dirtyIds) {
			const note = await this.noteService.readNote(noteId);
			if (!note) continue;
			const currentHash = await computeContentHash(note);
			hashes[noteId] = currentHash;
			// Resume 最適化: 前回途中終了で既に Drive にあるノートは Drive 呼び出しをスキップ。
			// hashes には入れるので最終 commit (clearDirtyIfUnchanged) で矛盾しない。
			if (this.syncState.lastSyncedHash(noteId) === currentHash) {
				continue;
			}
			toUpload.push({ noteId, note, hash: currentHash });
		}

		// Pass 2: 確定した件数で綺麗な進捗表示 (1/M, 2/M, ..., M/M)
		const uploadTotal = toUpload.length;
		for (let i = 0; i < toUpload.length; i++) {
			const p = toUpload[i];
			syncEvents.emit('sync:message', {
				code: MessageCode.DriveSyncUploadNote,
				args: { noteId: p.noteId, current: i + 1, total: uploadTotal },
			});
			const existingId = await this.driveSync.resolveNoteFileId(p.noteId);
			if (existingId) {
				await this.driveSync.updateNote(p.note);
			} else {
				await this.driveSync.createNote(p.note);
			}
			await this.syncState.updateSyncedNoteHash(p.noteId, p.hash);
		}

		for (const noteId of snap.deletedIds) {
			syncEvents.emit('sync:message', {
				code: MessageCode.DriveSyncDeleteNote,
				args: { noteId },
			});
			await this.driveSync.deleteNote(noteId);
		}

		// フォルダ削除はクラウドにはファイル実体がないので noteList 更新のみで済む
		const updated = await this.driveSync.updateNoteList(list);
		const cleared = await this.syncState.clearDirtyIfUnchanged(
			snap.revision,
			updated.modifiedTime ?? cloudTs,
			hashes,
		);
		if (!cleared) {
			await this.syncState.updateSyncedState(
				updated.modifiedTime ?? cloudTs,
				hashes,
			);
		}
		for (const id of snap.deletedIds) await this.syncState.forgetNoteHash(id);

		syncEvents.emit('notes:reload', undefined);
	}

	// ---- PULL ----
	private async pullCloudChanges(cloudTs: string): Promise<void> {
		const cloudList = await this.driveSync.downloadNoteList();
		const localList = this.noteService.getNoteList();

		// 事前にダウンロード対象を決定して総数を把握する（進捗表示のため）
		const toDownload: typeof cloudList.notes = [];
		const mergedHashes: Record<string, string> = {};
		for (const meta of cloudList.notes) {
			const local = localList.notes.find((n) => n.id === meta.id);
			const lastHash = this.syncState.lastSyncedHash(meta.id);
			if (
				!local ||
				local.contentHash !== meta.contentHash ||
				lastHash !== meta.contentHash
			) {
				toDownload.push(meta);
			} else {
				mergedHashes[meta.id] = meta.contentHash;
			}
		}

		if (toDownload.length > 0) {
			syncEvents.emit('sync:progress', {
				current: 0,
				total: toDownload.length,
			});
		}
		let downloaded = 0;
		// ダウンロードに失敗した（Drive に file が無い / parse 失敗）ノート ID を収集し、
		// 後段で cloudList から除去する。これをしないと「リストに載っているが file が無い」
		// ゾンビエントリが残り、UI では 無題のノート として出て、タップで null になって白画面になる。
		const zombieIds = new Set<string>();
		for (const meta of toDownload) {
			syncEvents.emit('sync:message', {
				code: MessageCode.DriveSyncDownloadNote,
				args: { noteId: meta.id },
			});
			const note = await this.driveSync.downloadNote(meta.id);
			if (note) {
				await this.noteService.saveNoteFromSync(note);
				mergedHashes[meta.id] = meta.contentHash;
			} else {
				zombieIds.add(meta.id);
				console.warn(
					`[Sync] note file not found on Drive, will be removed from list: ${meta.id}`,
				);
			}
			downloaded++;
			syncEvents.emit('sync:progress', {
				current: downloaded,
				total: toDownload.length,
			});
		}
		// 念のため progress をクリア
		syncEvents.emit('sync:progress', { current: 0, total: 0 });

		// クラウドから消えたノートをローカルからも削除
		for (const local of localList.notes) {
			if (!cloudList.notes.some((n) => n.id === local.id)) {
				await this.noteService.deleteNote(local.id);
				await this.syncState.forgetNoteHash(local.id);
			}
		}

		// ダウンロード失敗 = cloud noteList に載っているが実ファイルが無いゾンビ。
		// UI で誤表示とクラッシュの原因になるのでここで除去。markDirty で Drive 側も浄化する。
		if (zombieIds.size > 0) {
			cloudList.notes = cloudList.notes.filter((n) => !zombieIds.has(n.id));
			cloudList.topLevelOrder = cloudList.topLevelOrder.filter(
				(i) => !(i.type === 'note' && zombieIds.has(i.id)),
			);
			cloudList.archivedTopLevelOrder = cloudList.archivedTopLevelOrder.filter(
				(i) => !(i.type === 'note' && zombieIds.has(i.id)),
			);
			await this.syncState.markDirty();
			console.warn(
				`[Sync] removed ${zombieIds.size} zombie entries from noteList`,
			);
		}

		// サインイン直後（明示ログイン）のみ: cloudList の contentHeader 欠落を
		// ローカル本文ファイルから補完して in-place 修正 → replaceNoteList でそのまま反映 →
		// markDirty で次回 sync が Drive に修復済み noteList を push する。
		if (this.bulkRepairPending) {
			const emptyCount = cloudList.notes.filter((n) => !n.contentHeader).length;
			const fixed =
				await this.noteService.fillEmptyContentHeadersInList(cloudList);
			console.log(
				`[bulkRepair] contentHeader empty: ${emptyCount}, fixed: ${fixed}`,
			);
			if (fixed > 0) {
				await this.syncState.markDirty();
			}
			this.bulkRepairPending = false;
		}

		// noteList 全体を置き換え（順序・フォルダも同期）
		await this.noteService.replaceNoteList(cloudList);

		await this.syncState.updateSyncedState(cloudTs, mergedHashes);
		syncEvents.emit('notes:reload', undefined);
	}

	// ---- CONFLICT ----
	private async resolveConflict(cloudTs: string): Promise<void> {
		const snap = await this.syncState.getDirtySnapshotWithRevision();
		const cloudList = await this.driveSync.downloadNoteList();
		const localList = this.noteService.getNoteList();
		const resultHashes: Record<string, string> = {};

		// ローカルで dirty なノートごとに判定
		const dirtySet = new Set(snap.dirtyIds);

		// 事前パス: 「cloud 未存在 & hash 不一致 = 実際に新規 push するノート」の件数を確定
		// させ、進捗メッセージを 1..M の連番で出せるようにする。Resume 時にスキップされる
		// 分はカウント対象から外れるので UX 上もジャンプしない。
		let uploadTotal = 0;
		for (const id of dirtySet) {
			if (cloudList.notes.some((n) => n.id === id)) continue;
			const localNote = await this.noteService.readNote(id);
			if (!localNote) continue;
			const currentHash = await computeContentHash(localNote);
			if (this.syncState.lastSyncedHash(id) === currentHash) continue;
			uploadTotal++;
		}
		let uploadIndex = 0;

		for (const id of dirtySet) {
			const localNote = await this.noteService.readNote(id);
			if (!localNote) continue;
			const cloudMeta = cloudList.notes.find((n) => n.id === id);
			const lastHash = this.syncState.lastSyncedHash(id);
			const currentHash = await computeContentHash(localNote);

			if (!cloudMeta) {
				// クラウドに無い → 新規 push
				resultHashes[id] = currentHash;

				// Resume 最適化: 前回途中終了して既に Drive に上がっているなら createNote を省略
				if (lastHash === currentHash) {
					continue;
				}

				uploadIndex++;
				syncEvents.emit('sync:message', {
					code: MessageCode.DriveSyncUploadNote,
					args: { noteId: id, current: uploadIndex, total: uploadTotal },
				});
				await this.driveSync.createNote(localNote);
				await this.syncState.updateSyncedNoteHash(id, currentHash);
				continue;
			}

			if (cloudMeta.contentHash === lastHash) {
				// クラウドは前回同期から変わっていない → ローカル勝ち
				await this.driveSync.updateNote(localNote);
				resultHashes[id] = await computeContentHash(localNote);
				syncEvents.emit('sync:message', {
					code: MessageCode.DriveConflictKeepLocal,
					args: { noteId: id },
				});
				continue;
			}

			// 真の競合: ModifiedTime で勝敗判定 (LWW)
			if (isModifiedTimeAfter(localNote.modifiedTime, cloudMeta.modifiedTime)) {
				await this.driveSync.updateNote(localNote);
				resultHashes[id] = await computeContentHash(localNote);
				syncEvents.emit('sync:message', {
					code: MessageCode.DriveConflictKeepLocal,
					args: { noteId: id },
				});
			} else {
				// クラウド勝ち: バックアップを取ってから上書き
				if (this.options.enableConflictBackup !== false) {
					await backupLocalNote('cloud_wins', localNote);
				}
				const fresh = await this.driveSync.downloadNote(id);
				if (fresh) {
					await this.noteService.saveNoteFromSync(fresh);
					resultHashes[id] = cloudMeta.contentHash;
				}
				syncEvents.emit('sync:message', {
					code: MessageCode.DriveConflictKeepCloud,
					args: { noteId: id },
				});
			}
		}

		// ローカルで削除されたノート: クラウドも消す
		for (const id of snap.deletedIds) {
			const cloudMeta = cloudList.notes.find((n) => n.id === id);
			const lastHash = this.syncState.lastSyncedHash(id);
			if (cloudMeta && cloudMeta.contentHash !== lastHash) {
				// クラウド側で変更あり → バックアップして削除（デスクトップ版と同じ方針）
				if (this.options.enableConflictBackup !== false) {
					const fresh = await this.driveSync.downloadNote(id);
					if (fresh) await backupLocalNote('cloud_delete', fresh);
				}
			}
			await this.driveSync.deleteNote(id);
			await this.syncState.forgetNoteHash(id);
		}

		// クラウドにあってローカルで触ってないノート: ローカル側も追従
		for (const cloudMeta of cloudList.notes) {
			if (dirtySet.has(cloudMeta.id)) continue;
			const local = localList.notes.find((n) => n.id === cloudMeta.id);
			if (!local || local.contentHash !== cloudMeta.contentHash) {
				const fresh = await this.driveSync.downloadNote(cloudMeta.id);
				if (fresh) {
					await this.noteService.saveNoteFromSync(fresh);
					resultHashes[cloudMeta.id] = cloudMeta.contentHash;
				}
			} else {
				resultHashes[cloudMeta.id] = cloudMeta.contentHash;
			}
		}

		// クラウドから消えたノートを localList 側でも削除（dirty でないもの）
		for (const local of localList.notes) {
			if (dirtySet.has(local.id)) continue;
			if (!cloudList.notes.some((n) => n.id === local.id)) {
				await this.noteService.deleteNote(local.id);
				await this.syncState.forgetNoteHash(local.id);
			}
		}

		// メタ情報をマージ（折りたたみ状態・順序はローカル優先、notes は最新反映）
		const merged: NoteList = mergeNoteListMeta(localList, cloudList);
		merged.notes = this.noteService.getNoteList().notes; // 最新を使う
		await this.noteService.replaceNoteList(merged);

		// クラウドへ統合済みの noteList を書き戻す
		const updated = await this.driveSync.updateNoteList(merged);

		const cleared = await this.syncState.clearDirtyIfUnchanged(
			snap.revision,
			updated.modifiedTime ?? cloudTs,
			resultHashes,
		);
		if (!cleared) {
			await this.syncState.updateSyncedState(
				updated.modifiedTime ?? cloudTs,
				resultHashes,
			);
		}
		syncEvents.emit('notes:reload', undefined);
	}
}

function toError(e: unknown): Error {
	return e instanceof Error ? e : new Error(String(e));
}

function isModifiedTimeAfter(a: string, b: string): boolean {
	const ta = Date.parse(a);
	const tb = Date.parse(b);
	if (!Number.isNaN(ta) && !Number.isNaN(tb)) {
		return ta > tb;
	}
	return a > b; // フォールバック: 辞書順
}

function mergeNoteListMeta(local: NoteList, cloud: NoteList): NoteList {
	// フォルダは id ベースでマージ、ローカル優先
	const folderMap = new Map<string, Folder>();
	for (const f of cloud.folders) folderMap.set(f.id, f);
	for (const f of local.folders) folderMap.set(f.id, f);
	return {
		version: 'v2',
		notes: [],
		folders: [...folderMap.values()],
		topLevelOrder: mergeOrder(local.topLevelOrder, cloud.topLevelOrder),
		archivedTopLevelOrder: mergeOrder(
			local.archivedTopLevelOrder,
			cloud.archivedTopLevelOrder,
		),
		collapsedFolderIds: local.collapsedFolderIds,
	};
}

function mergeOrder<T extends { type: string; id: string }>(
	localOrder: T[],
	cloudOrder: T[],
): T[] {
	const seen = new Set(localOrder.map((i) => `${i.type}:${i.id}`));
	const merged = [...localOrder];
	for (const item of cloudOrder) {
		const key = `${item.type}:${item.id}`;
		if (!seen.has(key)) {
			merged.push(item);
			seen.add(key);
		}
	}
	return merged;
}
