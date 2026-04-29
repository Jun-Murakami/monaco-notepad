import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { AppState, type AppStateStatus } from 'react-native';
import { appSettings } from '../settings/appSettings';
import { readString, writeAtomic } from '../storage/atomicFile';
import { CHANGE_PAGE_TOKEN_PATH } from '../storage/paths';
import type { DriveClient } from './driveClient';
import type { DriveSyncService } from './driveSyncService';
import { syncEvents } from './events';
import type { SyncOrchestrator } from './orchestrator';
import { AuthError, sleep } from './retry';
import type { SyncStateManager } from './syncState';

/**
 * ポーリングサービス。
 *
 * デスクトップ版 drive_polling.go をモバイル向けに拡張：
 * - 5s → 60s 指数バックオフ (factor 1.5)
 * - ユーザー操作 / 変更検知 / エラーで interval リセット
 * - Drive Changes API で増分検知（pageToken を永続化）
 * - NetInfo: オフライン時は完全停止、オンライン復帰で即時同期
 * - AppState: background/inactive 時は停止、active 復帰で即時同期
 */

const MIN_INTERVAL_MS = 5000;
const MAX_INTERVAL_MS = 60000;
const BACKOFF_FACTOR = 1.5;
const RECONNECT_MIN_MS = 10000;
const RECONNECT_MAX_MS = 3 * 60 * 1000;

export type ConnectivityState = 'online' | 'offline';

export class PollingService {
	private running = false;
	private stopFlag = false;
	private intervalMs = MIN_INTERVAL_MS;
	private pageToken: string | null = null;
	// 次回のループサイクルで Changes API のゲートをバイパスして強制的に
	// syncNotes() を走らせるフラグ。foreground 復帰や UI からの kick() で
	// セットする。Changes API は伝播ラグがあるため、これを見ないと「裏から
	// 戻った瞬間に最新を取り込みたい」UX が満たせない。
	private forceSync = false;
	// `NetInfo.fetch()` がコールドスタート時にキャッシュ済みの古い state を
	// 返してくる端末がある (Android で頻発)。実際にネット接続があるのに
	// `connectivity = 'offline'` になり、polling が「offline」を emit し続けて
	// UI が誤表示される。それを避けるため楽観的に `'online'` 起点にし、
	// `NetInfo.refresh()` で真の状態に上書きする。
	private connectivity: ConnectivityState = 'online';
	private appState: AppStateStatus = 'active';
	private netUnsub: (() => void) | null = null;
	private settingsUnsub: (() => void) | null = null;
	private appStateSub: { remove: () => void } | null = null;
	private netState: NetInfoState | null = null;
	private wakeUp: Promise<void> = Promise.resolve();
	private notify: (() => void) | null = null;
	private loopPromise: Promise<void> | null = null;

	constructor(
		private readonly driveClient: DriveClient,
		private readonly driveSync: DriveSyncService,
		private readonly orchestrator: SyncOrchestrator,
		private readonly syncState: SyncStateManager,
	) {
		this.resetWake();
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.stopFlag = false;
		await this.loadPageToken();

		this.netUnsub = NetInfo.addEventListener((s) => this.handleNetChange(s));
		this.settingsUnsub = appSettings.subscribe(() => {
			// syncOnCellular の切り替えを即座に反映する。現在の NetInfo state を
			// 再評価し、必要なら待機/再開へ遷移させる。
			if (this.netState) {
				this.handleNetChange(this.netState);
			}
			this.wake();
		});
		// `fetch()` ではなく `refresh()` を使う。`fetch()` はキャッシュ値を
		// 返すことがあり、再起動直後に「実際は online なのに offline と返ってくる」
		// ケースに陥って UI が ずっと「オフライン」と表示する不具合が起きる。
		await this.refreshConnectivity();

		this.appStateSub = AppState.addEventListener('change', (s) =>
			this.handleAppState(s),
		);
		this.appState = AppState.currentState;

		// 初回同期は runLoop 内で interval を待たずに即実行する。
		// ここで await すると signin 画面が初回同期完了まで閉じられず、
		// 大量ノートの初回取り込み中に UI がブロックされてしまう。
		this.loopPromise = this.runLoop();
	}

	/**
	 * `NetInfo.refresh()` を叩いて connectivity を真の状態に更新する。
	 * 失敗時は楽観的 online のまま。
	 */
	private async refreshConnectivity(): Promise<void> {
		try {
			const fresh = await NetInfo.refresh();
			this.handleNetChange(fresh);
		} catch {
			// 取得失敗 → 既存値のまま
		}
	}

	async stop(): Promise<void> {
		this.stopFlag = true;
		this.wake();
		this.netUnsub?.();
		this.netUnsub = null;
		this.settingsUnsub?.();
		this.settingsUnsub = null;
		this.appStateSub?.remove();
		this.appStateSub = null;
		if (this.loopPromise) await this.loopPromise.catch(() => {});
		this.running = false;
	}

	/** UI からの明示的な再同期要求。interval リセット + 即時 kick。 */
	kick(): void {
		this.intervalMs = MIN_INTERVAL_MS;
		this.forceSync = true;
		// 古い connectivity 値で「offline」分岐に入ったままだと、ユーザーが同期ボタンを
		// 押しても何も起きない。NetInfo を再取得 (非同期、wake は先に呼ぶ) して、
		// 次のループ判定までに最新状態を反映する。
		this.refreshConnectivity();
		this.wake();
	}

	private async runLoop(): Promise<void> {
		// 初回は interval を待たずに即実行する
		let skipInitialWait = true;
		while (!this.stopFlag) {
			if (!this.isActive()) {
				// オフラインまたは background: wake まで待つ
				syncEvents.emit('drive:status', { status: 'offline' });
				await Promise.race([this.wakeUp, sleep(30000)]);
				skipInitialWait = true; // 復帰後も即同期
				continue;
			}

			if (!skipInitialWait) {
				await Promise.race([this.wakeUp, sleep(this.intervalMs)]);
				if (this.stopFlag || !this.isActive()) continue;
			}
			skipInitialWait = false;

			try {
				const changed = await this.checkForChanges();
				// ローカルに pending な変更がある場合 (前回 session で push 途中終了 →
				// 再起動で resume したいケース等) は、cloud 側に変化が無くても sync を
				// 走らせる必要がある。Changes API は伝播ラグがあり、local dirty を見ないと
				// 数十秒〜数分待たされて UX が悪い。
				const localDirty = this.syncState.isDirty();
				// 初回 pull 中に kill された場合: cloud は変化していない (Changes API は false)、
				// localDirty も立たない (pull は dirty にしない) ので、明示的に「まだ初回 sync を
				// 完了していない」を判定軸にする。lastSyncedDriveTs が空文字なら、updateSyncedState
				// に到達したことが無い = 初回 sync 未完了。
				const neverSynced = this.syncState.lastSyncedDriveTs() === '';
				// foreground 復帰や UI kick() で立つフラグ。Changes API の伝播ラグを
				// 待たずに強制 sync する。フラグは消費したらクリア。
				const forced = this.forceSync;
				this.forceSync = false;
				if (forced || changed || localDirty || neverSynced) {
					await this.runSyncSafe();
					this.intervalMs = MIN_INTERVAL_MS;
				} else {
					this.intervalMs = Math.min(
						this.intervalMs * BACKOFF_FACTOR,
						MAX_INTERVAL_MS,
					);
				}
			} catch (e) {
				if (e instanceof AuthError) {
					await this.handleAuthError();
					continue;
				}
				console.warn('[Polling] cycle failed:', e);
				this.intervalMs = Math.min(
					this.intervalMs * BACKOFF_FACTOR,
					MAX_INTERVAL_MS,
				);
			}
		}
	}

	private async checkForChanges(): Promise<boolean> {
		if (!this.pageToken) {
			this.pageToken = await this.driveClient.getStartPageToken();
			await this.savePageToken();
			return true; // 初回は同期走らせる
		}
		const result = await this.driveClient.listChanges(this.pageToken);
		if (result.newStartPageToken) {
			this.pageToken = result.newStartPageToken;
			await this.savePageToken();
		}
		return result.changes.length > 0;
	}

	private async runSyncSafe(): Promise<void> {
		try {
			await this.orchestrator.syncNotes();
		} catch (e) {
			if (e instanceof AuthError) {
				await this.handleAuthError();
				return;
			}
			console.warn('[Polling] sync failed:', e);
		}
	}

	private async handleAuthError(): Promise<void> {
		syncEvents.emit('drive:disconnected', undefined);
		syncEvents.emit('drive:status', { status: 'offline' });
		// 再接続は上位の AuthService 側で token refresh されることを期待。
		// ここでは backoff 付きで 401 解消を待つ。
		let delay = RECONNECT_MIN_MS;
		while (!this.stopFlag && this.isActive()) {
			await sleep(Math.min(delay, RECONNECT_MAX_MS));
			delay = Math.min(delay * BACKOFF_FACTOR, RECONNECT_MAX_MS);
			try {
				await this.driveClient.getStartPageToken();
				this.driveSync.clearCache();
				syncEvents.emit('drive:reconnected', undefined);
				this.intervalMs = MIN_INTERVAL_MS;
				return;
			} catch (e) {
				if (e instanceof AuthError) continue;
				// それ以外のエラーも backoff
			}
		}
	}

	// ---- ネットワーク / AppState ----

	private handleNetChange(state: NetInfoState): void {
		this.netState = state;
		const next = this.resolveConnectivity(state);
		if (next !== this.connectivity) {
			this.connectivity = next;
			if (next === 'online') {
				syncEvents.emit('drive:reconnected', undefined);
				this.intervalMs = MIN_INTERVAL_MS;
				this.wake();
			} else {
				syncEvents.emit('drive:disconnected', undefined);
				syncEvents.emit('drive:status', { status: 'offline' });
			}
		}
	}

	private resolveConnectivity(state: NetInfoState): ConnectivityState {
		if (!state.isConnected) return 'offline';
		if (appSettings.snapshot().syncOnCellular) return 'online';
		if (isCellularOrExpensive(state)) return 'offline';
		return 'online';
	}

	private handleAppState(state: AppStateStatus): void {
		const wasActive = this.appState === 'active';
		this.appState = state;
		if (state === 'active' && !wasActive) {
			this.intervalMs = MIN_INTERVAL_MS;
			// foreground 復帰時は Changes API の伝播ラグを待たずに強制 sync する。
			this.forceSync = true;
			// バックグラウンド復帰時の NetInfo state は古いことがあるので、明示的に
			// refresh して最新の接続状態に揃える。
			this.refreshConnectivity();
			this.wake();
		}
	}

	private isActive(): boolean {
		return this.connectivity === 'online' && this.appState === 'active';
	}

	private resetWake(): void {
		this.wakeUp = new Promise<void>((resolve) => {
			this.notify = resolve;
		});
	}

	private wake(): void {
		const n = this.notify;
		this.resetWake();
		n?.();
	}

	private async loadPageToken(): Promise<void> {
		const raw = await readString(CHANGE_PAGE_TOKEN_PATH);
		if (!raw) return;
		try {
			const parsed = JSON.parse(raw) as { token: string };
			this.pageToken = parsed.token;
		} catch {
			this.pageToken = null;
		}
	}

	private async savePageToken(): Promise<void> {
		if (!this.pageToken) return;
		await writeAtomic(
			CHANGE_PAGE_TOKEN_PATH,
			JSON.stringify({ token: this.pageToken }),
		);
	}
}

function isCellularOrExpensive(state: NetInfoState): boolean {
	const details = state.details as { isConnectionExpensive?: boolean } | null;
	return state.type === 'cellular' || details?.isConnectionExpensive === true;
}
