import { Directory } from 'expo-file-system';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { AppState, type AppStateStatus } from 'react-native';
import { authService } from '../auth/authService';
import { noteService } from '../notes/noteService';
import { appSettings } from '../settings/appSettings';
import { APP_DATA_DIR } from '../storage/paths';
import { DriveClient } from './driveClient';
import { ensureDriveLayout } from './driveLayout';
import { DriveSyncService } from './driveSyncService';
import { syncEvents } from './events';
import { operationQueue } from './operationQueue';
import { SyncOrchestrator } from './orchestrator';
import { recoverCloudOrphans, recoverLocalOrphans } from './orphanRecovery';
import { PollingService } from './polling';
import { syncStateManager } from './syncState';
import type { Note } from './types';

/**
 * Drive 関連の全サービスを束ねるライフサイクルオーナ。
 * デスクトップ版 drive_service.go のエントリポイント相当。
 *
 * UI からはこのクラス経由で操作する（initialize/signIn/signOut/saveNote/kickSync）。
 */
export class DriveService {
	private client: DriveClient | null = null;
	private driveSync: DriveSyncService | null = null;
	private orchestrator: SyncOrchestrator | null = null;
	private polling: PollingService | null = null;
	private initialized = false;

	// connect 失敗状態 (signedIn だが orchestrator が nil) のときに、
	// AppState 復帰 / NetInfo オンライン復帰を検知して自動で reconnect を試みる
	// ためのリスナ。接続成功すると PollingService 側のリスナが同等の役割を担うので
	// このサービス側のリスナは no-op (`if (this.orchestrator) return`) になる。
	private appStateSub: { remove: () => void } | null = null;
	private netUnsub: (() => void) | null = null;
	// 直前の状態。「実際に変化した時のみ」auto reconnect を発火させるため。
	// `lastNetConnected === null` の間 (= NetInfo の初回 fire まで) は seed のみで
	// trigger しないことで、起動時の auto-connect と二重発火するのを避ける。
	private lastAppActive = true;
	private lastNetConnected: boolean | null = null;
	// 並行 reconnect の dedup。手動タップと自動トリガが重なっても 1 回だけ走らせる。
	private reconnectPromise: Promise<void> | null = null;

	async initialize(): Promise<void> {
		if (this.initialized) return;
		await syncStateManager.load();
		await noteService.load();
		await authService.load();

		// 操作キューの永続分を再開
		await operationQueue.init(async (item) => {
			// 初期段階では Drive サービス未接続だと失敗させてリスケさせる
			if (!this.driveSync || !this.orchestrator) {
				throw new Error('Drive not connected');
			}
			await this.executeQueuedOp(item.opType, item.mapKey, item.payload);
		});
		// ⚠️ `start()` が runLoop を kick したあと `pause()` を呼ぶと、最初の 1 回の
		// ループ反復が paused=false の状態で走ってしまい、保留分の item を処理しに
		// 行って executor が「Drive not connected」エラーを投げる (signed out 状態で
		// 再起動 → 過去の pending を踏むケース)。`start()` より前に `pause()` を
		// 呼ぶことで、runLoop は最初から paused 分岐に入る。
		operationQueue.pause();
		await operationQueue.start();

		// ローカル孤立復元は接続前でも実行可能
		await recoverLocalOrphans(noteService);

		// バックグラウンド復帰 / ネット復帰での自動 reconnect 用にリスナを張る。
		// `connect` 成否によらず常時張り、`tryAutoReconnect` 側で「signedIn かつ
		// 未接続」のときだけ動くよう判定する。
		this.installResumeListeners();

		if (authService.isSignedIn()) {
			try {
				// 起動時はネット状況不明 (オフライン起動などもありうる) なので
				// 楽観的に "pulling" を出さず、第一段階の Drive 呼び出しが成功した
				// 時点で初めて接続済みを emit する。
				await this.connect({ optimisticEmit: false });
			} catch (e) {
				// 起動時の Drive 接続が失敗しても、アプリ全体をクラッシュさせない。
				// (401 / ネットワーク不通 / Drive 障害 等)
				// 部分的に作られた接続オブジェクトをクリアして「未接続」状態に戻す。
				// ユーザーは設定 → サインインで明示的に再接続できる。401 で
				// authService 内の refresh が失敗した場合は signOut まで走るので、
				// `signedIn` 状態も自動で false に切り替わる。
				console.warn('[Drive] connect failed during initialize:', e);
				this.client = null;
				this.driveSync = null;
				this.orchestrator = null;
				this.polling = null;
				syncEvents.emit('drive:disconnected', undefined);
				syncEvents.emit('drive:status', { status: 'offline' });
			}
		}
		this.initialized = true;
	}

	async signIn(): Promise<void> {
		await authService.signIn();
		// signIn 直後は楽観的に「接続済み + pulling」を表示しても破綻しない
		// (ユーザーの操作により直前にネット経由でコード交換が成功している)。
		await this.connect({ optimisticEmit: true });
		// 明示的なサインイン直後は、Drive 上で contentHeader 欠落しているノートを
		// 全件検査して埋める（古いデスクトップ版で作られたノートの救済）。
		this.orchestrator?.requestBulkRepair();
	}

	/**
	 * 起動時 connect 失敗 (ネットワーク不通など) からの手動リトライ用。
	 * `signedIn` だが `orchestrator` が nil の状態でのみ意味を持つ。
	 * UI の SyncStatusBar 同期ボタン、AppState/NetInfo の自動トリガから叩かれる。
	 * 並行呼び出しは内部で dedup される。
	 */
	async reconnect(): Promise<void> {
		if (!authService.isSignedIn()) return;
		if (this.orchestrator) return;
		if (this.reconnectPromise) return this.reconnectPromise;
		this.reconnectPromise = this.doReconnect().finally(() => {
			this.reconnectPromise = null;
		});
		return this.reconnectPromise;
	}

	private async doReconnect(): Promise<void> {
		// NetInfo が「offline」を返している場合、ここで fetch を走らせても
		// withRetry が 4 回リトライして ~15s 後にタイムアウトする。それより
		// ユーザーに即フィードバックを返したい。
		const net = await NetInfo.refresh().catch(() => null);
		if (net && net.isConnected === false) {
			console.warn('[Drive] reconnect skipped: NetInfo says offline');
			syncEvents.emit('drive:disconnected', undefined);
			syncEvents.emit('drive:status', { status: 'offline' });
			return;
		}
		if (net && !appSettings.snapshot().syncOnCellular && isCellularOrExpensive(net)) {
			console.warn('[Drive] reconnect skipped: cellular sync disabled');
			syncEvents.emit('drive:disconnected', undefined);
			syncEvents.emit('drive:status', { status: 'offline' });
			return;
		}
		try {
			await this.connect({ optimisticEmit: false });
		} catch (e) {
			console.warn('[Drive] reconnect failed:', e);
			this.client = null;
			this.driveSync = null;
			this.orchestrator = null;
			this.polling = null;
			syncEvents.emit('drive:disconnected', undefined);
			syncEvents.emit('drive:status', { status: 'offline' });
			throw e;
		}
	}

	/**
	 * AppState 復帰 / NetInfo オンライン復帰時に呼ばれる、自動 reconnect トリガ。
	 * 接続済みなら no-op (PollingService 側のリスナが処理する)。
	 */
	private tryAutoReconnect(reason: string): void {
		if (!authService.isSignedIn()) return;
		if (this.orchestrator) return;
		console.log(`[Drive] auto reconnect triggered: ${reason}`);
		// fire-and-forget。エラーは reconnect 側でログ + offline 状態 emit 済み。
		this.reconnect().catch(() => {});
	}

	private installResumeListeners(): void {
		if (this.appStateSub || this.netUnsub) return;
		this.lastAppActive = AppState.currentState === 'active';
		this.appStateSub = AppState.addEventListener('change', (s) =>
			this.handleAppStateChange(s),
		);
		this.netUnsub = NetInfo.addEventListener((s) => this.handleNetChange(s));
	}

	private handleAppStateChange(state: AppStateStatus): void {
		const wasActive = this.lastAppActive;
		const isActive = state === 'active';
		this.lastAppActive = isActive;
		if (isActive && !wasActive) {
			this.tryAutoReconnect('appState:active');
		}
	}

	private handleNetChange(state: NetInfoState): void {
		const isOnline = state.isConnected === true;
		const wasOnline = this.lastNetConnected;
		this.lastNetConnected = isOnline;
		// 初回 fire (wasOnline === null) は seed のみで trigger しない。
		// 起動時 connect の自動実行と重複してしまうため。
		if (wasOnline === null) return;
		if (isOnline && !wasOnline) {
			this.tryAutoReconnect('netInfo:online');
		}
	}

	async signOut(): Promise<void> {
		await this.polling?.stop();
		this.polling = null;
		this.orchestrator = null;
		this.driveSync = null;
		this.client = null;
		// connect 不在状態に戻すので queue も止める。
		operationQueue.pause();
		await authService.signOut();
		await syncStateManager.reset();
		syncEvents.emit('drive:disconnected', undefined);
	}

	/**
	 * Google Drive の appDataFolder 内データを全削除してから連携を解除する。
	 *
	 * ローカルノートは残すため、次回 Google Drive に接続したときに空のクラウドで
	 * ローカルが上書き消去されないよう、解除後に全ノートを dirty として記録する。
	 */
	async deleteAllDriveDataAndSignOut(): Promise<void> {
		if (!authService.isSignedIn()) return;
		await this.polling?.stop();
		operationQueue.pause();

		const localNoteIds = noteService.getNoteList().notes.map((note) => note.id);
		const client =
			this.client ??
			new DriveClient((force) => authService.getAccessToken({ force }));
		await client.deleteAllAppDataFiles();
		await this.signOut();

		if (localNoteIds.length > 0) {
			await syncStateManager.markDirty();
			for (const noteId of localNoteIds) {
				await syncStateManager.markNoteDirty(noteId);
			}
		}
	}

	/**
	 * この端末に保存されたアプリデータを全削除する。
	 *
	 * Google Drive 上のデータは削除しない。先に連携解除して refresh token を失効/削除し、
	 * その後にローカル JSON、ノート本文、同期キュー、設定をまとめて消す。
	 */
	async deleteLocalData(): Promise<void> {
		await this.signOut().catch((error) => {
			console.warn('[Drive] signOut before local data deletion failed:', error);
		});
		await operationQueue.cleanupAll().catch((error) => {
			console.warn('[Drive] queue cleanup before local data deletion failed:', error);
		});

		const dir = new Directory(APP_DATA_DIR);
		if (dir.exists) {
			dir.delete();
		}

		this.client = null;
		this.driveSync = null;
		this.orchestrator = null;
		this.polling = null;
		noteService.resetInMemory();
		syncStateManager.resetInMemory();
		await operationQueue.resetInMemory();
		appSettings.resetInMemory();
		syncEvents.emit('drive:disconnected', undefined);
		syncEvents.emit('drive:status', { status: 'offline' });
		syncEvents.emit('notes:reload', undefined);
	}

	/** UI 操作用: ノート保存トリガー。markDirty → push。 */
	async saveNoteAndSync(note: Note): Promise<void> {
		await noteService.saveNote(note);
		await syncStateManager.markNoteDirty(note.id);
		// noteList のメタデータ (title / contentHeader / modifiedTime 等) が
		// 変わったので UI store に反映を通知する。これが無いと、ノート詳細で
		// 編集 → ホームに戻った時にタイトルやプレビューが古いまま見える。
		syncEvents.emit('notes:reload', undefined);
		if (this.orchestrator) {
			try {
				await this.orchestrator.saveNoteAndUpdateList(note);
			} catch {
				// 失敗はキューに残して後で再試行させる
				await operationQueue.enqueue('UPDATE', `note:${note.id}`, {
					noteId: note.id,
				});
			}
		} else {
			// オフライン: キューに入れて後で実行
			await operationQueue.enqueue('UPDATE', `note:${note.id}`, {
				noteId: note.id,
			});
		}
	}

	async deleteNoteAndSync(noteId: string): Promise<void> {
		await noteService.deleteNote(noteId);
		await syncStateManager.markNoteDeleted(noteId);
		await operationQueue.enqueue('DELETE', `note:${noteId}`, { noteId });
		syncEvents.emit('notes:reload', undefined);
	}

	/**
	 * archived フォルダを完全削除する。配下の archived ノートも本文ファイル・
	 * クラウド両方から消える。デスクトップ版のフォルダ削除と異なり、
	 * 「フォルダごとアーカイブ → アーカイブ画面で削除」という 2 段階フローで使う。
	 */
	async deleteFolderAndSync(folderId: string): Promise<void> {
		const deletedNoteIds = await noteService.deleteFolderHard(folderId);
		await syncStateManager.markFolderDeleted(folderId);
		for (const noteId of deletedNoteIds) {
			await syncStateManager.markNoteDeleted(noteId);
			await operationQueue.enqueue('DELETE', `note:${noteId}`, { noteId });
		}
	}

	/**
	 * archived フォルダを active へ復元する。配下の archived ノートも一緒に
	 * unarchive する。`syncStateManager.markNoteDirty` を呼んで次回同期で
	 * クラウド側にも反映させる。
	 */
	async restoreFolderAndSync(folderId: string): Promise<void> {
		const restoredNoteIds = await noteService.restoreFolder(folderId);
		await syncStateManager.markDirty();
		for (const noteId of restoredNoteIds) {
			await syncStateManager.markNoteDirty(noteId);
		}
	}

	async kickSync(): Promise<void> {
		const net = await NetInfo.refresh().catch(() => null);
		if (net && !appSettings.snapshot().syncOnCellular && isCellularOrExpensive(net)) {
			syncEvents.emit('drive:status', { status: 'offline' });
			return;
		}
		this.polling?.kick();
	}

	/**
	 * Drive と接続を確立する。
	 *
	 * `optimisticEmit=true`: 第一段階の fetch を走らせる前に「接続済み + pulling」を
	 * 即 emit する。ユーザーが操作した直後 (signIn) に「オフラインから突然ダウンロード」と
	 * 見えるのを避けたいケース用。
	 *
	 * `optimisticEmit=false`: 第一段階の Drive 呼び出しが成功してから初めて
	 * 「接続済み」を emit する。起動時 / 手動 reconnect で、失敗するかもしれないのに
	 * 「ダウンロード中」と表示するフリッカーを避ける。
	 *
	 * どこで失敗したか (token refresh 段階か Drive 段階か) を切り分けやすいよう、
	 * 各段階に診断ログを仕込む。
	 */
	private async connect(opts: { optimisticEmit: boolean }): Promise<void> {
		if (opts.optimisticEmit) {
			syncEvents.emit('drive:connected', undefined);
			syncEvents.emit('drive:status', { status: 'pulling' });
		}

		const tempClient = new DriveClient(async (force) => {
			try {
				return await authService.getAccessToken({ force });
			} catch (e) {
				console.warn('[Drive] token retrieval failed:', e);
				throw e;
			}
		});

		// 第一段階: Drive layout 解決 (token refresh + listFiles)。
		// ここで失敗するなら「ネット不通 / OAuth エラー / Google API 障害」のどれか。
		// optimistic 時はすでに pulling を出しているのでこの phase も意味を持つ。
		if (opts.optimisticEmit) {
			syncEvents.emit('sync:phase', { phase: 'preparing' });
		}
		let layout;
		try {
			layout = await ensureDriveLayout(tempClient);
		} catch (e) {
			console.warn('[Drive] ensureDriveLayout failed:', e);
			throw e;
		}

		// 成功確定後にコミット (非 optimistic 時はここで初めて emit)。
		if (!opts.optimisticEmit) {
			syncEvents.emit('drive:connected', undefined);
			syncEvents.emit('drive:status', { status: 'pulling' });
			syncEvents.emit('sync:phase', { phase: 'preparing' });
		}

		this.client = tempClient;
		this.driveSync = new DriveSyncService(this.client, layout);
		this.orchestrator = new SyncOrchestrator(
			this.driveSync,
			noteService,
			syncStateManager,
			{
				// 設定画面の「競合バックアップを保存」を同期の実処理に反映する。
				// false の場合は、クラウド勝ち/クラウド削除時のローカル退避 JSON を作らない。
				enableConflictBackup: appSettings.snapshot().conflictBackup,
			},
		);

		// クラウド孤立復元（noteList 取得後）
		await this.driveSync.listNoteFiles();
		await recoverCloudOrphans(this.driveSync, noteService);

		this.polling = new PollingService(
			this.client,
			this.driveSync,
			this.orchestrator,
			syncStateManager,
		);
		await this.polling.start();
		// 接続が確立したのでキューを再開する。`wake()` も呼ばれて、保留中の
		// CREATE/UPDATE/DELETE が即座に再生される。
		operationQueue.resume();
	}

	private async executeQueuedOp(
		opType: string,
		_mapKey: string,
		payload: unknown,
	): Promise<void> {
		if (!this.driveSync || !this.orchestrator)
			throw new Error('Drive not connected');
		const p = (payload ?? {}) as { noteId?: string };
		switch (opType) {
			case 'UPDATE':
			case 'CREATE': {
				if (!p.noteId) return;
				const note = await noteService.readNote(p.noteId);
				if (!note) return;
				await this.orchestrator.saveNoteAndUpdateList(note);
				return;
			}
			case 'DELETE': {
				if (!p.noteId) return;
				await this.driveSync.deleteNote(p.noteId);
				await syncStateManager.forgetNoteHash(p.noteId);
				return;
			}
			default:
				return;
		}
	}
}

export const driveService = new DriveService();

function isCellularOrExpensive(state: NetInfoState): boolean {
	const details = state.details as { isConnectionExpensive?: boolean } | null;
	return state.type === 'cellular' || details?.isConnectionExpensive === true;
}
