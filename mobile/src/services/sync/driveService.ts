import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { Directory } from 'expo-file-system';
import { AppState, type AppStateStatus } from 'react-native';
import { authService } from '../auth/authService';
import { noteService } from '../notes/noteService';
import { appSettings } from '../settings/appSettings';
import { deleteIfExists } from '../storage/atomicFile';
import { APP_DATA_DIR, OP_QUEUE_PATH } from '../storage/paths';
import { DriveClient } from './driveClient';
import { DriveGateway } from './driveGateway';
import { syncEvents } from './events';
import {
	deleteFolderHardLocally,
	deleteNoteLocally,
	restoreFolderLocally,
	saveNoteLocally,
} from './localActions';
import { PollingService } from './polling';
import { syncBaseStore } from './syncBase';
import { SyncEngine } from './syncEngine';
import { syncStateManager } from './syncState';
import type { Note } from './types';

/**
 * Drive 関連の全サービスを束ねるライフサイクルオーナ。
 * デスクトップ版 drive_service.go のエントリポイント相当。
 *
 * UI からはこのクラス経由で操作する（initialize/signIn/signOut/saveNoteAndSync/kickSync）。
 * ノートの保存はローカルへ書いて変更を記録するだけで、Drive への反映は同期エンジン
 * (SyncEngine) がまとめて行う（docs/sync-engine-v3.md）。
 */
export class DriveService {
	private client: DriveClient | null = null;
	private engine: SyncEngine | null = null;
	private polling: PollingService | null = null;
	private initialized = false;

	// connect 失敗状態 (signedIn だが engine が nil) のときに、
	// AppState 復帰 / NetInfo オンライン復帰を検知して自動で reconnect を試みる
	// ためのリスナ。接続成功すると PollingService 側のリスナが同等の役割を担うので
	// このサービス側のリスナは no-op (`if (this.engine) return`) になる。
	private appStateSub: { remove: () => void } | null = null;
	private netUnsub: (() => void) | null = null;
	// 直前の状態。「実際に変化した時のみ」auto reconnect を発火させるため。
	// `lastNetConnected === null` の間 (= NetInfo の初回 fire まで) は seed のみで
	// trigger しないことで、起動時の auto-connect と二重発火するのを避ける。
	private lastAppActive = true;
	private lastNetConnected: boolean | null = null;
	// 並行 reconnect の dedup。手動タップと自動トリガが重なっても 1 回だけ走らせる。
	private reconnectPromise: Promise<void> | null = null;

	/**
	 * 起動 critical path で同期的に必要な初期化のみを行う。
	 * Drive API 呼び出し (connect) とローカル孤立ファイルの取り込みは
	 * setReady(true) のあとに startBackgroundWork() で fire-and-forget する。
	 */
	async initialize(): Promise<void> {
		if (this.initialized) return;
		await syncStateManager.load();
		await noteService.load();
		await authService.load();
		// v2 の操作キューは使わない（保存・削除はすべて sync_state に記録済み）
		await deleteIfExists(OP_QUEUE_PATH).catch(() => {});

		// バックグラウンド復帰 / ネット復帰での自動 reconnect 用にリスナを張る。
		this.installResumeListeners();
		this.initialized = true;
	}

	/**
	 * setReady(true) のあとに UI ブロッキングなしで走らせる重い後処理。
	 *   - ローカル孤立ファイルの取り込み（noteList に無い本体をトップレベル先頭へ）
	 *   - Drive 接続 (signed in なら)
	 */
	startBackgroundWork(): void {
		noteService
			.adoptOrphanNotes()
			.then(async (adopted) => {
				for (const id of adopted) await syncStateManager.markNoteDirty(id);
				if (adopted.length > 0) {
					syncEvents.emit('integrity:issues', { count: adopted.length });
					syncEvents.emit('notes:reload', undefined);
				}
			})
			.catch((e) => {
				console.warn('[Drive] adoptOrphanNotes failed:', e);
			});

		if (!authService.isSignedIn()) return;

		// 起動時はネット状況不明なので楽観的に "pulling" を出さず、
		// 第一段階の Drive 呼び出しが成功した時点で初めて接続済みを emit する。
		this.connect({ optimisticEmit: false }).catch((e) => {
			console.warn('[Drive] connect failed during startup:', e);
			this.clearConnection();
			syncEvents.emit('drive:disconnected', undefined);
			syncEvents.emit('drive:status', { status: 'offline' });
			// 「Drive と同期していない」ことに気付かないまま使い続けるのを防ぐため通知する。
			// notifyReauthRequired は内部で重複抑止するので二重表示にはならない。
			authService.notifyReauthRequired(
				'startup_failed',
				e instanceof Error ? e.message : String(e),
			);
		});
	}

	async signIn(): Promise<void> {
		await authService.signIn();
		// signIn 直後は楽観的に「接続済み + pulling」を表示しても破綻しない。
		await this.connect({ optimisticEmit: true });
	}

	/**
	 * 起動時 connect 失敗 (ネットワーク不通など) からの手動リトライ用。
	 * `signedIn` だが `engine` が nil の状態でのみ意味を持つ。並行呼び出しは dedup される。
	 */
	async reconnect(): Promise<void> {
		if (!authService.isSignedIn()) return;
		if (this.engine) return;
		if (this.reconnectPromise) return this.reconnectPromise;
		this.reconnectPromise = this.doReconnect().finally(() => {
			this.reconnectPromise = null;
		});
		return this.reconnectPromise;
	}

	private async doReconnect(): Promise<void> {
		// NetInfo が「offline」を返している場合はすぐにフィードバックを返す。
		const net = await NetInfo.refresh().catch(() => null);
		if (net && net.isConnected === false) {
			console.warn('[Drive] reconnect skipped: NetInfo says offline');
			syncEvents.emit('drive:disconnected', undefined);
			syncEvents.emit('drive:status', { status: 'offline' });
			return;
		}
		if (
			net &&
			!appSettings.snapshot().syncOnCellular &&
			isCellularOrExpensive(net)
		) {
			console.warn('[Drive] reconnect skipped: cellular sync disabled');
			syncEvents.emit('drive:disconnected', undefined);
			syncEvents.emit('drive:status', { status: 'offline' });
			return;
		}
		try {
			await this.connect({ optimisticEmit: false });
		} catch (e) {
			console.warn('[Drive] reconnect failed:', e);
			this.clearConnection();
			syncEvents.emit('drive:disconnected', undefined);
			syncEvents.emit('drive:status', { status: 'offline' });
			throw e;
		}
	}

	/** AppState 復帰 / NetInfo オンライン復帰時の自動 reconnect トリガ。接続済みなら no-op。 */
	private tryAutoReconnect(reason: string): void {
		if (!authService.isSignedIn()) return;
		if (this.engine) return;
		console.log(`[Drive] auto reconnect triggered: ${reason}`);
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
		// 初回 fire (wasOnline === null) は seed のみ（起動時 connect との重複を避ける）。
		if (wasOnline === null) return;
		if (isOnline && !wasOnline) {
			this.tryAutoReconnect('netInfo:online');
		}
	}

	/**
	 * Google Drive 連携を解除する。接続とトークンだけを捨て、未送信の変更（sync_state）と
	 * 同期 base（sync_base）は残す。同じアカウントに接続し直したときは「オフラインだった間の変更」
	 * として双方向に同期される（base が無いと、相手の削除を取り込めず復活させたり、ローカルの移動や
	 * 並び替えを失ったりする）。別のアカウントに接続した場合は Drive のフォルダ ID が違うので、
	 * 同期エンジンが base を使わない（syncEngine.effectiveBase）。
	 */
	async signOut(): Promise<void> {
		await this.polling?.stop();
		this.clearConnection();
		await authService.signOut();
		syncEvents.emit('drive:disconnected', undefined);
	}

	/**
	 * Google Drive の appDataFolder 内データを全削除してから連携を解除する。
	 * ローカルノートは残し、次回接続時に全件アップロードされる（base を破棄するので
	 * 空のクラウドでローカルが消されることはない）。
	 */
	async deleteAllDriveDataAndSignOut(): Promise<void> {
		if (!authService.isSignedIn()) return;
		await this.polling?.stop();

		const localNoteIds = noteService.getNoteList().notes.map((note) => note.id);
		const client =
			this.client ??
			new DriveClient((force) => authService.getAccessToken({ force }));
		await client.deleteAllAppDataFiles();
		await this.signOut();
		// Drive のデータが無くなったので base も捨てる（次回は和集合で全件アップロード）
		await syncBaseStore.clear();

		for (const noteId of localNoteIds) {
			await syncStateManager.markNoteDirty(noteId);
		}
	}

	/**
	 * この端末に保存されたアプリデータを全削除する（Google Drive 上のデータは削除しない）。
	 */
	async deleteLocalData(): Promise<void> {
		await this.signOut().catch((error) => {
			console.warn('[Drive] signOut before local data deletion failed:', error);
		});

		const dir = new Directory(APP_DATA_DIR);
		if (dir.exists) {
			dir.delete();
		}

		this.clearConnection();
		noteService.resetInMemory();
		syncStateManager.resetInMemory();
		appSettings.resetInMemory();
		syncEvents.emit('drive:disconnected', undefined);
		syncEvents.emit('drive:status', { status: 'offline' });
		syncEvents.emit('notes:reload', undefined);
	}

	/** UI 操作用: ノート保存（エディタの debounce 保存 / 離脱時 flush）。 */
	async saveNoteAndSync(note: Note): Promise<void> {
		await saveNoteLocally(noteService, syncStateManager, note);
		// noteList のメタデータ (title / contentHeader / modifiedTime 等) が変わったので
		// UI store に反映を通知する。
		syncEvents.emit('notes:reload', undefined);
		this.requestSync();
	}

	async deleteNoteAndSync(noteId: string): Promise<void> {
		await deleteNoteLocally(noteService, syncStateManager, noteId);
		syncEvents.emit('notes:reload', undefined);
		this.requestSync();
	}

	/**
	 * archived フォルダを完全削除する。配下の archived ノートも本文ファイル・クラウド両方から消える。
	 */
	async deleteFolderAndSync(folderId: string): Promise<void> {
		await deleteFolderHardLocally(noteService, syncStateManager, folderId);
		this.requestSync();
	}

	/** archived フォルダを active へ復元する（配下の archived ノートも unarchive）。 */
	async restoreFolderAndSync(folderId: string): Promise<void> {
		await restoreFolderLocally(noteService, syncStateManager, folderId);
		this.requestSync();
	}

	async kickSync(): Promise<void> {
		const net = await NetInfo.refresh().catch(() => null);
		if (
			net &&
			!appSettings.snapshot().syncOnCellular &&
			isCellularOrExpensive(net)
		) {
			syncEvents.emit('drive:status', { status: 'offline' });
			return;
		}
		this.polling?.kick();
	}

	/** ローカル変更の後の同期要求。連続した保存は数秒待ってまとめる。 */
	private requestSync(): void {
		this.polling?.kickDebounced();
	}

	private clearConnection(): void {
		this.client = null;
		this.engine = null;
		this.polling = null;
	}

	/**
	 * Drive と接続を確立する。
	 *
	 * `optimisticEmit=true`: 第一段階の fetch 前に「接続済み + pulling」を即 emit する（signIn 直後）。
	 * `optimisticEmit=false`: 第一段階の Drive 呼び出しが成功してから「接続済み」を emit する。
	 */
	private async connect(opts: { optimisticEmit: boolean }): Promise<void> {
		if (opts.optimisticEmit) {
			syncEvents.emit('drive:connected', undefined);
			syncEvents.emit('drive:status', { status: 'pulling' });
			syncEvents.emit('sync:phase', { phase: 'preparing' });
		}

		const client = new DriveClient(async (force) => {
			try {
				return await authService.getAccessToken({ force });
			} catch (e) {
				console.warn('[Drive] token retrieval failed:', e);
				throw e;
			}
		});
		const gateway = new DriveGateway(client);

		// 第一段階: Drive レイアウト解決 (token refresh + listFiles)。
		// ここで失敗するなら「ネット不通 / OAuth エラー / Google API 障害」のどれか。
		try {
			await gateway.resolveLayout();
		} catch (e) {
			console.warn('[Drive] resolveLayout failed:', e);
			throw e;
		}

		if (!opts.optimisticEmit) {
			syncEvents.emit('drive:connected', undefined);
			syncEvents.emit('drive:status', { status: 'pulling' });
			syncEvents.emit('sync:phase', { phase: 'preparing' });
		}

		this.client = client;
		this.engine = new SyncEngine(
			gateway,
			noteService,
			syncStateManager,
			syncBaseStore,
			{
				// 設定画面の「競合バックアップを保存」を毎回参照する。
				enableConflictBackup: () => appSettings.snapshot().conflictBackup,
			},
		);
		this.polling = new PollingService(client, this.engine);
		// 初回同期は polling のループ内で即実行される（ここで待つと UI がブロックされる）。
		await this.polling.start();
	}
}

export const driveService = new DriveService();

function isCellularOrExpensive(state: NetInfoState): boolean {
	const details = state.details as { isConnectionExpensive?: boolean } | null;
	return state.type === 'cellular' || details?.isConnectionExpensive === true;
}
