import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { AppState, type AppStateStatus } from 'react-native';
import { readString, writeAtomic } from '../storage/atomicFile';
import { CHANGE_PAGE_TOKEN_PATH } from '../storage/paths';
import type { DriveClient } from './driveClient';
import type { DriveSyncService } from './driveSyncService';
import { syncEvents } from './events';
import type { SyncOrchestrator } from './orchestrator';
import { AuthError, sleep } from './retry';

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
	private connectivity: ConnectivityState = 'offline';
	private appState: AppStateStatus = 'active';
	private netUnsub: (() => void) | null = null;
	private appStateSub: { remove: () => void } | null = null;
	private wakeUp: Promise<void> = Promise.resolve();
	private notify: (() => void) | null = null;
	private loopPromise: Promise<void> | null = null;

	constructor(
		private readonly driveClient: DriveClient,
		private readonly driveSync: DriveSyncService,
		private readonly orchestrator: SyncOrchestrator,
	) {
		this.resetWake();
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.stopFlag = false;
		await this.loadPageToken();

		this.netUnsub = NetInfo.addEventListener((s) => this.handleNetChange(s));
		const initial = await NetInfo.fetch();
		this.connectivity = initial.isConnected ? 'online' : 'offline';

		this.appStateSub = AppState.addEventListener('change', (s) => this.handleAppState(s));
		this.appState = AppState.currentState;

		// 初回同期を先に実行してから loop に入る
		if (this.isActive()) {
			await this.runSyncSafe();
		}
		this.loopPromise = this.runLoop();
	}

	async stop(): Promise<void> {
		this.stopFlag = true;
		this.wake();
		this.netUnsub?.();
		this.netUnsub = null;
		this.appStateSub?.remove();
		this.appStateSub = null;
		if (this.loopPromise) await this.loopPromise.catch(() => {});
		this.running = false;
	}

	/** UI からの明示的な再同期要求。interval リセット + 即時 kick。 */
	kick(): void {
		this.intervalMs = MIN_INTERVAL_MS;
		this.wake();
	}

	private async runLoop(): Promise<void> {
		while (!this.stopFlag) {
			if (!this.isActive()) {
				// オフラインまたは background: wake まで待つ
				syncEvents.emit('drive:status', { status: 'offline' });
				await Promise.race([this.wakeUp, sleep(30000)]);
				continue;
			}

			await Promise.race([this.wakeUp, sleep(this.intervalMs)]);
			if (this.stopFlag || !this.isActive()) continue;

			try {
				const changed = await this.checkForChanges();
				if (changed) {
					await this.runSyncSafe();
					this.intervalMs = MIN_INTERVAL_MS;
				} else {
					this.intervalMs = Math.min(this.intervalMs * BACKOFF_FACTOR, MAX_INTERVAL_MS);
				}
			} catch (e) {
				if (e instanceof AuthError) {
					await this.handleAuthError();
					continue;
				}
				console.warn('[Polling] cycle failed:', e);
				this.intervalMs = Math.min(this.intervalMs * BACKOFF_FACTOR, MAX_INTERVAL_MS);
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
		const next: ConnectivityState = state.isConnected ? 'online' : 'offline';
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

	private handleAppState(state: AppStateStatus): void {
		const wasActive = this.appState === 'active';
		this.appState = state;
		if (state === 'active' && !wasActive) {
			this.intervalMs = MIN_INTERVAL_MS;
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
		await writeAtomic(CHANGE_PAGE_TOKEN_PATH, JSON.stringify({ token: this.pageToken }));
	}
}
