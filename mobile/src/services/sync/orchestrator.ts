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
		if (uploadTotal > 0) {
			syncEvents.emit('sync:phase', { phase: 'uploading-notes' });
			syncEvents.emit('sync:progress', { current: 0, total: uploadTotal });
		}
		for (let i = 0; i < toUpload.length; i++) {
			const p = toUpload[i];
			syncEvents.emit('sync:message', {
				code: MessageCode.DriveSyncUploadNote,
				args: { noteId: p.noteId, current: i + 1, total: uploadTotal },
			});
			if (uploadTotal > 0) {
				syncEvents.emit('sync:progress', {
					current: i + 1,
					total: uploadTotal,
				});
			}
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
		syncEvents.emit('sync:progress', { current: 0, total: 0 });
		syncEvents.emit('sync:phase', { phase: 'merging' });
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
		// 開始時 revision: pull 終了時に「ユーザーが pull 中に編集等したか」を判定するため。
		// userMutated なら cloudList での全置換をやめて、ローカル list を勝たせる
		// (pre-commit で cloud structure は既にユーザーへ提示済みなので、
		//  その上で行われた reorder / 新規作成 / フォルダ操作は明示的な意思決定とみなす)。
		const startSnap = await this.syncState.getDirtySnapshotWithRevision();

		// noteList JSON 取得は単一リクエストで progress 出せない。
		// phase だけでも UI に伝えて「何が遅いのか」を可視化する。
		syncEvents.emit('sync:phase', { phase: 'fetching-notelist' });
		const cloudList = await this.driveSync.downloadNoteList();
		const localList = this.noteService.getNoteList();

		// 事前にダウンロード対象を決定して総数を把握する（進捗表示のため）。
		// Resume 最適化: 前回 session で既にローカルへ書き終えているノート (= local の
		// contentHash が cloud と一致) は Drive を叩かずスキップ。lastSyncedNoteHash が空でも
		// (前回 updateSyncedState 到達前に kill) ローカルファイルから判定できる。
		const toDownload: typeof cloudList.notes = [];
		const mergedHashes: Record<string, string> = {};
		for (const meta of cloudList.notes) {
			const local = localList.notes.find((n) => n.id === meta.id);
			if (local && local.contentHash === meta.contentHash) {
				mergedHashes[meta.id] = meta.contentHash;
				continue;
			}
			toDownload.push(meta);
		}

		// 構造先行コミット: cloudList の folders / 順序 / 折りたたみ状態だけを先にローカルへ反映する。
		// notes は **localList のものをそのまま継承** し、未ダウンロードのノートをメタだけで
		// 表示することは避ける。これにより UI は最初から正しいフォルダ構造を持った状態になり、
		// ダウンロード途中で「フォルダ配下のノートがフラットに落ちて見える」誤認が起きない。
		//
		// flattenNoteList は topLevelOrder 上の未知 ID を silent skip するので、未着ノートの
		// 位置は一時的な「空き」として描画される（フォルダ header は出るが children は徐々に増える）。
		// upsertMetadata は既存 order エントリがあれば push しないため、ダウンロード完了時にも
		// クラウドの意図した位置にノートが収まる。
		//
		// ダウンロード対象がある場合だけ実施: toDownload が空 = 既に同期済みなら、
		// 古いローカル順序を一時的にクラウド順序へ書き換える意味がない（次の最終 replaceNoteList
		// で同じ結果になる）。
		if (toDownload.length > 0) {
			const structurePreCommit: NoteList = {
				version: 'v2',
				notes: localList.notes,
				folders: cloudList.folders,
				topLevelOrder: cloudList.topLevelOrder,
				archivedTopLevelOrder: cloudList.archivedTopLevelOrder,
				collapsedFolderIds: cloudList.collapsedFolderIds,
			};
			await this.noteService.replaceNoteList(structurePreCommit);
			syncEvents.emit('notes:reload', undefined);
		}

		if (toDownload.length > 0) {
			syncEvents.emit('sync:phase', { phase: 'downloading-notes' });
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
				args: {
					noteId: meta.id,
					current: downloaded + 1,
					total: toDownload.length,
				},
			});
			const note = await this.driveSync.downloadNote(meta.id);
			if (note) {
				await this.noteService.saveNoteFromSync({
					...note,
					// デスクトップ版は個別 note JSON から folderId を省いて保存する。
					// pull 中にユーザー操作が入って最終 cloudList 置換を見送る場合でも、
					// noteList 側の所属フォルダをここで反映しておく必要がある。
					contentHeader: note.contentHeader || meta.contentHeader,
					archived: meta.archived,
					folderId: meta.folderId,
				});
				mergedHashes[meta.id] = meta.contentHash;
				// 個別 hash を即時永続化: 大量 pull 中に kill されても次回起動で
				// 該当ノートの再 download を skip できる (resume 最適化)。
				await this.syncState.updateSyncedNoteHash(meta.id, meta.contentHash);
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
		syncEvents.emit('sync:phase', { phase: 'merging' });

		// クラウドから消えたノートをローカルからも削除
		for (const local of localList.notes) {
			if (!cloudList.notes.some((n) => n.id === local.id)) {
				await this.noteService.deleteNote(local.id);
				await this.syncState.forgetNoteHash(local.id);
			}
		}

		let endSnap = await this.syncState.getDirtySnapshotWithRevision();
		let userMutated = endSnap.revision !== startSnap.revision;

		// ダウンロード失敗 = cloud noteList に載っているが実ファイルが無いゾンビ。
		// UI で誤表示とクラッシュの原因になるのでここで除去。markDirty で Drive 側も浄化する。
		if (zombieIds.size > 0) {
			const beforeZombieRevision = endSnap.revision;
			for (const id of zombieIds) {
				await this.noteService.deleteNote(id);
				await this.syncState.forgetNoteHash(id);
			}
			removeNoteEntries(cloudList, zombieIds);
			endSnap = await this.syncState.getDirtySnapshotWithRevision();
			if (endSnap.revision !== beforeZombieRevision) {
				userMutated = true;
			}
			await this.syncState.markDirty();
			endSnap = await this.syncState.getDirtySnapshotWithRevision();
			console.warn(
				`[Sync] removed ${zombieIds.size} zombie entries from noteList`,
			);
		}

		// サインイン直後（明示ログイン）のみ: this.list の contentHeader 欠落を
		// ローカル本文ファイルから補完して in-place 修正 →
		// markDirty で次回 sync が Drive に修復済み noteList を push する。
		if (this.bulkRepairPending) {
			const beforeRepairRevision = endSnap.revision;
			const fixed = await this.noteService.bulkRepairContentHeaders();
			console.log(`[bulkRepair] fixed: ${fixed}`);
			endSnap = await this.syncState.getDirtySnapshotWithRevision();
			if (endSnap.revision !== beforeRepairRevision) {
				userMutated = true;
			}
			if (fixed > 0) {
				copyContentHeaders(this.noteService.getNoteList(), cloudList);
				await this.syncState.markDirty();
				endSnap = await this.syncState.getDirtySnapshotWithRevision();
			}
			this.bulkRepairPending = false;
		}

		if (!userMutated) {
			await this.noteService.replaceNoteList(cloudList);
		}

		await this.syncState.updateSyncedState(cloudTs, mergedHashes);
		syncEvents.emit('notes:reload', undefined);
	}

	// ---- CONFLICT ----
	private async resolveConflict(cloudTs: string): Promise<void> {
		const snap = await this.syncState.getDirtySnapshotWithRevision();
		syncEvents.emit('sync:phase', { phase: 'fetching-notelist' });
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

function removeNoteEntries(list: NoteList, noteIds: Set<string>): void {
	list.notes = list.notes.filter((n) => !noteIds.has(n.id));
	list.topLevelOrder = list.topLevelOrder.filter(
		(i) => !(i.type === 'note' && noteIds.has(i.id)),
	);
	list.archivedTopLevelOrder = list.archivedTopLevelOrder.filter(
		(i) => !(i.type === 'note' && noteIds.has(i.id)),
	);
}

function copyContentHeaders(from: NoteList, to: NoteList): void {
	const headers = new Map(
		from.notes
			.filter((n) => n.contentHeader)
			.map((n) => [n.id, n.contentHeader]),
	);
	for (const meta of to.notes) {
		if (!meta.contentHeader) {
			meta.contentHeader = headers.get(meta.id) ?? '';
		}
	}
}
